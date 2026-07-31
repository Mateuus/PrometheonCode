/** Schemas das rotas de administração da plataforma. */

import {
  adminOrganizationListQuerySchema,
  adminOrganizationPageSchema,
  adminOrganizationSchema,
  assignPlanRequestSchema,
  createPlanRequestSchema,
  errorEnvelopeSchema,
  organizationLimitOverridesSchema,
  planListSchema,
  planSchema,
  slugSchema,
  successEnvelope,
  ulidSchema,
  updatePlanRequestSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export {
  adminOrganizationListQuerySchema,
  assignPlanRequestSchema,
  createPlanRequestSchema,
  organizationLimitOverridesSchema,
  updatePlanRequestSchema,
};

export const planParamsSchema = z.object({ planCode: slugSchema });
export const organizationParamsSchema = z.object({ orgId: ulidSchema });

export const planListEnvelope = successEnvelope(planListSchema);
export const planEnvelope = successEnvelope(z.object({ plan: planSchema }));
export const adminOrganizationPageEnvelope = successEnvelope(adminOrganizationPageSchema);
export const adminOrganizationEnvelope = successEnvelope(
  z.object({ organization: adminOrganizationSchema }),
);

export const adminErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
