// Composição do worker: quem cria o quê, em que ordem, e como tudo isso morre.
//
// A ordem da subida importa menos que a da descida. O encerramento gracioso do
// `Docs/11` é uma sequência, não um `process.exit()`:
//
// 1. **readiness cai primeiro.** O orquestrador precisa parar de contar com
//    este processo antes de ele começar a fechar coisas.
// 2. **o publicador do outbox para no fim do lote corrente.** Interromper no
//    meio deixaria evento publicado e não marcado — republicação garantida.
// 3. **os workers fecham esperando o que está em voo** (`close(false)`). É a
//    diferença entre "job termina" e "job preso em `active` até o `stalled`
//    devolvê-lo".
// 4. **filas, Redis e pool do MySQL fecham por último**, quando ninguém mais
//    precisa deles.
//
// Se a sequência passar do teto configurado, o processo sai assim mesmo — um
// encerramento que nunca termina é tão ruim quanto um abrupto.

import { createDatabase, type Database } from '@prometheon/database';
import { configureRootLogger, type Logger } from '@prometheon/logger';
import type { Pool } from 'mysql2/promise';

import { loadWorkerSettings, type WorkerSettings } from './config.js';
import { HealthServer } from './health.js';
import { createKeyNamespace, type KeyNamespace } from './keys.js';
import { RedisLocker } from './lock.js';
import { METRIC, MetricsRegistry } from './metrics.js';
import { OutboxPublisher } from './outbox/publisher.js';
import { buildRedisOptions, closeRedis, createRedisConnection, type RedisConnection } from './redis.js';
import type { QueueName } from './queues/definitions.js';
import type { JobDeps } from './queues/deps.js';
import type { JobHandler } from './queues/runtime.js';
import {
  closeQueues,
  closeWorkers,
  createDeadLetterSink,
  createQueues,
  startWorkers,
  type QueueRegistry,
  type WorkerRegistry,
} from './queues/manager.js';

export interface CreateWorkerOptions {
  readonly settings?: WorkerSettings | undefined;
  readonly logger?: Logger | undefined;
  /** Banco já aberto; existe para o teste apontar para um banco descartável. */
  readonly database?: { readonly db: Database; readonly pool: Pool } | undefined;
  /** Sobe só estas filas. Existe para o teste isolar uma. */
  readonly onlyQueues?: readonly QueueName[] | undefined;
  /** Substitui o processador de uma fila. Existe para o teste. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handlers?: Partial<Record<QueueName, JobHandler<any>>> | undefined;
}

export interface WorkerRuntime {
  readonly settings: WorkerSettings;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly keys: KeyNamespace;
  readonly deps: JobDeps;
  readonly queues: QueueRegistry;
  readonly workers: WorkerRegistry;
  readonly publisher: OutboxPublisher;
  readonly health: HealthServer;
  start(): Promise<void>;
  /** Encerramento gracioso; idempotente. */
  shutdown(reason: string): Promise<void>;
}

