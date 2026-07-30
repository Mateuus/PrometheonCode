/**
 * Rotas de tempo real.
 *
 * | Rota                      | Autorização                                    |
 * | ------------------------- | ---------------------------------------------- |
 * | `GET /v1/realtime/token`  | credencial válida (usuário ou dispositivo)      |
 * | `GET /v1/realtime`        | token curto do endpoint acima, uso único        |
 *
 * O endpoint do token não exige permissão de organização de propósito: o token
 * não dá acesso a nada por si só. **Quem autoriza é a inscrição**, conferida no
 * `hello` contra `authorize()` e reavaliada enquanto a conexão vive
 * (`service.ts`). Emitir o token antes de saber o que o cliente vai assinar é o
 * que permite a uma pessoa com várias organizações abrir uma conexão só.
 */

import { REALTIME_PROTOCOL_VERSION } from '@prometheon/contracts';
import { newId } from '@prometheon/database';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { enforceRateLimit } from '../../plugins/rate-limit.js';
import { CLOSE_CODES } from './connection.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import type { RealtimeModule } from './module.js';
import {
  realtimeConnectQuerySchema,
  realtimeErrorResponses,
  realtimeTokenEnvelope,
} from './schemas.js';
import { handleRealtimeConnection } from './session.js';
import { REALTIME_SETTINGS } from './settings.js';
import { issueRealtimeToken } from './token.js';

export interface RealtimeRoutesOptions {
  readonly module: RealtimeModule;
}

/** Teto de emissão de token: reconectar é normal, reconectar em laço não é. */
const TOKEN_RATE_LIMIT = { max: 120, windowSeconds: 300 } as const;

/** `http(s)://…` vira `ws(s)://…/v1/realtime`. */
function websocketUrl(apiUrl: string): string {
  const url = new URL('/v1/realtime', apiUrl);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
}

// Plugin síncrono: registrar rota não espera nada, e `async` sem `await` só
// esconderia isso.
export const realtimeRoutes: FastifyPluginCallbackZod<RealtimeRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { module } = options;

  app.get(
    '/realtime/token',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['realtime'],
        summary: 'Short-lived token for the realtime WebSocket',
        description:
          'Step 1 of the handshake. The token lives for one minute and is valid for a single connection.',
        security: [{ bearerAuth: [] }],
        response: { 200: realtimeTokenEnvelope, ...realtimeErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      await enforceRateLimit(
        app.redis,
        `realtime-token:${auth.userId}`,
        TOKEN_RATE_LIMIT,
        'Too many realtime tokens for this account.',
      );

      const issued = await issueRealtimeToken(app.appConfig, {
        userId: auth.userId,
        kind: auth.kind,
        sessionId: auth.sessionId,
        deviceId: auth.deviceId,
        organizationId: auth.organizationId,
        tokenId: newId(),
      });

      return ok(request, {
        token: issued.token,
        tokenType: 'Bearer' as const,
        expiresIn: issued.expiresIn,
        expiresAt: issued.expiresAt.toISOString(),
        url: websocketUrl(app.appConfig.http.apiUrl),
        protocolVersion: REALTIME_PROTOCOL_VERSION,
        heartbeatIntervalMs: REALTIME_SETTINGS.heartbeatIntervalMs,
      });
    },
  );

  app.get(
    '/realtime',
    {
      websocket: true,
      schema: {
        tags: ['realtime'],
        summary: 'Realtime event stream (WebSocket)',
        description:
          'Upgrade only. Send `hello` with the protocol version, the device and the subscriptions; the server answers `welcome` and resumes from the cursor.',
        querystring: realtimeConnectQuerySchema,
        // A resposta é um upgrade de protocolo, não um corpo: descrevê-la em
        // OpenAPI produziria um contrato que nenhum cliente pode conferir.
        hide: true,
      },
    },
    (socket, request) => {
      // O handler é assíncrono e o Fastify não espera por ele. Uma falha aqui
      // sem `catch` deixaria o socket aberto e mudo — o pior estado possível,
      // porque o cliente fica esperando um `welcome` que nunca vem em vez de
      // receber um fechamento e reconectar.
      handleRealtimeConnection(socket, request, {
        config: app.appConfig,
        redis: app.redis,
        hub: module.hub,
        service: module.service,
        keys: module.keys,
      }).catch((error: unknown) => {
        app.log.error({ err: error }, 'realtime: falha ao estabelecer a conexão');
        socket.close(CLOSE_CODES.protocol, 'handshake failed');
      });
    },
  );

  done();
};
