/** Schemas das rotas de dispositivo. */

import {
  deviceHeartbeatRequestSchema,
  deviceHeartbeatResponseSchema,
  deviceKindSchema,
  deviceSchema,
  errorEnvelopeSchema,
  isoDateTimeSchema,
  presenceListSchema,
  publicUserSchema,
  registerDeviceRequestSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { deviceHeartbeatRequestSchema, registerDeviceRequestSchema };

export const deviceParamsSchema = z.object({ deviceId: ulidSchema });
export const projectParamsSchema = z.object({ projectId: ulidSchema });

export const deviceEnvelope = successEnvelope(deviceSchema);
export const heartbeatEnvelope = successEnvelope(deviceHeartbeatResponseSchema);
export const presenceEnvelope = successEnvelope(presenceListSchema);

/**
 * Um agente ativo é um **dispositivo que bateu dentro da janela**, com as
 * execuções que ele declarou.
 *
 * Não existe schema para isto em `@prometheon/contracts` — a lista nasce do
 * cruzamento entre a tabela `devices` e o estado vivo no Redis, que é uma forma
 * própria desta rota. Ele é montado a partir dos schemas do pacote para que
 * `owner` e `kind` continuem sendo os mesmos tipos de todo o resto da API.
 */
export const activeAgentSchema = z.object({
  deviceId: ulidSchema,
  deviceName: z.string().min(1).max(160),
  kind: deviceKindSchema,
  platform: z.string().max(64).nullable(),
  clientVersion: z.string().max(64).nullable(),
  status: z.enum(['online', 'idle']),
  owner: publicUserSchema,
  /** Execuções de agente que o dispositivo declarou no último heartbeat. */
  activeAgentRunIds: z.array(ulidSchema),
  lastSeenAt: isoDateTimeSchema,
});

export const activeAgentListSchema = z.object({
  agents: z.array(activeAgentSchema),
});

export const activeAgentsEnvelope = successEnvelope(activeAgentListSchema);

export const deviceErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
