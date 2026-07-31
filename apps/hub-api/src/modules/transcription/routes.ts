/**
 * Rotas do ditado por voz.
 *
 * | Rota                              | Autorização                          |
 * | --------------------------------- | ------------------------------------ |
 * | `GET /v1/transcription/status`    | credencial válida                    |
 * | `GET /v1/transcription/ticket`    | credencial válida                    |
 * | `GET /v1/transcription`           | bilhete do endpoint acima, uso único |
 *
 * Nenhuma delas exige permissão de organização, e isso é deliberado: ditar é
 * uma forma de escrever no campo de texto, não uma operação sobre dados de
 * ninguém. Quem decide o que a mensagem pode fazer é a rota que a recebe
 * depois, com as regras de sempre.
 */

import { newId } from '@prometheon/database';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { enforceRateLimit } from '../../plugins/rate-limit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { handleTranscriptionSession } from './session.js';
import {
  transcriptionConnectQuerySchema,
  transcriptionErrorResponses,
  transcriptionStatusEnvelope,
  transcriptionTicketEnvelope,
} from './schemas.js';
import { CLOSE_CODES, TRANSCRIPTION_SETTINGS } from './settings.js';
import { issueTranscriptionTicket } from './token.js';
import { checkUpstreamHealth } from './upstream.js';

/**
 * Teto de emissão de bilhetes.
 *
 * Mais folgado que o do canal ao vivo porque o gesto é outro: reconectar ao
 * canal de eventos é raro, mas clicar no microfone várias vezes seguidas é o
 * uso normal — a pessoa dita, corrige, dita de novo.
 */
const TICKET_RATE_LIMIT = { max: 60, windowSeconds: 300 } as const;

/** `http(s)://…` vira `ws(s)://…/v1/transcription`. */
function websocketUrl(apiUrl: string): string {
  const url = new URL('/v1/transcription', apiUrl);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
}

export const transcriptionRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    '/transcription/status',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['transcription'],
        summary: 'Whether voice dictation is available',
        description:
          'The interface uses this to decide whether to offer the microphone. `ready` is false while the transcription service is still loading its model.',
        security: [{ bearerAuth: [] }],
        response: { 200: transcriptionStatusEnvelope, ...transcriptionErrorResponses },
      },
    },
    async (request) => {
      const { transcription } = app.appConfig;

      if (!transcription.enabled || transcription.url === undefined) {
        return ok(request, {
          enabled: false,
          ready: false,
          language: transcription.language,
        });
      }

      const health = await checkUpstreamHealth(transcription.url, transcription.apiKey);

      return ok(request, {
        // `enabled` responde sobre o Hub; `ready`, sobre o serviço. Separá-los
        // é o que permite à interface dizer "carregando" em vez de "indisponível"
        // enquanto o modelo sobe.
        enabled: true,
        ready: health.reachable && health.enabled && health.ready,
        language: transcription.language,
        model: health.model,
        device: health.device,
      });
    },
  );

  app.get(
    '/transcription/ticket',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['transcription'],
        summary: 'Short-lived ticket for the dictation WebSocket',
        description:
          'Step 1 of the handshake. The ticket lives for one minute and is valid for a single connection.',
        security: [{ bearerAuth: [] }],
        response: { 200: transcriptionTicketEnvelope, ...transcriptionErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      await enforceRateLimit(
        app.redis,
        `transcription-ticket:${auth.userId}`,
        TICKET_RATE_LIMIT,
        'Too many dictation tickets for this account.',
      );

      const issued = await issueTranscriptionTicket(app.appConfig, {
        userId: auth.userId,
        kind: auth.kind,
        organizationId: auth.organizationId,
        ticketId: newId(),
      });

      return ok(request, {
        token: issued.token,
        tokenType: 'Bearer' as const,
        expiresIn: issued.expiresIn,
        expiresAt: issued.expiresAt.toISOString(),
        url: websocketUrl(app.appConfig.http.apiUrl),
        sampleRate: TRANSCRIPTION_SETTINGS.sampleRate,
        language: app.appConfig.transcription.language,
        maxSessionMs: TRANSCRIPTION_SETTINGS.maxSessionMs,
      });
    },
  );

  app.get(
    '/transcription',
    {
      websocket: true,
      schema: {
        tags: ['transcription'],
        summary: 'Live dictation stream (WebSocket)',
        description:
          'Upgrade only. Send binary PCM frames; receive `partial` and `final` events. Close the utterance with `{"type":"stop"}`.',
        querystring: transcriptionConnectQuerySchema,
        // A resposta é um upgrade de protocolo, não um corpo: descrevê-la em
        // OpenAPI produziria um contrato que nenhum cliente pode conferir.
        hide: true,
      },
    },
    (socket, request) => {
      // O handler é assíncrono e o Fastify não espera por ele. Uma falha sem
      // `catch` deixaria o socket aberto e mudo, que é o pior estado possível:
      // o cliente segue gravando e mandando áudio para lugar nenhum.
      handleTranscriptionSession(socket, request, {
        config: app.appConfig,
        redis: app.redis,
        log: app.log,
      }).catch((error: unknown) => {
        app.log.error({ err: error }, 'transcription: falha ao estabelecer a sessão');
        socket.close(CLOSE_CODES.unavailable, 'session failed');
      });
    },
  );

  done();
};
