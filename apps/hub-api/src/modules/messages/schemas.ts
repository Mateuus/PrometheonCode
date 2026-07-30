/** Schemas das rotas de mensagem. */

import {
  createMessageRequestSchema,
  errorEnvelopeSchema,
  messageListQuerySchema,
  messagePageSchema,
  messageSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { createMessageRequestSchema, messageListQuerySchema };

export const conversationParamsSchema = z.object({ conversationId: ulidSchema });

export const messageEnvelope = successEnvelope(messageSchema);

export const messagePageEnvelope = successEnvelope(messagePageSchema);

export const messageErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
