/**
 * Mensagens: envelope e partes ordenadas (`Docs/07`).
 *
 * O envelope guarda autoria, estado e sequência; as partes guardam o conteúdo,
 * cada uma com seu tipo. `reasoning_summary` é resumo operacional permitido —
 * raciocínio privado do modelo não é salvo, é regra do `Docs/07`.
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import {
  idempotencyKeySchema,
  isoDateTimeSchema,
  longTextSchema,
  metadataSchema,
  shortTextSchema,
  ulidSchema,
} from './primitives.js';

export const MESSAGE_PART_TYPES = [
  'text',
  'reasoning_summary',
  'tool_call',
  'tool_result',
  'artifact_reference',
  'task_reference',
  'error',
] as const;

export const messagePartTypeSchema = z.enum(MESSAGE_PART_TYPES);

export type MessagePartType = z.infer<typeof messagePartTypeSchema>;

const partBase = {
  /** Posição da parte dentro da mensagem, começando em zero. */
  index: z.int().nonnegative(),
};

export const textPartSchema = z.object({
  ...partBase,
  type: z.literal('text'),
  text: longTextSchema,
});

export const reasoningSummaryPartSchema = z.object({
  ...partBase,
  type: z.literal('reasoning_summary'),
  summary: longTextSchema,
});

export const toolCallPartSchema = z.object({
  ...partBase,
  type: z.literal('tool_call'),
  toolCallId: z.string().min(1).max(128),
  toolName: shortTextSchema,
  /** Argumentos já validados pelo Core; nunca inclua segredo aqui. */
  arguments: metadataSchema,
});

export const toolResultPartSchema = z.object({
  ...partBase,
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1).max(128),
  status: z.enum(['ok', 'error', 'denied', 'timeout']),
  result: metadataSchema.nullable(),
  /** Saída textual truncada para caber no limite de payload. */
  output: longTextSchema.nullable(),
});

export const artifactReferencePartSchema = z.object({
  ...partBase,
  type: z.literal('artifact_reference'),
  artifactId: ulidSchema,
  kind: z.enum(['diff', 'file', 'log', 'report', 'other']),
  title: shortTextSchema,
  byteSize: z.int().nonnegative(),
});

export const taskReferencePartSchema = z.object({
  ...partBase,
  type: z.literal('task_reference'),
  taskId: ulidSchema,
  relation: z.enum(['created', 'updated', 'mentioned', 'blocked_by']),
});

export const errorPartSchema = z.object({
  ...partBase,
  type: z.literal('error'),
  code: shortTextSchema,
  message: longTextSchema,
  retryable: z.boolean(),
});

export const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  reasoningSummaryPartSchema,
  toolCallPartSchema,
  toolResultPartSchema,
  artifactReferencePartSchema,
  taskReferencePartSchema,
  errorPartSchema,
]);

export type MessagePart = z.infer<typeof messagePartSchema>;

export const MESSAGE_AUTHOR_TYPES = ['user', 'agent', 'system'] as const;

export const messageAuthorTypeSchema = z.enum(MESSAGE_AUTHOR_TYPES);

export type MessageAuthorType = z.infer<typeof messageAuthorTypeSchema>;

/**
 * `redacted` fecha o ciclo da retenção do `Docs/09`: a mensagem removida por
 * política continua existindo como envelope, com as partes apagadas. Sem este
 * valor no contrato, o serializador quebraria justamente na mensagem que a
 * organização mandou apagar.
 */
export const MESSAGE_STATUSES = [
  'pending',
  'streaming',
  'complete',
  'failed',
  'cancelled',
  'redacted',
] as const;

export const messageStatusSchema = z.enum(MESSAGE_STATUSES);

export type MessageStatus = z.infer<typeof messageStatusSchema>;

/**
 * Referência de contexto anexada à mensagem — o que o Context Package mostrou
 * ao usuário antes do envio (`Docs/09`).
 */
export const messageContextRefSchema = z.object({
  kind: z.enum(['file', 'selection', 'knowledge', 'task', 'conversation', 'url']),
  /** Caminho, ULID ou URL, conforme o `kind`. */
  reference: z.string().min(1).max(2048),
  label: shortTextSchema.nullable(),
});

export type MessageContextRef = z.infer<typeof messageContextRefSchema>;

export const messageAttachmentSchema = z.object({
  id: ulidSchema,
  fileName: shortTextSchema,
  contentType: z.string().min(1).max(255),
  byteSize: z.int().nonnegative(),
  downloadUrl: z.url().nullable(),
});

export const messageSchema = z.object({
  id: ulidSchema,
  conversationId: ulidSchema,
  organizationId: ulidSchema,
  authorType: messageAuthorTypeSchema,
  authorUser: publicUserSchema.nullable(),
  authorAgentRunId: ulidSchema.nullable(),
  status: messageStatusSchema,
  /** Ordem estável dentro da conversa; é também o cursor de retomada. */
  sequence: z.int().nonnegative(),
  parts: z.array(messagePartSchema),
  contextRefs: z.array(messageContextRefSchema),
  attachments: z.array(messageAttachmentSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Message = z.infer<typeof messageSchema>;

/** Partes aceitas na criação: sem `index`, que o servidor atribui. */
export const createMessagePartSchema = z.discriminatedUnion('type', [
  textPartSchema.omit({ index: true }),
  reasoningSummaryPartSchema.omit({ index: true }),
  toolCallPartSchema.omit({ index: true }),
  toolResultPartSchema.omit({ index: true }),
  artifactReferencePartSchema.omit({ index: true }),
  taskReferencePartSchema.omit({ index: true }),
  errorPartSchema.omit({ index: true }),
]);

/**
 * Uma parte na entrada, já sem `index`.
 *
 * O tipo é derivado do schema em vez de montado com `Omit<MessagePart,
 * 'index'>`: `Omit` sobre união discriminada colapsa os membros e o
 * `switch (part.type)` deixa de estreitar o tipo.
 */
export type CreateMessagePart = z.infer<typeof createMessagePartSchema>;

export const createMessageRequestSchema = z.object({
  /**
   * Quem assina a mensagem. Faltava no contrato, e sem ele o envelope de
   * `messages.author_type` não teria como ser preenchido pela API. `system` não
   * é aceito na entrada: mensagem de sistema é escrita pelo servidor, e deixar
   * o cliente forjá-la apagaria a diferença entre o que o Hub afirma e o que
   * alguém digitou.
   */
  authorType: z.enum(['user', 'agent']).default('user'),
  /** Execução do agente que assina, obrigatória quando `authorType` é `agent`. */
  authorAgentRunId: ulidSchema.optional(),
  parts: z.array(createMessagePartSchema).min(1).max(64),
  contextRefs: z.array(messageContextRefSchema).max(64).default([]),
  attachmentIds: z.array(ulidSchema).max(16).default([]),
  /** Evita mensagem duplicada quando o cliente repete a chamada. */
  idempotencyKey: idempotencyKeySchema.optional(),
});

export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;

export const messageListQuerySchema = cursorPageQuerySchema.extend({
  /** Retoma a partir de uma sequência conhecida, após perder a janela do WS. */
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  authorType: messageAuthorTypeSchema.optional(),
});

export const messagePageSchema = cursorPageSchema(messageSchema);
