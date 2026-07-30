/**
 * Schemas de request e response da gestão da própria conta.
 *
 * A base vem de `@prometheon/contracts`, como no resto da API: o contrato
 * público é dele. Aqui ficam só os envelopes montados e os parâmetros de rota,
 * que não são contrato — são detalhe do roteamento.
 */

import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  cursorPageQuerySchema,
  errorEnvelopeSchema,
  sessionPageSchema,
  successEnvelope,
  ulidSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { changePasswordRequestSchema, updateProfileRequestSchema };

/**
 * Consulta da listagem de sessões.
 *
 * `direction` do schema de paginação fica de fora: a lista é sempre da sessão
 * mais recente para a mais antiga, e um parâmetro que aceita `asc` sem que o
 * repositório o respeite seria um contrato mentindo.
 */
export const sessionListQuerySchema = cursorPageQuerySchema.pick({
  cursor: true,
  limit: true,
});

export const sessionParamsSchema = z.object({
  sessionId: ulidSchema,
});

export const sessionPageEnvelope = successEnvelope(sessionPageSchema);
export const changePasswordEnvelope = successEnvelope(changePasswordResponseSchema);
export const profileEnvelope = successEnvelope(updateProfileResponseSchema);

/**
 * Resposta da revogação.
 *
 * `current` diz se a sessão derrubada era a de quem chamou — o cliente precisa
 * saber disso para limpar as próprias credenciais em vez de só recarregar a
 * lista com um token que acabou de morrer.
 */
export const revokeSessionEnvelope = successEnvelope(
  z.object({ current: z.boolean() }),
);

export const accountErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
