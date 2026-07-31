/** Schemas das rotas de ditado por voz. */

import { errorEnvelopeSchema, isoDateTimeSchema, successEnvelope } from '@prometheon/contracts';
import { z } from 'zod';

/**
 * Resposta de `GET /v1/transcription/ticket`.
 *
 * Devolve mais que o bilhete, pelo mesmo motivo do canal ao vivo: `url` poupa o
 * cliente de decidir entre `ws://` e `wss://`, e `sampleRate` chega antes de o
 * microfone abrir — o navegador precisa dele para configurar a captura, e
 * descobrir tarde significaria reamostrar áudio já gravado.
 */
export const transcriptionTicketResponseSchema = z.object({
  token: z.string().min(1),
  tokenType: z.literal('Bearer'),
  /** Vida do bilhete em segundos. Ele vale uma conexão só. */
  expiresIn: z.int().positive(),
  expiresAt: isoDateTimeSchema,
  url: z.string().min(1),
  sampleRate: z.int().positive(),
  /** Idioma que o serviço vai assumir, já resolvido a partir da configuração. */
  language: z.string().min(2),
  maxSessionMs: z.int().positive(),
});

export const transcriptionTicketEnvelope = successEnvelope(transcriptionTicketResponseSchema);

/**
 * Resposta de `GET /v1/transcription/status`.
 *
 * Serve para a interface decidir se mostra o botão de microfone. `ready` é
 * separado de `enabled` porque o serviço responde ao HTTP bem antes de os pesos
 * do modelo estarem carregados, e um microfone que aparece antes da hora só
 * produz uma conexão que morre no primeiro clique.
 */
export const transcriptionStatusResponseSchema = z.object({
  enabled: z.boolean(),
  ready: z.boolean(),
  language: z.string().min(2),
  /** Ausentes quando o serviço não está alcançável. */
  model: z.string().optional(),
  device: z.string().optional(),
});

export const transcriptionStatusEnvelope = successEnvelope(transcriptionStatusResponseSchema);

/** Query string aceita pelo endpoint WebSocket. */
export const transcriptionConnectQuerySchema = z.object({
  /** Bilhete de `GET /v1/transcription/ticket`. */
  ticket: z.string().min(1).max(4096).optional(),
  /** Sobrepõe o idioma da configuração nesta sessão. */
  language: z.string().min(2).max(8).optional(),
});

export const transcriptionErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
} as const;
