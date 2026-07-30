// Envelope de execução dos jobs.
//
// Tudo que o `Docs/08` exige de "todo job" e que não cabe na tabela de
// políticas mora aqui, aplicado uma vez só para as oito filas:
//
// - **validação de payload** na entrada — fila é fronteira, e fronteira valida
//   em runtime (`Docs/03`); corpo inválido é falha permanente;
// - **correlação**: `correlationId` e `jobId` entram no contexto de log
//   assíncrono, então toda linha emitida lá dentro sai carimbada (`Docs/11`);
// - **idempotência entre execuções**: o `jobId` do BullMQ protege enquanto o
//   job existe na fila; depois que ele é removido, quem protege é a marca no
//   Redis gravada após o sucesso;
// - **timeout**: job travado não pode ocupar um slot de concorrência para
//   sempre;
// - **classificação da falha**: permanente vai direto para a dead-letter,
//   transitória volta para a retentativa até esgotar as tentativas da fila;
// - **métricas**: espera na fila, duração, processados, falhos, abandonados.

import { runWithLogContext, type Logger } from '@prometheon/logger';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { errorCode, errorMessage, isPermanentError, JobTimeoutError, PermanentJobError } from '../errors.js';
import { METRIC } from '../metrics.js';
import { queuePolicy, type QueueName } from './definitions.js';
import type { DeadLetterJob } from './payloads.js';
import type { JobDeps } from './deps.js';

/** Para onde vai o que falhou de forma definitiva. */
export interface DeadLetterSink {
  record(entry: DeadLetterJob): Promise<void>;
}

export interface JobContext<T> {
  readonly queue: QueueName;
  readonly job: Job;
  readonly data: T;
  readonly correlationId: string;
  /** Número desta tentativa, começando em 1. */
  readonly attempt: number;
  readonly logger: Logger;
  readonly deps: JobDeps;
  /** Abortado no encerramento gracioso: trabalho longo deve checá-lo. */
  readonly signal: AbortSignal;
}

export type JobStatus = 'done' | 'skipped' | 'pending-api';

export interface JobOutcome {
  readonly status: JobStatus;
  /** Detalhe já redigido, guardado no resultado do job para inspeção. */
  readonly details?: Record<string, unknown> | undefined;
}

export interface JobHandler<S extends z.ZodType> {
  readonly queue: QueueName;
  readonly schema: S;
  /**
   * Chave de idempotência derivada do payload. Sem isto vale o `jobId`, que já
   * deve ser determinístico para os jobs idempotentes.
   */
  idempotencyKey?(data: z.output<S>, job: Job): string | undefined;
  run(context: JobContext<z.output<S>>): Promise<JobOutcome>;
}

/** Número desta tentativa. BullMQ conta de formas diferentes nos dois campos. */
export function currentAttempt(job: Job): number {
  const started = job.attemptsStarted;
  if (typeof started === 'number' && started > 0) {
    return started;
  }
  return job.attemptsMade + 1;
}

/** Corre contra o relógio; o vencedor decide o destino do job. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  queue: QueueName,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new JobTimeoutError(queue, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface CreateProcessorOptions {
  readonly deps: JobDeps;
  /** Sinal compartilhado do processo, abortado no encerramento. */
  readonly signal: AbortSignal;
}

/**
 * Embrulha o handler no envelope. O retorno é o que o BullMQ chama por job.
 */
