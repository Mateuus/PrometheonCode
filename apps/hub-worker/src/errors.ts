// Classificação de falha dos jobs (`Docs/08`).
//
// A regra que o documento cobra é simples de enunciar e fácil de errar: falha
// permanente não pode ficar em retentativa eterna, e falha transitória não pode
// ir direto para a dead-letter. Por isso o processador declara qual é qual em
// vez de deixar o envelope adivinhar pelo texto da mensagem.
//
// `PermanentJobError` estende `UnrecoverableError` do BullMQ, que é o sinal que
// o próprio BullMQ entende para não reagendar o job.

import { UnrecoverableError } from 'bullmq';

export interface JobErrorDetails {
  /** Código estável, para métrica e para o registro na dead-letter. */
  readonly code: string;
  /** Contexto adicional já redigido — nada de segredo aqui. */
  readonly details?: Record<string, unknown> | undefined;
  readonly cause?: unknown;
}

/**
 * Falha que repetir não conserta: payload inválido, recurso que não existe,
 * regra de negócio violada, resposta 4xx definitiva do outro lado.
 */
export class PermanentJobError extends UnrecoverableError {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: JobErrorDetails) {
    super(message);
    this.name = 'PermanentJobError';
    this.code = options.code;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Falha que pode passar sozinha: indisponibilidade, timeout, 5xx, deadlock.
 * Vai para retentativa com backoff até esgotar as tentativas da fila.
 */
export class TransientJobError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: JobErrorDetails) {
    super(message);
    this.name = 'TransientJobError';
    this.code = options.code;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Estouro do timeout da fila. É transitório: a próxima tentativa pode caber. */
export class JobTimeoutError extends TransientJobError {
  constructor(queue: string, timeoutMs: number) {
    super(`Job da fila "${queue}" excedeu ${String(timeoutMs)} ms.`, {
      code: 'JOB_TIMEOUT',
      details: { queue, timeoutMs },
    });
    this.name = 'JobTimeoutError';
  }
}

/**
 * `true` quando o erro é permanente. Cobre também o `UnrecoverableError` cru,
 * que qualquer código de terceiro pode lançar.
 */
export function isPermanentError(error: unknown): boolean {
  if (error instanceof PermanentJobError || error instanceof UnrecoverableError) {
    return true;
  }
  return error instanceof Error && error.name === 'UnrecoverableError';
}

/** Código do erro para métrica e registro; `UNKNOWN` quando não há. */
export function errorCode(error: unknown): string {
  if (error instanceof PermanentJobError || error instanceof TransientJobError) {
    return error.code;
  }
  if (error instanceof Error && error.name !== '' && error.name !== 'Error') {
    return error.name;
  }
  return 'UNKNOWN';
}

/** Mensagem legível de um erro qualquer, sem lançar de novo. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
