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
  /**
   * Administra o Hub inteiro — planos, limites e a lista de organizações.
   *
   * Não é papel de organização: quem tem esta marca opera a plataforma, e a
   * concessão acontece fora da aplicação (`db:grant-admin`). O padrão é falso
   * para que um cliente conversando com uma API mais antiga nunca conclua que
   * está diante de um administrador.
   */
  isPlatformAdmin: z.boolean().default(false),
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

/**
 * Troca de senha feita de dentro da sessão.
 *
 * A senha atual é exigida mesmo com a pessoa já autenticada: sessão sequestrada
 * não pode virar conta sequestrada. Quem só tem o access token roubado não
 * consegue trocar a senha e trancar o dono do lado de fora.
 */
export const changePasswordRequestSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/**
 * Resultado da troca.
 *
 * `revokedSessions` conta as **outras** sessões derrubadas — a de quem trocou
 * continua de pé. O número existe para a interface poder dizer quantos acessos
 * caíram, que é a confirmação de que a troca teve efeito.
 */
export const changePasswordResponseSchema = z.object({
  revokedSessions: z.int().nonnegative(),
  /**
   * Dispositivos desconectados — **todos**, sem exceção.
   *
   * A extensão no VS Code é uma porta como as outras, e mais durável: a
   * credencial dela vale 90 dias. Deixá-la aberta faria a troca prometer mais do
   * que entrega. A interface mostra o número porque quem trocou a senha precisa
   * saber que vai ter de entrar de novo no editor.
   */
  revokedDevices: z.int().nonnegative(),
});

export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

/** Etiqueta de idioma no formato BCP 47 (`en`, `pt-BR`, `es-419`). */
export const localeSchema = z
  .string()
  .trim()
  .max(10)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, {
    message: 'must be a BCP 47 language tag',
  });

/**
 * Fuso horário IANA (`America/Sao_Paulo`).
 *
 * A regex só garante a forma; se o identificador existe de verdade é o servidor
 * que decide, contra a base de fusos do runtime — uma lista fixa aqui
 * envelheceria a cada revisão da IANA.
 */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/, {
    message: 'must be an IANA time zone name',
  });

/**
 * Endereço da imagem de perfil.
 *
 * Só `http` e `https`: `javascript:` e `data:` numa URL que a interface coloca
 * em `<img src>` são vetor de execução no cliente, e a validação do esquema é o
 * lugar mais barato para fechar isso.
 */
export const avatarUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(1024);

/**
 * Edição do próprio perfil.
 *
 * **E-mail não entra aqui.** Trocar o endereço exige provar posse do novo antes
 * de o antigo perder valor — é um fluxo com token de verificação e período em
 * que os dois endereços convivem, não um campo de formulário. Enquanto esse
 * fluxo não existe, o campo fica de fora em vez de existir pela metade.
 *
 * Todos os campos são opcionais e o que não vier permanece como está; `null` em
 * `avatarUrl` é o pedido explícito de remover a imagem.
 */
export const updateProfileRequestSchema = z.object({
  name: displayNameSchema.optional(),
  locale: localeSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  avatarUrl: avatarUrlSchema.nullable().optional(),
});

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const updateProfileResponseSchema = z.object({
  user: currentUserSchema,
});

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

/**
 * Uma sessão na lista da própria conta.
 *
 * O conjunto de campos é escolhido para responder "eu reconheço este acesso?" e
 * nada além disso. Em particular:
 *
 * - **não há `userAgent` cru.** A string completa identifica versão de
 *   navegador e de sistema com precisão suficiente para servir de impressão
 *   digital, e não ajuda ninguém a reconhecer a própria sessão melhor que
 *   "Chrome no Windows". O que vai é o rótulo derivado, em `clientName`.
 * - **`ipAddress` vai truncado.** O endereço inteiro transforma a lista num
 *   histórico de localização de quem quer que consiga ler a tela — inclusive
 *   quem sequestrou a sessão. A rede é o bastante para a pessoa distinguir
 *   "isto foi de casa" de "isto não fui eu".
 */
export const sessionSchema = z.object({
  id: ulidSchema,
  /** Rótulo legível: nome do dispositivo, ou navegador e sistema. */
  clientName: shortTextSchema.nullable(),
  /** Rede de origem, não o endereço exato: `203.0.113.0` ou `2001:db8::`. */
  ipAddress: z.string().max(45).nullable(),
  /**
   * Verdadeiro na sessão que está fazendo a chamada.
   *
   * Sem esta marca, revogar a própria sessão achando que era a de outro
   * aparelho é o erro mais fácil de cometer nesta tela.
   */
  current: z.boolean(),
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionPageSchema = cursorPageSchema(sessionSchema);

export type SessionPage = z.infer<typeof sessionPageSchema>;

/**
 * Um dispositivo conectado — hoje, a extensão do VS Code.
 *
 * Anda ao lado das sessões porque responde à mesma pergunta: onde eu estou
 * logado? Duas telas separadas fariam alguém fechar as sessões, achar que
 * terminou, e deixar o editor conectado com uma credencial de 90 dias.
 *
 * Vale a mesma regra de privacidade das sessões: nada de impressão digital do
 * cliente, e o endereço vai truncado na rede.
 */
export const deviceSessionSchema = z.object({
  id: ulidSchema,
  /** Nome que o próprio dispositivo declarou no registro. */
  name: shortTextSchema,
  platform: z.string().max(32),
  client: z.string().max(64),
  clientVersion: z.string().max(32).nullable(),
  /** Rede de origem do último acesso, não o endereço exato. */
  ipAddress: z.string().max(45).nullable(),
  lastSeenAt: isoDateTimeSchema.nullable(),
  connectedAt: isoDateTimeSchema,
  /**
   * Quando a credencial deixa de valer por conta própria.
   *
   * É o que diferencia "esqueci este notebook conectado" de "isto expira
   * sozinho semana que vem" — e portanto se vale a pena revogar agora.
   */
  credentialExpiresAt: isoDateTimeSchema.nullable(),
});

export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export const deviceSessionListSchema = z.object({
  items: z.array(deviceSessionSchema),
});

export type DeviceSessionList = z.infer<typeof deviceSessionListSchema>;

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
