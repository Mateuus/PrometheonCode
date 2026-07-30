/** Schemas das rotas de conhecimento. */

import {
  createKnowledgeProposalSchema,
  errorEnvelopeSchema,
  knowledgeDiffSchema,
  knowledgeItemSchema,
  knowledgeListQuerySchema,
  knowledgePageSchema,
  knowledgeReviewRequestSchema,
  knowledgeReviewResultSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export {
  createKnowledgeProposalSchema,
  knowledgeListQuerySchema,
  knowledgeReviewRequestSchema,
};

export const projectParamsSchema = z.object({ projectId: ulidSchema });

export const knowledgeParamsSchema = z.object({ knowledgeId: ulidSchema });

export const knowledgePageEnvelope = successEnvelope(knowledgePageSchema);
export const knowledgeItemEnvelope = successEnvelope(knowledgeItemSchema);
export const knowledgeDiffEnvelope = successEnvelope(knowledgeDiffSchema);
export const knowledgeReviewEnvelope = successEnvelope(knowledgeReviewResultSchema);

export const knowledgeErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
