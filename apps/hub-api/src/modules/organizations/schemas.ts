/** Schemas das rotas de organização. */

import {
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  errorEnvelopeSchema,
  invitationSchema,
  memberListQuerySchema,
  organizationMemberSchema,
  organizationSchema,
  organizationWithAccessSchema,
  successEnvelope,
  ulidSchema,
  updateMemberRequestSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export {
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  cursorPageQuerySchema,
  memberListQuerySchema,
  updateMemberRequestSchema,
};

export const organizationParamsSchema = z.object({ orgId: ulidSchema });

export const memberParamsSchema = z.object({
  orgId: ulidSchema,
  memberId: ulidSchema,
});

export const organizationPageEnvelope = successEnvelope(
  cursorPageSchema(organizationWithAccessSchema),
);
export const organizationEnvelope = successEnvelope(organizationSchema);
export const organizationWithAccessEnvelope = successEnvelope(
  organizationWithAccessSchema,
);
export const memberPageEnvelope = successEnvelope(
  cursorPageSchema(organizationMemberSchema),
);
export const memberEnvelope = successEnvelope(organizationMemberSchema);

/**
 * Convite devolvido sem o token.
 *
 * O valor puro só existe no link do e-mail; devolvê-lo na resposta permitiria a
 * quem convida entrar na conta de quem foi convidado.
 */
export const invitationEnvelope = successEnvelope(invitationSchema);

export const organizationErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
