// Chat: conversas do Web Chat, mensagens em envelope + partes, anexos,
// referências de contexto e resumos em camadas.
//
// O `Docs/07` é explícito: `messages` guarda o envelope e `message_parts` as
// partes ordenadas. Raciocínio privado de modelo não é gravado — só o resumo
// operacional permitido, na parte `reasoning_summary`.

import { EntitySchema } from 'typeorm';

import { workMode, type WorkMode } from './project.js';
import {
  auditColumns,
  createdAt,
  deletedAt,
  enumColumn,
  jsonColumn,
  organizationId,
  primaryId,
  requiredText,
  requiredUlidColumn,
  text,
  timestamps,
  ulidColumn,
  unsignedBigint,
  utcDatetime,
  version,
  type AuditFields,
  type TimestampFields,
} from './columns.js';

export const conversationStatus = ['active', 'archived', 'locked'] as const;
export type ConversationStatus = (typeof conversationStatus)[number];
export const conversationVisibility = ['private', 'project', 'organization'] as const;
export type ConversationVisibility = (typeof conversationVisibility)[number];
/** Origem da conversa. `local_import` veio do "Copy to Web Chat" (`Docs/10`). */
export const conversationOrigin = ['web', 'local_import', 'agent'] as const;
export type ConversationOrigin = (typeof conversationOrigin)[number];

export interface Conversation extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string | null;
  title: string;
  origin: ConversationOrigin;
  status: ConversationStatus;
  visibility: ConversationVisibility;
  workMode: WorkMode;
  lastSequence: number;
  messageCount: number;
  lastMessageAt: Date | null;
  deletedAt: Date | null;
}

export const conversations = new EntitySchema<Conversation>({
  name: 'conversations',
  tableName: 'conversations',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    // Conversa pode não pertencer a projeto algum (conversa da organização).
    projectId: ulidColumn('project_id'),
    title: requiredText('title', 255),
    origin: enumColumn('origin', conversationOrigin, { default: 'web' }),
    status: enumColumn('status', conversationStatus, { default: 'active' }),
    visibility: enumColumn('visibility', conversationVisibility, { default: 'project' }),
    workMode: enumColumn('work_mode', workMode, { default: 'plan' }),
    // Próximo número de sequência a ser usado; a aplicação incrementa dentro da
    // mesma transação da mensagem para manter `(conversation_id, sequence)`.
    lastSequence: unsignedBigint('last_sequence', { default: 0 }),
    messageCount: { type: 'int', name: 'message_count', nullable: false, default: 0 },
    lastMessageAt: utcDatetime('last_message_at'),
    ...auditColumns(),
    // Conversa apagada é recuperável dentro da janela de retenção.
    deletedAt: deletedAt(),
  },
  indices: [
    { name: 'idx_conversations_org_created_at', columns: ['organizationId', 'createdAt'] },
    {
      name: 'idx_conversations_project_status_updated_at',
      columns: ['projectId', 'status', 'updatedAt'],
    },
    { name: 'idx_conversations_project_last_message', columns: ['projectId', 'lastMessageAt'] },
  ],
});

/** Quem participa: pessoa ou perfil de agente. */
export const participantType = ['user', 'agent'] as const;
export type ParticipantType = (typeof participantType)[number];
export const participantRole = ['owner', 'member', 'observer'] as const;
export type ParticipantRole = (typeof participantRole)[number];

export interface ConversationParticipant extends TimestampFields {
  id: string;
  organizationId: string;
  conversationId: string;
  participantType: ParticipantType;
  participantId: string;
  role: ParticipantRole;
  lastReadSequence: number;
  joinedAt: Date | null;
  leftAt: Date | null;
  version: number;
}

