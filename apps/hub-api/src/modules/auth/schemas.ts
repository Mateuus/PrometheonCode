/**
 * Schemas de request e response das rotas de autenticação.
 *
 * A base vem de `@prometheon/contracts` — o contrato público é dele, não desta
 * aplicação. Aqui só ficam os envelopes já montados e as poucas divergências,
 * cada uma com o motivo escrito.
 */

import {
  currentUserSchema,
  deviceAuthorizationRequestSchema,
  deviceAuthorizationResponseSchema,
  deviceCredentialSchema,
  deviceDecisionRequestSchema,
  deviceTokenRequestSchema,
  deviceVerificationRequestSchema,
  deviceVerificationSchema,
  emailSchema,
  errorEnvelopeSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutRequestSchema,
  meResponseSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  registerRequestSchema,
  successEnvelope,
  switchOrganizationRequestSchema,
  switchOrganizationResponseSchema,
  verifyEmailRequestSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export {
  deviceAuthorizationRequestSchema,
  deviceDecisionRequestSchema,
  deviceTokenRequestSchema,
  deviceVerificationRequestSchema,
  errorEnvelopeSchema,
  loginRequestSchema,
  logoutRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  switchOrganizationRequestSchema,
  verifyEmailRequestSchema,
};

/**
 * Resposta do registro.
 *
 * DIVERGE de `registerResponseSchema` do contrato, que devolve o usuário
 * criado. Devolver o usuário é a própria enumeração que o `Docs/09` manda
 * evitar: quem posta um e-mail já cadastrado receberia um corpo diferente de
 * quem posta um endereço novo, e descobriria a conta sem precisar de senha.
 *
 * A resposta aqui é a mesma nos dois casos — `202 Accepted` dizendo apenas que,
 * se o endereço puder ser registrado, uma mensagem foi enviada. Quando o
 * contrato público for ajustado, este schema sai daqui.
 */
export const registerAcceptedSchema = z.object({
  email: emailSchema,
  verificationEmailSent: z.boolean(),
});

export const registerEnvelope = successEnvelope(registerAcceptedSchema);
export const loginEnvelope = successEnvelope(loginResponseSchema);
export const refreshEnvelope = successEnvelope(refreshResponseSchema);
export const meEnvelope = successEnvelope(meResponseSchema);
export const switchOrganizationEnvelope = successEnvelope(
  switchOrganizationResponseSchema,
);
export const emptyEnvelope = successEnvelope(z.object({}));

export const verifyEmailResponseSchema = z.object({
  user: currentUserSchema,
});

export const verifyEmailEnvelope = successEnvelope(verifyEmailResponseSchema);

export const deviceAuthorizationEnvelope = successEnvelope(
  deviceAuthorizationResponseSchema,
);
export const deviceVerificationEnvelope = successEnvelope(deviceVerificationSchema);
export const deviceCredentialEnvelope = successEnvelope(deviceCredentialSchema);
export const deviceDecisionEnvelope = successEnvelope(
  z.object({ status: z.enum(['approved', 'denied']) }),
);

/**
 * Respostas de erro anunciadas na OpenAPI.
 *
 * Todas usam o mesmo envelope; a lista existe para que o documento gerado
 * mostre os status possíveis de cada rota.
 */
export const errorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;

export const authErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;

// ---------------------------------------------------------------------------
// Login por provedor externo
// ---------------------------------------------------------------------------

/**
 * Início do fluxo.
 *
 * `redirectTo` é onde a pessoa queria estar antes de ser mandada para o login.
 * O servidor só aceita caminho interno — ver `safeRedirect` no serviço.
 */
export const providerStartQuerySchema = z.object({
  redirectTo: z.string().max(512).optional(),
});

/**
 * Volta do provedor.
 *
 * `error` existe porque o GitHub redireciona de volta com ele quando a pessoa
 * clica em "cancelar" na tela de consentimento. Tratar essa volta como falha de
 * validação mostraria um erro técnico para quem apenas mudou de ideia.
 */
export const providerCallbackQuerySchema = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(128).optional(),
});

export const providerExchangeRequestSchema = z.object({
  code: z.string().min(16).max(512),
});

export const providerErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  502: errorEnvelopeSchema,
} as const;
