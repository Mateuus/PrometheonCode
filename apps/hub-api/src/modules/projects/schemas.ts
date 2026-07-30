/** Schemas das rotas de projeto. */

import {
  createProjectRequestSchema,
  cursorPageSchema,
  errorEnvelopeSchema,
  projectListQuerySchema,
  projectSchema,
  successEnvelope,
  ulidSchema,
  updateProjectRequestSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { createProjectRequestSchema, projectListQuerySchema, updateProjectRequestSchema };

export const organizationParamsSchema = z.object({ orgId: ulidSchema });

export const projectParamsSchema = z.object({ projectId: ulidSchema });

export const projectEnvelope = successEnvelope(projectSchema);

export const projectPageEnvelope = successEnvelope(cursorPageSchema(projectSchema));

/**
 * Respostas de erro declaradas em toda rota do módulo.
 *
 * Elas entram no OpenAPI: o cliente descobre pelo contrato que `409` existe,
 * em vez de descobrir em produção.
 */
export const projectErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
