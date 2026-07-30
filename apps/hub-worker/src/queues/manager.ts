// Montagem das filas e dos workers BullMQ.
//
// Três decisões que valem para as oito filas:
//
// - **uma conexão bloqueante por worker.** O BullMQ fica em comando bloqueante
//   esperando job; compartilhar essa conexão com os comandos comuns faria um
//   `SET` esperar a chegada do próximo job.
// - **backoff próprio.** O `exponential` embutido do BullMQ não tem jitter, e o
//   `Docs/08` pede jitter. Registramos a estratégia com o nome
//   `exponential-jitter` e cada worker fecha sobre a política da sua fila.
// - **`lockDuration` maior que o timeout do job.** Se o lock vencer antes, o
//   BullMQ considera o job travado e o entrega a outro worker enquanto o
//   primeiro ainda está trabalhando — a duplicata que a idempotência teria de
//   absorver sem necessidade.

import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';

import type { Logger } from '@prometheon/logger';

import { backoffDelay } from '../backoff.js';
import type { KeyNamespace } from '../keys.js';
import { METRIC, type MetricsRegistry } from '../metrics.js';
import { BACKOFF_STRATEGY, QUEUE_NAMES, queuePolicy, type QueueName } from './definitions.js';
import type { JobDeps } from './deps.js';
import type { DeadLetterJob } from './payloads.js';
import { contextSummarizationHandler } from './processors/context-summarization.js';
import { deadLetterHandler } from './processors/dead-letter.js';
import { deletionsHandler } from './processors/deletions.js';
import { exportsHandler } from './processors/exports.js';
import { knowledgeIndexingHandler } from './processors/knowledge-indexing.js';
import { notificationsHandler } from './processors/notifications.js';
import { retentionHandler } from './processors/retention.js';
import { webhooksHandler } from './processors/webhooks.js';
import { createProcessor, type DeadLetterSink, type JobHandler } from './runtime.js';

export type QueueRegistry = Readonly<Record<QueueName, Queue>>;

/**
 * Handler de cada fila. O tipo do schema varia entre elas, e o envelope já
 * fecha a validação — por isso a tabela é anotada com o handler genérico.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HANDLERS: Readonly<Record<QueueName, JobHandler<any>>> = {
  webhooks: webhooksHandler,
  notifications: notificationsHandler,
  'context-summarization': contextSummarizationHandler,
  'knowledge-indexing': knowledgeIndexingHandler,
  retention: retentionHandler,
  exports: exportsHandler,
  deletions: deletionsHandler,
  'dead-letter': deadLetterHandler,
};

/** Opções padrão de job de uma fila, derivadas da política. */
export function defaultJobOptions(queue: QueueName): JobsOptions {
  const policy = queuePolicy(queue);
  return {
    attempts: policy.attempts,
    backoff: { type: BACKOFF_STRATEGY, delay: policy.backoffBaseMs },
    removeOnComplete: { count: policy.keepCompleted },
    removeOnFail: { count: policy.keepFailed },
  };
}

export interface CreateQueuesOptions {
  readonly connection: ConnectionOptions;
  readonly keys: KeyNamespace;
}

/** Cria as oito filas com as opções padrão já aplicadas. */
export function createQueues(options: CreateQueuesOptions): QueueRegistry {
  const registry = {} as Record<QueueName, Queue>;
  for (const name of QUEUE_NAMES) {
    registry[name] = new Queue(name, {
      connection: options.connection,
      prefix: options.keys.bull,
      defaultJobOptions: defaultJobOptions(name),
    });
  }
  return registry;
}

/** Sink que empurra o registro para a fila `dead-letter`. */
export function createDeadLetterSink(queues: QueueRegistry): DeadLetterSink {
  return {
    async record(entry: DeadLetterJob): Promise<void> {
      await queues['dead-letter'].add('record', entry, {
        // Determinístico: reprocessar o mesmo abandono não empilha registro.
        jobId: deterministicJobId(entry.source, entry.origin, entry.originId),
      });
    },
  };
}

