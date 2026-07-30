/**
 * Autenticação (`Docs/09`): registro, login, refresh, logout, `me`,
 * verificação de e-mail, recuperação de senha e device flow.
 *
 * Nenhum schema daqui carrega hash, salt ou segredo do servidor: o que trafega
 * é token opaco ou JWT, e senha só sobe, nunca desce.
 */

import { z } from 'zod';

import { cursorPageSchema } from './pagination.js';
import { organizationRoleSchema } from './permissions.js';
import {
  emailSchema,
  isoDateTimeSchema,
  shortTextSchema,
  slugSchema,
  ulidSchema,
} from './primitives.js';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Senha do usuário. O comprimento mínimo é a única regra estrutural — listas de
 * "um número e um símbolo" empurram para senhas piores. A força real é medida
 * no servidor contra vazamentos conhecidos.
 */
export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH)
  .max(MAX_PASSWORD_LENGTH);

export const displayNameSchema = z.string().trim().min(1).max(120);

/** Token opaco emitido pelo Hub (verificação, convite, recuperação). */
export const opaqueTokenSchema = z.string().min(16).max(512);

export const publicUserSchema = z.object({
  id: ulidSchema,
  name: displayNameSchema,
  email: emailSchema,
  avatarUrl: z.url().nullable(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const currentUserSchema = publicUserSchema.extend({
  emailVerified: z.boolean(),
  locale: z.string().min(2).max(10),
  timeZone: z.string().min(1).max(64),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/** Organização vista de dentro da sessão, com o papel do usuário. */
export const sessionOrganizationSchema = z.object({
  id: ulidSchema,
  name: shortTextSchema,
  slug: slugSchema,
  role: organizationRoleSchema,
});

export const meResponseSchema = z.object({
  user: currentUserSchema,
  organizations: z.array(sessionOrganizationSchema),
  /** Organização ativa da sessão, quando houver mais de uma. */
  activeOrganizationId: ulidSchema.nullable(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const tokenPairSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().min(1),
  /** Vida do access token em segundos. */
  expiresIn: z.int().positive(),
  /**
   * Ausente quando o refresh viaja em cookie `HttpOnly` — é o caso do Hub Web.
   */
  refreshToken: z.string().min(1).optional(),
  refreshExpiresIn: z.int().positive().optional(),
});

export type TokenPair = z.infer<typeof tokenPairSchema>;

export const registerRequestSchema = z.object({
  name: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
  /** Cria a primeira organização junto da conta. */
  organizationName: shortTextSchema.optional(),
  /** Entra numa organização existente em vez de criar uma. */
  invitationToken: opaqueTokenSchema.optional(),
  acceptedTerms: z.literal(true),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Resposta do registro: `202 Accepted`, sem dizer o que aconteceu com a conta.
 *
 * Devolver o usuário criado seria um oráculo de enumeração — quem recebe o
 * objeto sabe que aquele e-mail não existia antes, e quem recebe um erro sabe
 * que existe. Por isso a resposta é a mesma nos dois casos: o Hub aceitou o
 * pedido e, **se** houver conta a criar ou confirmar, o e-mail sai.
 *
 * O `email` volta só para a interface conseguir dizer "enviamos para você@…".
 */
export const registerResponseSchema = z.object({
  email: emailSchema,
  /** Sempre `true` no caminho normal; não revela se a conta já existia. */
  verificationEmailSent: z.boolean(),
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** Rótulo mostrado na lista de sessões do usuário. */
  clientName: shortTextSchema.optional(),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  user: currentUserSchema,
  tokens: tokenPairSchema,
  sessionId: ulidSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshRequestSchema = z.object({
  /** Omitido quando o refresh chega pelo cookie `HttpOnly`. */
  refreshToken: z.string().min(1).optional(),
});

export const refreshResponseSchema = z.object({
  tokens: tokenPairSchema,
});

/**
 * Troca a organização ativa da sessão.
 *
 * O claim `org` do access token é fixado quando a sessão nasce, e nada no token
 * pode ser reescrito sem reemiti-lo. Por isso a troca não é um `PATCH` num
 * recurso: é um pedido de credencial nova, com o escopo pedido, que o servidor
 * só atende depois de conferir a associação. O cliente manda o identificador da
 * organização; quem decide se ele vale é o servidor.
 */
export const switchOrganizationRequestSchema = z.object({
  organizationId: ulidSchema,
});

export type SwitchOrganizationRequest = z.infer<
  typeof switchOrganizationRequestSchema
>;

/**
 * A resposta tem a mesma forma do login — e por um motivo: a troca **encerra a
 * sessão anterior e abre outra**. O `sessionId` muda, o par de tokens muda, e o
 * cliente precisa substituir os dois. Devolver só o access token esconderia que
 * o refresh antigo deixou de existir.
 */
export const switchOrganizationResponseSchema = z.object({
  user: currentUserSchema,
  tokens: tokenPairSchema,
  sessionId: ulidSchema,
  /** Organização que passou a valer; sempre igual à pedida. */
  activeOrganizationId: ulidSchema,
});

export type SwitchOrganizationResponse = z.infer<
  typeof switchOrganizationResponseSchema
>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1).optional(),
  /** Derruba todas as sessões do usuário, não só a atual. */
  allSessions: z.boolean().default(false),
});

export const verifyEmailRequestSchema = z.object({
  token: opaqueTokenSchema,
});

export const resendVerificationRequestSchema = z.object({
  email: emailSchema,
});

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});

export const passwordResetConfirmSchema = z.object({
  token: opaqueTokenSchema,
  password: passwordSchema,
});

export const changePasswordRequestSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export const sessionSchema = z.object({
  id: ulidSchema,
  clientName: shortTextSchema.nullable(),
  ipAddress: z.string().max(45).nullable(),
  userAgent: z.string().max(512).nullable(),
  current: z.boolean(),
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionPageSchema = cursorPageSchema(sessionSchema);

// ---------------------------------------------------------------------------
// Device flow (`Docs/09`): a extensão pede um código, o usuário autoriza no
// navegador e a extensão faz polling até receber a credencial do dispositivo.
// ---------------------------------------------------------------------------

export const DEVICE_KINDS = ['vscode', 'cli', 'ci', 'other'] as const;

export const deviceKindSchema = z.enum(DEVICE_KINDS);

export type DeviceKind = z.infer<typeof deviceKindSchema>;

export const deviceAuthorizationRequestSchema = z.object({
  deviceName: shortTextSchema,
  deviceKind: deviceKindSchema,
  /** Versão da extensão ou da CLI que está pedindo autorização. */
  clientVersion: z.string().max(64).optional(),
  platform: z.string().max(64).optional(),
});

export type DeviceAuthorizationRequest = z.infer<
  typeof deviceAuthorizationRequestSchema
>;

export const deviceAuthorizationResponseSchema = z.object({
  /** Segredo que a extensão troca por credencial; nunca é mostrado ao usuário. */
  deviceCode: z.string().min(16).max(512),
  /** Código curto que o usuário digita no navegador. */
  userCode: z.string().min(6).max(16),
  verificationUri: z.url(),
  verificationUriComplete: z.url(),
  expiresIn: z.int().positive(),
  /** Intervalo mínimo entre chamadas de polling, em segundos. */
  interval: z.int().positive(),
});

export type DeviceAuthorizationResponse = z.infer<
  typeof deviceAuthorizationResponseSchema
>;

export const deviceTokenRequestSchema = z.object({
  deviceCode: z.string().min(16).max(512),
});

export const deviceCredentialSchema = z.object({
  deviceId: ulidSchema,
  /** Guardado em `SecretStorage`/Keychain, jamais em arquivo do projeto. */
  deviceToken: z.string().min(1),
  expiresAt: isoDateTimeSchema.nullable(),
  organizationId: ulidSchema,
  user: publicUserSchema,
});

export type DeviceCredential = z.infer<typeof deviceCredentialSchema>;

/** Passo do navegador: o usuário confere o código e aprova ou nega. */
export const deviceVerificationRequestSchema = z.object({
  userCode: z.string().min(6).max(16),
});

export const deviceVerificationSchema = z.object({
  deviceName: shortTextSchema,
  deviceKind: deviceKindSchema,
  platform: z.string().max(64).nullable(),
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export const deviceDecisionRequestSchema = z.object({
  userCode: z.string().min(6).max(16),
  decision: z.enum(['approve', 'deny']),
  organizationId: ulidSchema,
});

export const realtimeTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresIn: z.int().positive(),
  url: z.string().min(1),
});

export type RealtimeTokenResponse = z.infer<typeof realtimeTokenResponseSchema>;
