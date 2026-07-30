// O worker inteiro, subindo de verdade contra MySQL e Redis.
//
// É o teste que responde às perguntas que nenhuma peça isolada responde:
//
// - um evento gravado no outbox chega mesmo ao assinante, com o laço rodando?
// - o health diz "pronto" quando está pronto, e para de dizer no encerramento?
// - o encerramento gracioso espera o job em voo, ou o deixa preso?

import { afterEach, describe, expect, it } from 'vitest';

import { enqueueOutboxMessage, newId, projects } from '@prometheon/database';
import { createLogger } from '@prometheon/logger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { OutboxEnvelope } from './outbox/envelope.js';
import { jobEnvelopeSchema } from './queues/payloads.js';
import type { JobHandler } from './queues/runtime.js';
import { closeRedis, createRedisConnection, type RedisConnection } from './redis.js';
import {
  cleanupKeyPrefix,
  createDisposableDatabase,
  disposableSettings,
  probeMysql,
  probeRedis,
  probeSettings,
  seedFixtures,
  type DisposableDatabase,
} from './testing/support.js';
import { createWorkerRuntime, type WorkerRuntime } from './worker.js';

const settingsProbe = probeSettings();
const mysqlProbe = await probeMysql();
const redisProbe = settingsProbe.settings === undefined
  ? { reachable: false, reason: settingsProbe.reason }
  : await probeRedis();

const unavailable = !mysqlProbe.reachable || !redisProbe.reachable;
if (unavailable) {
  console.warn(
    '[worker] suíte pulada — ' +
      `mysql: ${mysqlProbe.reachable ? 'ok' : (mysqlProbe.reason ?? 'inacessível')}; ` +
      `redis: ${redisProbe.reachable ? 'ok' : (redisProbe.reason ?? 'inacessível')}`,
  );
}

const logger = createLogger({ level: 'silent', name: 'worker-test' });

