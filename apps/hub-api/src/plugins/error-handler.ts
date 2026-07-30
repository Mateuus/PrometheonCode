/**
 * Tratamento central de erro.
 *
 * Toda saída de erro da API passa por aqui e sai no envelope do `Docs/06`:
 * `{ error: { code, message, requestId } }`. Duas regras governam o conteúdo:
 *
 * 1. **A mensagem é para o cliente, o log é para nós.** Erro inesperado vira
 *    `INTERNAL_ERROR` com texto genérico; a exceção original, com pilha, fica
 *    no log correlacionado pelo `requestId`.
 * 2. **Erro de validação diz o campo, nunca o valor.** Devolver o que foi
 *    enviado ecoaria senha e token de volta ao cliente e para dentro de
 *    qualquer proxy no caminho.
 */

import type { ErrorBody, ErrorCode, FieldError } from '@prometheon/contracts';
import { child } from '@prometheon/logger';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { type ApiError, isApiError } from '../shared/errors.js';

/** Códigos do Fastify que têm tradução direta para o enum do contrato. */
const FASTIFY_CODE_MAP: Readonly<Record<string, { status: number; code: ErrorCode }>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'MALFORMED_REQUEST' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'MALFORMED_REQUEST' },
  FST_ERR_VALIDATION: { status: 400, code: 'VALIDATION_FAILED' },
  FST_ERR_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
};

function toFieldErrors(
  validation: readonly { instancePath?: string; message?: string; params?: unknown }[],
): FieldError[] {
  return validation.map((issue) => ({
    // `instancePath` chega como `/user/email`; o contrato usa `user.email`.
    path: (issue.instancePath ?? '').replace(/^\//, '').replaceAll('/', '.') || '(root)',
    message: issue.message ?? 'is invalid',
  }));
}

function buildBody(
  requestId: string,
  code: ErrorCode,
  message: string,
  fields?: readonly FieldError[],
  retryAfter?: Date,
): { error: ErrorBody } {
  return {
    error: {
      code,
      message,
      requestId,
      ...(fields === undefined || fields.length === 0 ? {} : { fields: [...fields] }),
      ...(retryAfter === undefined ? {} : { retryAfter: retryAfter.toISOString() }),
    },
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  const logger = child('http-error');

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .code(404)
      .send(buildBody(request.id, 'NOT_FOUND', 'The requested resource does not exist.'));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (isApiError(error)) {
      applyHeaders(reply, error);

      // 5xx é problema nosso e sobe como `error`; 4xx é do cliente e fica em
      // `warn` para não afogar o log de produção.
      const level = error.statusCode >= 500 ? 'error' : 'warn';

      logger[level](
        { err: error, code: error.code, statusCode: error.statusCode, details: error.details },
        'request failed',
      );

      void reply
        .code(error.statusCode)
        .send(
          buildBody(request.id, error.code, error.message, error.fields, error.retryAfter),
        );

      return;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields = toFieldErrors(error.validation);

      logger.warn({ fields }, 'request failed schema validation');

      void reply
        .code(400)
        .send(
          buildBody(
            request.id,
            'VALIDATION_FAILED',
            'The request body or parameters are invalid.',
            fields,
          ),
        );

      return;
    }

    if (isResponseSerializationError(error)) {
      // Isto é bug do servidor: o handler devolveu algo que o contrato de
      // resposta não aceita. Vaza `INTERNAL_ERROR` e grita no log.
      logger.error({ err: error, url: error.url }, 'response does not match its schema');

      void reply
        .code(500)
        .send(buildBody(request.id, 'INTERNAL_ERROR', 'Unexpected error.'));

      return;
    }

    const mapped = FASTIFY_CODE_MAP[error.code];

    if (mapped !== undefined) {
      logger.warn({ err: error, fastifyCode: error.code }, 'request rejected by fastify');

      void reply
        .code(mapped.status)
        .send(
          buildBody(
            request.id,
            mapped.code,
            mapped.code === 'PAYLOAD_TOO_LARGE'
              ? 'The request payload is larger than the allowed limit.'
              : error.message,
            error.validation === undefined ? undefined : toFieldErrors(error.validation),
          ),
        );

      return;
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (statusCode < 500) {
      logger.warn({ err: error, statusCode }, 'request failed');

      void reply
        .code(statusCode)
        .send(buildBody(request.id, 'MALFORMED_REQUEST', error.message));

      return;
    }

    logger.error({ err: error }, 'unhandled error');

    void reply.code(500).send(buildBody(request.id, 'INTERNAL_ERROR', 'Unexpected error.'));
  });
}

function applyHeaders(reply: FastifyReply, error: ApiError): void {
  if (error.headers === undefined) {
    return;
  }

  for (const [name, value] of Object.entries(error.headers)) {
    void reply.header(name, value);
  }
}