export interface StartWorkersOptions {
  readonly deps: JobDeps;
  readonly keys: KeyNamespace;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  /** Fábrica de conexão: cada worker recebe a sua. */
  readonly connectionFor: (queue: QueueName) => ConnectionOptions;
  readonly concurrency: Readonly<Record<QueueName, number>>;
  readonly signal: AbortSignal;
  /** Filas a subir; o padrão são todas. Existe para o teste isolar uma. */
  readonly only?: readonly QueueName[] | undefined;
  /**
   * Substitui o processador de uma fila. Existe para o teste exercitar o
   * envelope (timeout, encerramento gracioso, classificação de falha) sem
   * depender do efeito real do processador de produção.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handlers?: Partial<Record<QueueName, JobHandler<any>>> | undefined;
}

export type WorkerRegistry = ReadonlyMap<QueueName, Worker>;

/** Sobe um worker por fila, já instrumentado. */
export function startWorkers(options: StartWorkersOptions): WorkerRegistry {
  const workers = new Map<QueueName, Worker>();
  const names = options.only ?? QUEUE_NAMES;

  for (const name of names) {
    const policy = queuePolicy(name);
    const handler = options.handlers?.[name] ?? HANDLERS[name];
    const processor = createProcessor(handler, {
      deps: options.deps,
      signal: options.signal,
    });

    const worker = new Worker(name, processor, {
      connection: options.connectionFor(name),
      prefix: options.keys.bull,
      concurrency: options.concurrency[name],
      // Margem sobre o timeout do job: o lock nunca vence antes do trabalho.
      lockDuration: policy.timeoutMs + 30_000,
      settings: {
        backoffStrategy: (attemptsMade: number): number =>
          backoffDelay(Math.max(1, attemptsMade), {
            baseMs: policy.backoffBaseMs,
            maxMs: policy.backoffMaxMs,
          }),
      },
    });

    worker.on('error', (error) => {
      options.metrics.increment(METRIC.redisErrorsTotal, { queue: name });
      options.logger.error({ err: error, queue: name }, 'erro no worker da fila');
    });

    worker.on('stalled', (jobId: string) => {
      // Job travado voltou para a fila: alguém precisa saber, porque isso
      // significa execução duplicada em potencial.
      options.logger.warn({ queue: name, jobId }, 'job estagnado; devolvido à fila');
    });

    workers.set(name, worker);
  }

  return workers;
}

/**
 * Fecha os workers esperando o que está em voo. `close(false)` é deliberado: o
 * modo forçado abandona jobs ativos, que é exatamente o "job preso" que o
 * encerramento gracioso existe para evitar.
 */
export async function closeWorkers(workers: WorkerRegistry): Promise<void> {
  await Promise.all([...workers.values()].map(async (worker) => worker.close(false)));
}

export async function closeQueues(queues: QueueRegistry): Promise<void> {
  await Promise.all(Object.values(queues).map(async (queue) => queue.close()));
}

/**
 * `jobId` determinístico a partir das partes que identificam o trabalho.
 *
 * O BullMQ **recusa** `:` em identificador de job — ele já usa dois-pontos para
 * montar as próprias chaves. Como a convenção de ID do projeto é ULID e o
 * natural seria escrever `export:01J...`, esta função existe para não deixar
 * quem enfileira descobrir isso por exceção em produção.
 */
export function deterministicJobId(...parts: readonly string[]): string {
  return parts
    .map((part) => part.replace(/[:\s]+/g, '-'))
    .filter((part) => part !== '')
    .join('-');
}

/** Enfileira respeitando a política da fila. `jobId` determinístico quando dado. */
export async function enqueue(
  queue: Queue,
  name: string,
  data: unknown,
  options: JobsOptions = {},
): Promise<Job> {
  return queue.add(name, data, options);
}
