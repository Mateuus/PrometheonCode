/**
 * Conversas (`Docs/06`, `Docs/07`).
 *
 * O chat local do Core não sincroniza sozinho (`Docs/09`): a conversa só existe
 * aqui depois que o usuário escolhe mover ou copiar para o Web Chat, e o campo
 * `origin` registra de onde ela veio.
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import { workModeSchema } from './projects.js';
import {
  isoDateTimeSchema,
  longTextSchema,
  shortTextSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

/**
 * Situação da conversa. Os três valores são os do `Docs/07`: `locked` existe
 * para a conversa que foi encerrada por política e não aceita mais escrita,
 * distinta de `archived`, que só sai da lista ativa.
 */
export const CONVERSATION_STATUSES = ['active', 'archived', 'locked'] as const;

export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);

/**
 * Origem da conversa (`Docs/07`). `local_import` é o "Copy to Web Chat" do
 * `Docs/10` — o Local Chat não sincroniza sozinho, então a origem registra que
 * o conteúdo veio de uma decisão explícita do usuário.
 */
export const CONVERSATION_ORIGINS = ['web', 'local_import', 'agent'] as const;

export const conversationOriginSchema = z.enum(CONVERSATION_ORIGINS);

export type ConversationOrigin = z.infer<typeof conversationOriginSchema>;

export const conversationParticipantSchema = z.object({
  id: ulidSchema,
  kind: z.enum(['user', 'agent']),
  user: publicUserSchema.nullable(),
  /** Perfil do agente participante, quando `kind` é `agent`. */
  agentProfileId: ulidSchema.nullable(),
  joinedAt: isoDateTimeSchema,
});

export type ConversationParticipant = z.infer<
  typeof conversationParticipantSchema
>;

export const conversationSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  projectId: ulidSchema,
  title: shortTextSchema,
  status: conversationStatusSchema,
  origin: conversationOriginSchema,
  workMode: workModeSchema,
  participants: z.array(conversationParticipantSchema),
  /** Sequência da última mensagem; serve de cursor de retomada. */
  lastSequence: z.int().nonnegative(),
  lastMessageAt: isoDateTimeSchema.nullable(),
  messageCount: z.int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  createdBy: ulidSchema,
  version: versionSchema,
});

export type Conversation = z.infer<typeof conversationSchema>;

export const createConversationRequestSchema = z.object({
  title: shortTextSchema.optional(),
  origin: conversationOriginSchema.default('web'),
  /** Modo de trabalho da conversa; sem ele vale o padrão do projeto. */
  workMode: workModeSchema.optional(),
  /** Perfis de agente que já entram na conversa. */
  agentProfileIds: z.array(ulidSchema).max(10).default([]),
  /** Primeira mensagem, quando a conversa já nasce com conteúdo. */
  initialMessage: longTextSchema.optional(),
});

export type CreateConversationRequest = z.infer<
  typeof createConversationRequestSchema
>;

export const updateConversationRequestSchema = z.object({
  title: shortTextSchema.optional(),
  status: conversationStatusSchema.optional(),
  version: versionSchema,
});

export const conversationListQuerySchema = cursorPageQuerySchema.extend({
  status: conversationStatusSchema.optional(),
  origin: conversationOriginSchema.optional(),
  search: z.string().trim().max(120).optional(),
});

export const conversationPageSchema = cursorPageSchema(conversationSchema);

/**
 * Resumo operacional de trecho antigo da conversa, produzido pelo job de
 * `context-summarization`. Não guarda raciocínio privado do modelo.
 */
export const conversationSummarySchema = z.object({
  id: ulidSchema,
  conversationId: ulidSchema,
  fromSequence: z.int().nonnegative(),
  toSequence: z.int().nonnegative(),
  summary: longTextSchema,
  createdAt: isoDateTimeSchema,
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