export const conversationParticipants = new EntitySchema<ConversationParticipant>({
  name: 'conversation_participants',
  tableName: 'conversation_participants',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    conversationId: requiredUlidColumn('conversation_id'),
    participantType: enumColumn('participant_type', participantType),
    // Aponta para `users.id` ou `agent_profiles.id` conforme o tipo. É uma
    // referência polimórfica: sem chave estrangeira, com unique natural.
    participantId: requiredUlidColumn('participant_id'),
    role: enumColumn('role', participantRole, { default: 'member' }),
    // Até onde este participante leu — base do contador de não lidas.
    lastReadSequence: unsignedBigint('last_read_sequence', { default: 0 }),
    joinedAt: utcDatetime('joined_at'),
    leftAt: utcDatetime('left_at'),
    ...timestamps(),
    version: version(),
  },
  uniques: [
    {
      name: 'uq_conversation_participants',
      columns: ['conversationId', 'participantType', 'participantId'],
    },
  ],
  indices: [
    {
      name: 'idx_conversation_participants_participant',
      columns: ['participantId', 'participantType'],
    },
  ],
});

export const messageAuthorType = ['user', 'agent', 'system'] as const;
export type MessageAuthorType = (typeof messageAuthorType)[number];
export const messageStatus = [
  'pending',
  'streaming',
  'complete',
  'failed',
  'cancelled',
  'redacted',
] as const;
export type MessageStatus = (typeof messageStatus)[number];

export interface Message extends TimestampFields {
  id: string;
  organizationId: string;
  conversationId: string;
  authorType: MessageAuthorType;
  authorUserId: string | null;
  authorAgentRunId: string | null;
  status: MessageStatus;
  sequence: number;
  parentMessageId: string | null;
  version: number;
  deletedAt: Date | null;
}

export const messages = new EntitySchema<Message>({
  name: 'messages',
  tableName: 'messages',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    conversationId: requiredUlidColumn('conversation_id'),
    authorType: enumColumn('author_type', messageAuthorType),
    authorUserId: ulidColumn('author_user_id'),
    // Sem chave estrangeira para `agent_runs`: a orquestração referencia o chat
    // e a volta fecharia um ciclo entre os módulos do schema.
    authorAgentRunId: ulidColumn('author_agent_run_id'),
    status: enumColumn('status', messageStatus, { default: 'complete' }),
    // Ordem estável dentro da conversa, exigida pelo índice do `Docs/07`.
    sequence: unsignedBigint('sequence'),
    parentMessageId: ulidColumn('parent_message_id'),
    ...timestamps(),
    version: version(),
    // Mensagem apagada continua recuperável enquanto a conversa existir.
    deletedAt: deletedAt(),
  },
  uniques: [
    { name: 'uq_messages_conversation_sequence', columns: ['conversationId', 'sequence'] },
  ],
  indices: [
    { name: 'idx_messages_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_messages_conversation_created_at', columns: ['conversationId', 'createdAt'] },
    { name: 'idx_messages_author_user', columns: ['authorUserId', 'createdAt'] },
  ],
});

/** Tipos de parte previstos no `Docs/07`. */
export const messagePartType = [
  'text',
  'reasoning_summary',
  'tool_call',
  'tool_result',
  'artifact_reference',
  'task_reference',
  'error',
] as const;
export type MessagePartType = (typeof messagePartType)[number];

export interface MessagePart {
  id: string;
  organizationId: string;
  messageId: string;
  sequence: number;
  type: MessagePartType;
  content: string | null;
  payload: Record<string, unknown> | null;
  toolName: string | null;
  tokenCount: number | null;
  createdAt: Date;
}

export const messageParts = new EntitySchema<MessagePart>({
  name: 'message_parts',
  tableName: 'message_parts',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    messageId: requiredUlidColumn('message_id'),
    sequence: { type: 'int', name: 'sequence', nullable: false },
    type: enumColumn('type', messagePartType),
    // Conteúdo textual da parte. Em `reasoning_summary` guarda o resumo
    // operacional permitido — nunca a cadeia de raciocínio bruta do modelo.
    content: { type: 'mediumtext', name: 'content', nullable: true },
    // Dados estruturados: argumentos de ferramenta, resultado, referência.
    payload: jsonColumn('payload'),
    toolName: text('tool_name', 128),
    tokenCount: { type: 'int', name: 'token_count', nullable: true },
    createdAt: createdAt(),
  },
  uniques: [
    { name: 'uq_message_parts_message_sequence', columns: ['messageId', 'sequence'] },
  ],
  indices: [{ name: 'idx_message_parts_org_created_at', columns: ['organizationId', 'createdAt'] }],
});

