// `@prometheon/hub-worker` — publicador do outbox e filas do Hub (`Docs/08`).
//
// O processo em si entra por `server.ts`. Este índice existe para quem precisa
// das peças: a API, que vai enfileirar jobs com as mesmas políticas, e os
// testes, que montam o runtime apontando para um banco descartável.

export { loadWorkerSettings, type WorkerSettings } from './config.js';
export { createWorkerRuntime, type WorkerRuntime } from './worker.js';
export { createKeyNamespace, type KeyNamespace } from './keys.js';
export { MetricsRegistry, METRIC, renderPrometheus } from './metrics.js';
export { backoffDelay, nextAttemptAt } from './backoff.js';
export { RedisLocker, type Lock } from './lock.js';
export {
  PermanentJobError,
  TransientJobError,
  JobTimeoutError,
  isPermanentError,
} from './errors.js';
export {
  buildRedisOptions,
  createRedisConnection,
  closeRedis,
  resolveRedisEndpoint,
  type RedisConnection,
} from './redis.js';
export { HealthServer, type HealthReport, type WorkerState } from './health.js';

export {
  OutboxPublisher,
  DEAD_LETTER_PREFIX,
  type OutboxBatchResult,
  type OutboxLag,
} from './outbox/publisher.js';
export { toEnvelope, type OutboxEnvelope, type OutboxRecord } from './outbox/envelope.js';

export {
  QUEUE_NAMES,
  QUEUE_POLICIES,
  DEAD_LETTER_QUEUE,
  queuePolicy,
  type QueueName,
  type QueuePolicy,
} from './queues/definitions.js';
export {
  createQueues,
  createDeadLetterSink,
  defaultJobOptions,
  deterministicJobId,
  enqueue,
  startWorkers,
  closeQueues,
  closeWorkers,
  type QueueRegistry,
  type WorkerRegistry,
} from './queues/manager.js';
export type { JobDeps } from './queues/deps.js';
export type { JobHandler, JobContext, JobOutcome, DeadLetterSink } from './queues/runtime.js';
export * from './queues/payloads.js';
export { runRetention, type RetentionReport } from './queues/processors/retention.js';
export { runDeletion, type DeletionOutcome } from './queues/processors/deletions.js';
export { runExport, type ExportOutcome } from './queues/processors/exports.js';
export {
  listDeadLetters,
  countDeadLetters,
  recordDeadLetter,
} from './queues/processors/dead-letter.js';
