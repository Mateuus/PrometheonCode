import { z } from 'zod';
import {
  auditLogSchema,
  conversationSchema,
  cursorPageSchema,
  knowledgeItemSummarySchema,
  messageSchema,
  meResponseSchema,
  organizationMemberSchema,
  organizationWithAccessSchema,
  planSchema,
  presenceEntrySchema,
  projectSchema,
  subscriptionOverviewSchema,
  taskSchema,
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

/** `POST /v1/auth/verify-email`. */
export const verifyEmailResultSchema = z.object({ user: meResponseSchema.shape.user });

/** Respostas que só confirmam o comando (`{}`). */
export const emptyResultSchema = z.object({}).loose();

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

/** `GET /v1/admin/plans` — objeto com a lista dentro, não a lista solta. */
export const planListSchema = z.object({ plans: z.array(planSchema) });

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
