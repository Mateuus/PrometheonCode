import { z } from 'zod';
import {
  adminOrganizationSchema,
  auditLogSchema,
  changePasswordResponseSchema,
  conversationSchema,
  cursorPageSchema,
  deviceDecisionRequestSchema,
  deviceSessionSchema,
  deviceVerificationRequestSchema,
  deviceVerificationSchema,
  knowledgeItemSummarySchema,
  messageSchema,
  meResponseSchema,
  organizationMemberSchema,
  organizationWithAccessSchema,
  planSchema,
  presenceEntrySchema,
  projectSchema,
  sessionSchema,
  subscriptionOverviewSchema,
  taskSchema,
  updateProfileResponseSchema,
} from '@prometheon/contracts';

/**
 * Validação de runtime da fronteira com a Hub API.
 *
 * "Toda fronteira valida runtime" é regra do `Docs/03`: o que chega da rede é
 * desconhecido até passar por aqui. A maior parte dos schemas vem pronta de
 * `@prometheon/contracts` — o mesmo pacote que a API usa para se validar.
 *
 * Este arquivo só declara o que **não** está lá, e existe justamente para dar um
 * lugar único aos pontos em que a API real e o contrato publicado divergem:
 *
 * - `POST /v1/auth/register` responde `{ email, verificationEmailSent }`, e não
 *   o usuário criado — para o cadastro não virar oráculo de enumeração.
 * - `GET /v1/realtime/token` responde mais campos que `realtimeTokenResponseSchema`.
 * - `GET /v1/projects/:id/agents/active` usa um schema interno da hub-api.
 *
 * Nenhum schema usa `.strict()`: campo a mais na resposta é evolução da API, não
 * motivo para a tela quebrar. O servidor manda `aggregate` nos eventos ao vivo,
 * por exemplo, e o contrato público ainda não o descreve.
 */

// --------------------------------------------------------------- identidade

export { meResponseSchema, organizationWithAccessSchema };

export const organizationPageSchema = cursorPageSchema(organizationWithAccessSchema);
export const memberPageSchema = cursorPageSchema(organizationMemberSchema);

export const registerAcceptedSchema = z.object({
  email: z.string(),
  verificationEmailSent: z.boolean(),
});

/** `POST /v1/auth/login`. O refresh some do corpo quando vai para o cookie. */
export const loginResultSchema = z.object({
  user: meResponseSchema.shape.user,
  tokens: z.object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string().min(1),
    expiresIn: z.number().int().positive(),
    refreshToken: z.string().optional(),
    refreshExpiresIn: z.number().int().positive().optional(),
  }),
  sessionId: z.string(),
});

/** `POST /v1/auth/refresh`. */
export const refreshResultSchema = z.object({
  tokens: loginResultSchema.shape.tokens,
});

/**
 * `POST /v1/auth/switch-organization`.
 *
 * Mesma forma do login, e não por acaso: a API encerra a sessão anterior e abre
 * outra com o escopo pedido. O cookie do Hub Web precisa ser reescrito inteiro —
 * guardar só o access token novo deixaria um refresh já revogado no lugar.
 */
export const switchOrganizationResultSchema = loginResultSchema.extend({
  activeOrganizationId: z.string(),
});

/** `POST /v1/auth/verify-email`. */
export const verifyEmailResultSchema = z.object({ user: meResponseSchema.shape.user });

/** Respostas que só confirmam o comando (`{}`). */
export const emptyResultSchema = z.object({}).loose();

// ------------------------------------------------------------------- conta

export {
  changePasswordResponseSchema,
  deviceSessionSchema,
  sessionSchema,
  updateProfileResponseSchema,
};

/** `GET /v1/me/sessions`. */
export const sessionPageSchema = cursorPageSchema(sessionSchema);

/** `DELETE /v1/sessions/:id` — diz se a sessão derrubada era a desta aba. */
export const revokeSessionResultSchema = z.object({ current: z.boolean() });

/** `GET /v1/me/devices` — sem paginação: uma pessoa tem meia dúzia de máquinas. */
export const deviceSessionListSchema = z.object({ items: z.array(deviceSessionSchema) });

/** `DELETE /v1/devices/:id`. */
export const revokeDeviceResultSchema = z.object({ revoked: z.boolean() });

// --------------------------------------------------------------- device flow

/**
 * Passo 3 do device flow (`Docs/09`): a página `/device` mostra o pedido e
 * grava a decisão. Os schemas do pedido vêm prontos do contrato; o da resposta
 * da decisão é declarado aqui porque a API o define inline na rota
 * (`deviceDecisionEnvelope` em `apps/hub-api/src/modules/auth/schemas.ts`).
 */
export { deviceDecisionRequestSchema, deviceVerificationRequestSchema, deviceVerificationSchema };

export type DeviceVerification = z.infer<typeof deviceVerificationSchema>;

/**
 * `POST /v1/auth/device/decision`. O `status` é o estado que **ficou**, não um
 * eco da decisão enviada: repetir a chamada devolve o que já estava gravado.
 */
export const deviceDecisionResultSchema = z.object({
  status: z.enum(['approved', 'denied']),
});

// ------------------------------------------------------------------ domínio

export const projectPageSchema = cursorPageSchema(projectSchema);
export const conversationPageSchema = cursorPageSchema(conversationSchema);
export const messagePageSchema = cursorPageSchema(messageSchema);
export const taskPageSchema = cursorPageSchema(taskSchema);
export const knowledgePageSchema = cursorPageSchema(knowledgeItemSummarySchema);
export const auditPageSchema = cursorPageSchema(auditLogSchema);

export { projectSchema, conversationSchema, messageSchema, taskSchema, subscriptionOverviewSchema };

export const presenceListSchema = z.object({ entries: z.array(presenceEntrySchema) });

/** `GET /v1/projects/:id/agents/active` — schema interno da hub-api. */
export const activeAgentSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  kind: z.enum(['vscode', 'cli', 'ci', 'other']),
  platform: z.string().nullable(),
  clientVersion: z.string().nullable(),
  status: z.enum(['online', 'idle']),
  owner: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  activeAgentRunIds: z.array(z.string()),
  lastSeenAt: z.string(),
});

export const activeAgentListSchema = z.object({ agents: z.array(activeAgentSchema) });

// ------------------------------------------------------- administração

/** `GET /v1/admin/plans` — objeto com a lista dentro, não a lista solta. */
export const planListSchema = z.object({ plans: z.array(planSchema) });

/** `POST /v1/admin/plans` e `PATCH /v1/admin/plans/:code`. */
export const planResultSchema = z.object({ plan: planSchema });

export const adminOrganizationPageSchema = cursorPageSchema(adminOrganizationSchema);

/** Respostas que devolvem uma organização da visão administrativa. */
export const adminOrganizationResultSchema = z.object({
  organization: adminOrganizationSchema,
});

export { adminOrganizationSchema };

/** `PATCH /v1/organizations/:id` devolve a organização com o papel de quem edita. */
export const organizationUpdatedSchema = organizationWithAccessSchema;

/** `DELETE /v1/organizations/:id` — o que foi apagado, não o estado atual. */
export const organizationDeletedSchema = z.object({
  organization: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
});

// ------------------------------------------------------------------ realtime

/** `GET /v1/realtime/token`, no formato que a API realmente devolve. */
export const realtimeTicketSchema = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  expiresAt: z.string(),
  url: z.string(),
  protocolVersion: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
});
