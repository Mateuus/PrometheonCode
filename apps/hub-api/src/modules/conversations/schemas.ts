/** Schemas das rotas de conversa. */

import {
  conversationListQuerySchema,
  conversationPageSchema,
  conversationSchema,
  createConversationRequestSchema,
  errorEnvelopeSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { conversationListQuerySchema, createConversationRequestSchema };

export const projectParamsSchema = z.object({ projectId: ulidSchema });

export const conversationParamsSchema = z.object({ conversationId: ulidSchema });

export const conversationEnvelope = successEnvelope(conversationSchema);

export const conversationPageEnvelope = successEnvelope(conversationPageSchema);

export const conversationErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