export function createWorkerRuntime(options: CreateWorkerOptions = {}): WorkerRuntime {
  const settings = options.settings ?? loadWorkerSettings();
  const logger =
    options.logger ??
    configureRootLogger({
      env: settings.app.env,
      level: settings.app.logLevel,
      name: 'hub-worker',
      base: { instanceId: settings.instanceId },
    });

  const metrics = new MetricsRegistry();
  const keys = createKeyNamespace(settings.app.redis.keyPrefix);

  const database =
    options.database ??
    createDatabase({
      host: settings.app.database.host,
      port: settings.app.database.port,
      user: settings.app.database.user,
      password: settings.app.database.password,
      database: settings.app.database.name,
      connectionLimit: 10,
    });
  const ownsDatabase = options.database === undefined;

  // Conexão de comandos: locks, marcas de idempotência, publicação, health.
  // Nunca a mesma que o BullMQ bloqueia.
  const commands: RedisConnection = createRedisConnection(settings.app.redis, {
    role: 'commands',
  });
  commands.on('error', (error: Error) => {
    metrics.increment(METRIC.redisErrorsTotal, { role: 'commands' });
    logger.error({ err: error }, 'erro na conexão Redis de comandos');
  });

  const queues = createQueues({
    connection: buildRedisOptions(settings.app.redis, { blocking: true, role: 'queues' }),
    keys,
  });

  const deps: JobDeps = {
    db: database.db,
    redis: commands,
    keys,
    metrics,
    logger,
    settings,
    deadLetter: createDeadLetterSink(queues),
  };

  const abort = new AbortController();

  const publisher = new OutboxPublisher({
    db: database.db,
    locker: new RedisLocker(commands),
    keys,
    logger: logger.child({ module: 'outbox' }),
    metrics,
    publish: async (channel, payload) => commands.publish(channel, payload),
    onDeadLetter: async (record) => {
      await deps.deadLetter.record({
        correlationId: record.messageId,
        source: 'outbox',
        origin: 'outbox',
        originId: record.messageId,
        jobName: record.eventType,
        attemptsMade: record.attempts,
        // Esgotou tentativas; não foi rejeição definitiva do broker.
        permanent: false,
        errorCode: 'OUTBOX_PUBLISH_FAILED',
        errorMessage: record.reason.slice(0, 4_000),
        failedAt: new Date().toISOString(),
        payload: {
          organizationId: record.organizationId,
          eventType: record.eventType,
          aggregateType: record.aggregateType,
          aggregateId: record.aggregateId,
        },
      });
    },
    batchSize: settings.outbox.batchSize,
    pollIntervalMs: settings.outbox.pollIntervalMs,
    idlePollIntervalMs: settings.outbox.idlePollIntervalMs,
    lockTtlMs: settings.outbox.lockTtlMs,
    maxAttempts: settings.outbox.maxAttempts,
    backoffBaseMs: settings.outbox.backoffBaseMs,
    backoffMaxMs: settings.outbox.backoffMaxMs,
    lagSampleIntervalMs: settings.outbox.lagSampleIntervalMs,
  });

  const health = new HealthServer({
    settings: settings.health,
    db: database.db,
    redis: commands,
    metrics,
    logger: logger.child({ module: 'health' }),
    instanceId: settings.instanceId,
    outboxLag: () => ({
      pending: publisher.lastLag.pending,
      lagMs: publisher.lastLag.lagMs,
    }),
  });

  let workers: WorkerRegistry = new Map();
  let shuttingDown: Promise<void> | undefined;

  return {
    settings,
    logger,
    metrics,
    keys,
    deps,
    queues,
    get workers(): WorkerRegistry {
      return workers;
    },
    publisher,
    health,

    async start(): Promise<void> {
      await health.start();

      if (settings.queuesEnabled) {
        workers = startWorkers({
          deps,
          keys,
          logger,
          metrics,
          connectionFor: (queue) =>
            buildRedisOptions(settings.app.redis, { blocking: true, role: queue }),
          concurrency: settings.concurrency,
          signal: abort.signal,
          only: options.onlyQueues,
          handlers: options.handlers,
        });
      }

      if (settings.outboxEnabled) {
        // Uma amostragem antes de declarar pronto: o atraso já sobe correto.
        await publisher.sampleLag().catch(() => undefined);
        publisher.start();
      }

      await health.setState('ready');
      logger.info(
        {
          outbox: settings.outboxEnabled,
          queues: settings.queuesEnabled ? [...workers.keys()] : [],
          concurrency: settings.concurrency,
        },
        'worker pronto',
      );
    },

    async shutdown(reason: string): Promise<void> {
      shuttingDown ??= (async (): Promise<void> => {
        logger.info({ reason }, 'encerrando');
        await health.setState('draining');
        abort.abort();

        const sequence = (async (): Promise<void> => {
          await publisher.stop();
          await closeWorkers(workers);
          await closeQueues(queues);
          await closeRedis(commands);
          if (ownsDatabase) {
            await database.pool.end();
          }
        })();

        const timeout = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn(
              { timeoutMs: settings.shutdownTimeoutMs },
              'encerramento excedeu o teto; saindo assim mesmo',
            );
            resolve();
          }, settings.shutdownTimeoutMs);
          timer.unref();
        });

        await Promise.race([sequence, timeout]);
        await health.setState('stopped');
        await health.stop();
        logger.info('encerrado');
      })();

      await shuttingDown;
    },
  };
}
