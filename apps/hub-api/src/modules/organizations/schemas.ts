/** Schemas das rotas de organização. */

import {
  acceptInvitationRequestSchema,
  acceptInvitationResponseSchema,
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  deleteOrganizationRequestSchema,
  errorEnvelopeSchema,
  invitationSchema,
  memberListQuerySchema,
  organizationMemberSchema,
  organizationSchema,
  organizationWithAccessSchema,
  slugSchema,
  successEnvelope,
  shortTextSchema,
  ulidSchema,
  updateMemberRequestSchema,
  updateOrganizationRequestSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  cursorPageQuerySchema,
  deleteOrganizationRequestSchema,
  memberListQuerySchema,
  updateMemberRequestSchema,
  updateOrganizationRequestSchema,
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
 * Resposta da exclusão: o que foi apagado, não o estado atual.
 *
 * Devolver a organização inteira depois de excluí-la faria a tela desenhar algo
 * que já não existe; o identificador e o nome bastam para a mensagem de saída.
 */
export const organizationDeletedEnvelope = successEnvelope(
  z.object({
    organization: z.object({ id: ulidSchema, slug: slugSchema, name: shortTextSchema }),
  }),
);

/**
 * Convite devolvido sem o token.
 *
 * O valor puro só existe no link do e-mail; devolvê-lo na resposta permitiria a
 * quem convida entrar na conta de quem foi convidado.
 */
export const invitationEnvelope = successEnvelope(invitationSchema);

/**
 * Aceitação de convite: devolve a organização com o papel concedido e o vínculo
 * criado, para o cliente já saber para onde navegar e o que pode fazer lá.
 */
export const acceptInvitationEnvelope = successEnvelope(acceptInvitationResponseSchema);

export const organizationErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
