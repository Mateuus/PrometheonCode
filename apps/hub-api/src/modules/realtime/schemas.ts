/** Schemas das rotas de tempo real. */

import { errorEnvelopeSchema, isoDateTimeSchema, successEnvelope } from '@prometheon/contracts';
import { z } from 'zod';

/**
 * Resposta de `GET /v1/realtime/token`.
 *
 * Devolve mais que o token: `url` poupa o cliente de montar `ws://` ou `wss://`
 * por conta própria, e `heartbeatIntervalMs` chega antes do `welcome` para o
 * cliente já subir com o temporizador certo.
 */
export const realtimeTokenResponseSchema = z.object({
  token: z.string().min(1),
  tokenType: z.literal('Bearer'),
  /** Vida do token em segundos. Ele vale uma conexão só. */
  expiresIn: z.int().positive(),
  expiresAt: isoDateTimeSchema,
  url: z.string().min(1),
  protocolVersion: z.int().positive(),
  heartbeatIntervalMs: z.int().positive(),
});

export const realtimeTokenEnvelope = successEnvelope(realtimeTokenResponseSchema);

/** Query string aceita pelo endpoint WebSocket. */
export const realtimeConnectQuerySchema = z.object({
  /** Token de `GET /v1/realtime/token`. Alternativa: header `Authorization`. */
  token: z.string().min(1).max(4096).optional(),
});

export const realtimeErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
