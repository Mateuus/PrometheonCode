/** Schemas das rotas de plano e assinatura. */

import {
  changePlanRequestSchema,
  errorEnvelopeSchema,
  planChangeResultSchema,
  planListSchema,
  subscriptionOverviewSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { changePlanRequestSchema };

export const organizationParamsSchema = z.object({ orgId: ulidSchema });

export const planListEnvelope = successEnvelope(planListSchema);
export const subscriptionOverviewEnvelope = successEnvelope(subscriptionOverviewSchema);
export const planChangeEnvelope = successEnvelope(planChangeResultSchema);

export const billingErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
