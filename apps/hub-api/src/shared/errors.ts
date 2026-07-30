/**
 * Erros da API.
 *
 * Todo erro que chega ao cliente passa por aqui e sai no envelope do `Docs/06`:
 * `{ error: { code, message, requestId } }`. `code` vem do enum estável de
 * `@prometheon/contracts` — o cliente decide comportamento a partir dele, então
 * um código existente nunca muda de significado.
 */

import type { ErrorCode, FieldError } from '@prometheon/contracts';

export interface ApiErrorOptions {
  /** Detalhe por campo; só faz sentido em `VALIDATION_FAILED`. */
  readonly fields?: readonly FieldError[];
  /** Momento em que a chamada volta a ser aceita, em `RATE_LIMITED`. */
  readonly retryAfter?: Date;
  /** Contexto para o log. Nunca vai para o corpo da resposta. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Cabeçalhos extras (`Retry-After`, `WWW-Authenticate`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Erro com código estável e status HTTP. Lançar isto de qualquer camada é
 * suficiente: o handler central de `plugins/error-handler.ts` faz o resto.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly fields: readonly FieldError[] | undefined;
  readonly retryAfter: Date | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = options.fields;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** 400 — o corpo chegou, mas não faz sentido. */
export function badRequest(
  code: ErrorCode,
  message: string,
  options?: ApiErrorOptions,
): ApiError {
  return new ApiError(400, code, message, options);
}

/** 401 — não sabemos quem está chamando. */
export function unauthenticated(
  message = 'Authentication is required.',
  code: ErrorCode = 'UNAUTHENTICATED',
  options?: ApiErrorOptions,
): ApiError {
  return new ApiError(401, code, message, {
    headers: { 'www-authenticate': 'Bearer' },
    ...options,
  });
}

/** 403 — sabemos quem é, e essa pessoa não pode. */
export function forbidden(
  message: string,
  code: ErrorCode = 'PERMISSION_DENIED',
  options?: ApiErrorOptions,
): ApiError {
  return new ApiError(403, code, message, options);
}

export function notFound(
  code: ErrorCode,
  message: string,
  options?: ApiErrorOptions,
): ApiError {
  return new ApiError(404, code, message, options);
}

export function conflict(
  code: ErrorCode,
  message: string,
  options?: ApiErrorOptions,
): ApiError {
  return new ApiError(409, code, message, options);
}

export function tooManyRequests(
  message: string,
  retryAfter: Date,
  code: ErrorCode = 'RATE_LIMITED',
): ApiError {
  const seconds = Math.max(1, Math.ceil((retryAfter.getTime() - Date.now()) / 1000));

  return new ApiError(429, code, message, {
    retryAfter,
    headers: { 'retry-after': String(seconds) },
  });
}

export function internalError(message = 'Unexpected error.', cause?: unknown): ApiError {
  return new ApiError(500, 'INTERNAL_ERROR', message, { cause });
}

export function serviceUnavailable(message: string, cause?: unknown): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', message, { cause });
}
