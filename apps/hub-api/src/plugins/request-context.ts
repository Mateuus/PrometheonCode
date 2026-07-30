/**
 * Identificação e correlação da requisição.
 *
 * Cada requisição ganha um `requestId` (ULID) que aparece em três lugares: no
 * envelope de sucesso, no envelope de erro e em toda linha de log emitida
 * durante o processamento. É o que transforma "deu erro às 14h" em uma busca.
 *
 * O `requestId` é **sempre gerado pelo servidor**. O cliente pode mandar um
 * `x-correlation-id` para amarrar chamadas entre serviços, e esse valor é
 * aceito só depois de checado — texto arbitrário vindo de fora não entra em
 * campo de log sem filtro.
 */

import { newId } from '@prometheon/database';
import { runWithLogContext, updateLogContext } from '@prometheon/logger';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Correlação aceita: só o que cabe num identificador. */
const CORRELATION_PATTERN = /^[A-Za-z0-9_.:-]{8,64}$/;

export function readCorrelationId(request: FastifyRequest): string | undefined {
  const header = request.headers['x-correlation-id'];
  const value = Array.isArray(header) ? header[0] : header;

  return value !== undefined && CORRELATION_PATTERN.test(value) ? value : undefined;
}

/** Gerador do `request.id` do Fastify. */
export function generateRequestId(): string {
  return newId();
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);

    const correlationId = readCorrelationId(request);

    // `runWithLogContext` abre o escopo de `AsyncLocalStorage` e chama `done`
    // lá dentro; o resto do pipeline do Fastify corre dentro desse escopo, e
    // qualquer `logger.info` disparado no caminho sai com estes campos.
    runWithLogContext(
      {
        requestId: request.id,
        ...(correlationId === undefined ? {} : { correlationId }),
        operation: `${request.method} ${request.routeOptions.url ?? request.url}`,
      },
      done,
    );
  });

  // Depois da autenticação já se sabe quem é: o contexto é completado para que
  // as linhas seguintes carreguem usuário e organização (`Docs/11`).
  app.addHook('preHandler', (request, _reply, done) => {
    if (request.auth !== undefined) {
      updateLogContext({
        userId: request.auth.userId,
        ...(request.auth.organizationId === null
          ? {}
          : { organizationId: request.auth.organizationId }),
        ...(request.auth.deviceId === null ? {} : { deviceId: request.auth.deviceId }),
      });
    }

    done();
  });
}