describe.skipIf(unavailable)('runtime do worker', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    // Cada teste registra a própria limpeza; ordem inversa da criação.
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.().catch(() => undefined);
    }
  }, 120_000);

  async function bootstrap(label: string): Promise<{
    temporary: DisposableDatabase;
    disposable: ReturnType<typeof disposableSettings>;
  }> {
    const base = settingsProbe.settings;
    if (base === undefined) {
      throw new Error(settingsProbe.reason ?? 'configuração indisponível');
    }
    const temporary = await createDisposableDatabase(`prometheon_worker_${label}`);
    const disposable = disposableSettings(label, base);
    cleanups.push(async () => {
      await disposable.cleanup();
      await temporary.drop();
    });
    return { temporary, disposable };
  }

  it('leva um evento do outbox até um assinante, com o laço de verdade rodando', async () => {
    const { temporary, disposable } = await bootstrap('e2e');
    const settings = {
      ...disposable.settings,
      outboxEnabled: true,
      // Porta zero: o sistema escolhe uma livre e o teste descobre depois.
      health: { enabled: true, host: '127.0.0.1', port: 0, filePath: undefined },
    };

    const runtime: WorkerRuntime = createWorkerRuntime({
      settings,
      database: { db: temporary.db, pool: temporary.pool },
      logger,
      onlyQueues: ['dead-letter'],
    });

    const subscriber: RedisConnection = createRedisConnection(settings.app.redis, {
      role: 'test-subscriber',
    });
    const received: OutboxEnvelope[] = [];
    subscriber.on('pmessage', (_pattern: string, _channel: string, payload: string) => {
      received.push(JSON.parse(payload) as OutboxEnvelope);
    });
    await subscriber.psubscribe(disposable.keys.realtimeChannelPattern);

    cleanups.push(async () => {
      await subscriber.punsubscribe(disposable.keys.realtimeChannelPattern).catch(() => undefined);
      await cleanupKeyPrefix(runtime.deps.redis, disposable.keys).catch(() => undefined);
      await closeRedis(subscriber);
      await runtime.shutdown('fim do teste');
    });

    await runtime.start();

    // Readiness só responde 200 quando MySQL e Redis respondem.
    const port = runtime.health.port;
    expect(port).toBeDefined();
    const ready = await fetch(`http://127.0.0.1:${String(port)}/ready`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { state: string }).state).toBe('ready');

    const organizationId = newId();
    const eventId = await enqueueOutboxMessage(temporary.db, {
      organizationId,
      aggregateType: 'task',
      aggregateId: newId(),
      eventType: 'task.created',
      payload: { hello: 'world' },
    });
    runtime.publisher.notify();

    const deadline = Date.now() + 10_000;
    while (!received.some((event) => event.id === eventId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const delivered = received.find((event) => event.id === eventId);
    expect(delivered).toBeDefined();
    expect(delivered?.organizationId).toBe(organizationId);
    expect(delivered?.type).toBe('task.created');
    expect(delivered?.data).toEqual({ hello: 'world' });
    // O `cursor` é o próprio ID: é assim que o consumidor retoma e deduplica.
    expect(delivered?.cursor).toBe(eventId);

    // As métricas do `Docs/11` refletem o que aconteceu. O contador sobe
    // depois da marcação no banco, que por sua vez vem depois da publicação —
    // então o assinante pode chegar aqui um passo à frente do worker.
    const metricDeadline = Date.now() + 5_000;
    while (
      runtime.metrics.counterValue('outbox_published_total', { eventType: 'task.created' }) === 0 &&
      Date.now() < metricDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      runtime.metrics.counterValue('outbox_published_total', { eventType: 'task.created' }),
    ).toBeGreaterThanOrEqual(1);

    const metricsResponse = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(await metricsResponse.text()).toContain('sync_outbox_pending');
  }, 120_000);

  it('espera o job em voo antes de encerrar', async () => {
    const { temporary, disposable } = await bootstrap('drain');
    const fixtures = await seedFixtures(temporary.db);

    const marker = `drain-${newId().slice(-8).toLowerCase()}`;
    let startedAt = 0;
    let finishedAt = 0;

    // Handler lento de propósito: o encerramento começa com ele no meio.
    const slowHandler: JobHandler<typeof jobEnvelopeSchema> = {
      queue: 'retention',
      schema: jobEnvelopeSchema,
      async run({ deps }) {
        startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // O efeito só acontece no fim: se o encerramento tivesse abandonado o
        // job, este projeto não existiria.
        await deps.db.insert(projects).values({
          id: newId(),
          organizationId: fixtures.organizationId,
          slug: marker,
          name: marker,
        });
        finishedAt = Date.now();
        return { status: 'done' };
      },
    };

    const runtime = createWorkerRuntime({
      settings: disposable.settings,
      database: { db: temporary.db, pool: temporary.pool },
      logger,
      onlyQueues: ['retention'],
      handlers: { retention: slowHandler },
    });

    cleanups.push(async () => {
      await cleanupKeyPrefix(runtime.deps.redis, disposable.keys).catch(() => undefined);
      await runtime.shutdown('fim do teste');
    });

    await runtime.start();
    await runtime.queues.retention.add(
      'retention',
      { correlationId: marker },
      { jobId: `drain-${marker}` },
    );

    // Espera o job entrar em execução para que o encerramento o pegue em voo.
    const deadline = Date.now() + 15_000;
    while (startedAt === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(startedAt).toBeGreaterThan(0);

    const shutdownStartedAt = Date.now();
    await runtime.shutdown('SIGTERM');
    const shutdownEndedAt = Date.now();

    // O job terminou, e terminou ANTES de o encerramento devolver o controle.
    expect(finishedAt).toBeGreaterThan(0);
    expect(shutdownEndedAt).toBeGreaterThanOrEqual(finishedAt);
    expect(shutdownEndedAt - shutdownStartedAt).toBeGreaterThan(200);

    const [row] = await temporary.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, marker))
      .limit(1);
    expect(row?.id).toBeDefined();

    expect(runtime.health.state).toBe('stopped');
  }, 120_000);

  it('classifica payload inválido como falha permanente', async () => {
    const { temporary, disposable } = await bootstrap('invalid');

    const strictHandler: JobHandler<z.ZodObject<{ correlationId: z.ZodString }>> = {
      queue: 'retention',
      schema: z.object({ correlationId: z.string() }),
      run() {
        throw new Error('o processador não deveria ter sido chamado');
      },
    };

    const runtime = createWorkerRuntime({
      settings: disposable.settings,
      database: { db: temporary.db, pool: temporary.pool },
      logger,
      onlyQueues: ['retention', 'dead-letter'],
      handlers: { retention: strictHandler },
    });

    cleanups.push(async () => {
      await cleanupKeyPrefix(runtime.deps.redis, disposable.keys).catch(() => undefined);
      await runtime.shutdown('fim do teste');
    });

    await runtime.start();

    const jobId = `invalid-${newId().slice(-8).toLowerCase()}`;
    await runtime.queues.retention.add('retention', { nada: true }, { jobId });

    const deadline = Date.now() + 20_000;
    let state = 'unknown';
    while (state !== 'failed' && Date.now() < deadline) {
      const job = await runtime.queues.retention.getJob(jobId);
      state = job === undefined ? 'unknown' : await job.getState();
      if (state !== 'failed') {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    expect(state).toBe('failed');
    const job = await runtime.queues.retention.getJob(jobId);
    // Corpo malformado não ganha segunda chance.
    expect(job?.attemptsMade).toBe(1);
    expect(job?.failedReason).toContain('Payload inválido');
  }, 120_000);
});