export function createProcessor<S extends z.ZodType>(
  handler: JobHandler<S>,
  options: CreateProcessorOptions,
): (job: Job) => Promise<JobOutcome> {
  const { deps, signal } = options;
  const policy = queuePolicy(handler.queue);
  const queueLabel = { queue: handler.queue };

  return async function process(job: Job): Promise<JobOutcome> {
    const startedAt = Date.now();
    const attempt = currentAttempt(job);
    const jobId = job.id ?? 'unknown';

    // Espera na fila: enfileirado quando, começou quando (`Docs/11`).
    deps.metrics.observe(METRIC.queueWaitDuration, Math.max(0, startedAt - job.timestamp), queueLabel);
    deps.metrics.increment(METRIC.jobsActive, queueLabel);

    const parsed = handler.schema.safeParse(job.data);
    const correlationId =
      (parsed.success ? readCorrelationId(parsed.data) : undefined) ?? jobId;

    const logger = deps.logger.child({ queue: handler.queue, jobId, correlationId, attempt });

    const logContext = {
      correlationId,
      operation: `job:${handler.queue}`,
      ...(parsed.success ? readScope(parsed.data) : {}),
    };

    return await runWithLogContext(logContext, async () => {
      try {
        if (!parsed.success) {
          // Corpo malformado não melhora na segunda tentativa.
          throw new PermanentJobError(`Payload inválido para a fila "${handler.queue}".`, {
            code: 'JOB_PAYLOAD_INVALID',
            details: { issues: z.treeifyError(parsed.error) },
          });
        }

        const data = parsed.data;
        const idempotencyKey = policy.idempotent
          ? (handler.idempotencyKey?.(data, job) ?? jobId)
          : undefined;

        if (idempotencyKey !== undefined) {
          const doneKey = deps.keys.jobDone(handler.queue, idempotencyKey);
          const alreadyDone = await deps.redis.get(doneKey);
          if (alreadyDone !== null) {
            deps.metrics.increment(METRIC.jobsSkippedTotal, queueLabel);
            logger.info({ idempotencyKey }, 'job já processado; execução pulada');
            return { status: 'skipped', details: { idempotencyKey, previousRunAt: alreadyDone } };
          }
        }

        const outcome = await withTimeout(
          handler.run({
            queue: handler.queue,
            job,
            data,
            correlationId,
            attempt,
            logger,
            deps,
            signal,
          }),
          policy.timeoutMs,
          handler.queue,
        );

        if (idempotencyKey !== undefined && outcome.status !== 'skipped') {
          await deps.redis.set(
            deps.keys.jobDone(handler.queue, idempotencyKey),
            new Date().toISOString(),
            'PX',
            policy.idempotencyTtlMs,
          );
        }

        deps.metrics.increment(METRIC.jobsProcessedTotal, {
          ...queueLabel,
          status: outcome.status,
        });
        logger.info({ status: outcome.status, ...outcome.details }, 'job concluído');
        return outcome;
      } catch (error) {
        await handleFailure({
          deps,
          logger,
          queue: handler.queue,
          job,
          attempt,
          correlationId,
          error,
        });
        throw error;
      } finally {
        deps.metrics.observe(METRIC.jobDuration, Date.now() - startedAt, queueLabel);
        deps.metrics.increment(METRIC.jobsActive, queueLabel, -1);
      }
    });
  };
}

interface HandleFailureInput {
  readonly deps: JobDeps;
  readonly logger: Logger;
  readonly queue: QueueName;
  readonly job: Job;
  readonly attempt: number;
  readonly correlationId: string;
  readonly error: unknown;
}

/**
 * Decide o destino da falha. A regra do `Docs/08`, escrita uma vez:
 *
 * - permanente → dead-letter agora, sem retentativa;
 * - transitória com tentativas restantes → deixa o BullMQ reagendar;
 * - transitória na última tentativa → dead-letter.
 */
async function handleFailure(input: HandleFailureInput): Promise<void> {
  const { deps, logger, queue, job, attempt, correlationId, error } = input;
  const policy = queuePolicy(queue);
  const permanent = isPermanentError(error);
  // As tentativas do próprio job vencem a política da fila: é o número que o
  // BullMQ obedece quando decide reagendar, e divergir dele faria o envelope
  // achar que ainda há tentativa quando já não há.
  const attempts = job.opts.attempts ?? policy.attempts;
  const exhausted = attempt >= attempts;
  const code = errorCode(error);

  deps.metrics.increment(METRIC.jobsFailedTotal, {
    queue,
    code,
    kind: permanent ? 'permanent' : 'transient',
  });

  if (!permanent && !exhausted) {
    logger.warn({ err: error, code }, 'job falhou; será retentado');
    return;
  }

  deps.metrics.increment(METRIC.jobsDeadLetteredTotal, { queue, code });
  logger.error(
    { err: error, code, permanent },
    permanent ? 'job falhou de forma permanente' : 'job esgotou as tentativas',
  );

  try {
    await deps.deadLetter.record({
      correlationId,
      source: 'queue',
      origin: queue,
      originId: job.id ?? 'unknown',
      jobName: job.name,
      attemptsMade: attempt,
      permanent,
      errorCode: code,
      errorMessage: errorMessage(error).slice(0, 4_000),
      failedAt: new Date().toISOString(),
      payload: job.data,
    });
  } catch (sinkError) {
    // Falhar ao registrar a dead-letter não pode esconder a falha original.
    logger.error({ err: sinkError }, 'não foi possível registrar na dead-letter');
  }
}

/** Lê `correlationId` de um payload já validado, sem assumir a forma exata. */
function readCorrelationId(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'correlationId' in data) {
    const value = (data as { correlationId?: unknown }).correlationId;
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
  return undefined;
}

/** Extrai organização e projeto para o contexto de log. */
function readScope(data: unknown): { organizationId?: string; projectId?: string } {
  if (typeof data !== 'object' || data === null) {
    return {};
  }
  const record = data as { organizationId?: unknown; projectId?: unknown };
  const scope: { organizationId?: string; projectId?: string } = {};
  if (typeof record.organizationId === 'string') {
    scope.organizationId = record.organizationId;
  }
  if (typeof record.projectId === 'string') {
    scope.projectId = record.projectId;
  }
  return scope;
}