export const attachmentScanStatus = ['pending', 'clean', 'rejected'] as const;
export type AttachmentScanStatus = (typeof attachmentScanStatus)[number];

export interface MessageAttachment extends AuditFields {
  id: string;
  organizationId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  checksumSha256: string;
  scanStatus: AttachmentScanStatus;
}

export const messageAttachments = new EntitySchema<MessageAttachment>({
  name: 'message_attachments',
  tableName: 'message_attachments',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    messageId: requiredUlidColumn('message_id'),
    fileName: requiredText('file_name', 255),
    mimeType: requiredText('mime_type', 191),
    sizeBytes: unsignedBigint('size_bytes'),
    // Chave no storage isolado; o binário nunca fica no MySQL.
    storageKey: requiredText('storage_key', 512),
    checksumSha256: requiredText('checksum_sha256', 64),
    scanStatus: enumColumn('scan_status', attachmentScanStatus, { default: 'pending' }),
    ...auditColumns(),
  },
  indices: [
    { name: 'idx_message_attachments_message', columns: ['messageId'] },
    { name: 'idx_message_attachments_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

/** O que o Context Package trouxe junto da mensagem (`Docs/10`). */
export const contextRefType = [
  'file',
  'diff',
  'knowledge_item',
  'task',
  'artifact',
  'graph_node',
  'commit',
  'url',
] as const;
export type ContextRefType = (typeof contextRefType)[number];

export interface MessageContextRef {
  id: string;
  organizationId: string;
  messageId: string;
  refType: ContextRefType;
  refId: string;
  label: string | null;
  revision: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export const messageContextRefs = new EntitySchema<MessageContextRef>({
  name: 'message_context_refs',
  tableName: 'message_context_refs',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    messageId: requiredUlidColumn('message_id'),
    refType: enumColumn('ref_type', contextRefType),
    // Identificador da referência no seu próprio domínio (caminho, ULID, URL).
    refId: requiredText('ref_id', 512),
    label: text('label', 255),
    // Revisão/commit/linha que fixa o que foi enviado — o Hub minimiza código,
    // então guardamos o ponteiro, não o conteúdo.
    revision: text('revision', 191),
    metadata: jsonColumn('metadata'),
    createdAt: createdAt(),
  },
  indices: [
    { name: 'idx_message_context_refs_message', columns: ['messageId', 'refType'] },
    { name: 'idx_message_context_refs_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

/** Camadas do resumo em `Docs/10`. */
export const summaryLayer = [
  'current_summary',
  'decisions',
  'facts',
  'tasks',
  'open_questions',
  'references',
] as const;
export type SummaryLayer = (typeof summaryLayer)[number];

export interface ConversationSummary extends AuditFields {
  id: string;
  organizationId: string;
  conversationId: string;
  layer: SummaryLayer;
  fromSequence: number;
  toSequence: number;
  content: string;
  sourceMessageIds: string[] | null;
  model: string | null;
  tokenCount: number | null;
}

export const conversationSummaries = new EntitySchema<ConversationSummary>({
  name: 'conversation_summaries',
  tableName: 'conversation_summaries',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    conversationId: requiredUlidColumn('conversation_id'),
    layer: enumColumn('layer', summaryLayer),
    fromSequence: unsignedBigint('from_sequence'),
    toSequence: unsignedBigint('to_sequence'),
    content: { type: 'mediumtext', name: 'content', nullable: false },
    // IDs das mensagens que sustentam o resumo: auditoria e recuperação.
    sourceMessageIds: jsonColumn('source_message_ids'),
    model: text('model', 128),
    tokenCount: { type: 'int', name: 'token_count', nullable: true },
    ...auditColumns(),
  },
  indices: [
    {
      name: 'idx_conversation_summaries_conversation',
      columns: ['conversationId', 'layer', 'toSequence'],
    },
    {
      name: 'idx_conversation_summaries_org_created_at',
      columns: ['organizationId', 'createdAt'],
    },
  ],
});
