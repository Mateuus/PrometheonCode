// Chat: conversas do Web Chat, mensagens em envelope + partes, anexos,
// referências de contexto e resumos em camadas.
//
// O `Docs/07` é explícito: `messages` guarda o envelope e `message_parts` as
// partes ordenadas. Raciocínio privado de modelo não é gravado — só o resumo
// operacional permitido, na parte `reasoning_summary`.

import {
  bigint,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

import { projects, workMode } from './project.js';
import { organizations } from './organization.js';
import { users } from './identity.js';
import {
  auditColumns,
  createdAt,
  deletedAt,
  organizationId,
  primaryId,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
} from './columns.js';

export const conversationStatus = ['active', 'archived', 'locked'] as const;
export const conversationVisibility = ['private', 'project', 'organization'] as const;
/** Origem da conversa. `local_import` veio do "Copy to Web Chat" (`Docs/10`). */
export const conversationOrigin = ['web', 'local_import', 'agent'] as const;

export const conversations = mysqlTable(
  'conversations',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    // Conversa pode não pertencer a projeto algum (conversa da organização).
    projectId: ulidColumn('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    origin: mysqlEnum('origin', conversationOrigin).notNull().default('web'),
    status: mysqlEnum('status', conversationStatus).notNull().default('active'),
    visibility: mysqlEnum('visibility', conversationVisibility).notNull().default('project'),
    workMode: mysqlEnum('work_mode', workMode).notNull().default('plan'),
    // Próximo número de sequência a ser usado; a aplicação incrementa dentro da
    // mesma transação da mensagem para manter `(conversation_id, sequence)`.
    lastSequence: bigint('last_sequence', { mode: 'number', unsigned: true }).notNull().default(0),
    messageCount: int('message_count').notNull().default(0),
    lastMessageAt: utcDatetime('last_message_at'),
    ...auditColumns(),
    // Conversa apagada é recuperável dentro da janela de retenção.
    deletedAt: deletedAt(),
  },
  (table) => [
    index('idx_conversations_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_conversations_project_status_updated_at').on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
    index('idx_conversations_project_last_message').on(table.projectId, table.lastMessageAt),
  ],
);

/** Quem participa: pessoa ou perfil de agente. */
export const participantType = ['user', 'agent'] as const;
export const participantRole = ['owner', 'member', 'observer'] as const;

export const conversationParticipants = mysqlTable(
  'conversation_participants',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: ulidColumn('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    participantType: mysqlEnum('participant_type', participantType).notNull(),
    // Aponta para `users.id` ou `agent_profiles.id` conforme o tipo. É uma
    // referência polimórfica: sem chave estrangeira, com unique natural.
    participantId: ulidColumn('participant_id').notNull(),
    role: mysqlEnum('role', participantRole).notNull().default('member'),
    // Até onde este participante leu — base do contador de não lidas.
    lastReadSequence: bigint('last_read_sequence', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    joinedAt: utcDatetime('joined_at'),
    leftAt: utcDatetime('left_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_conversation_participants').on(
      table.conversationId,
      table.participantType,
      table.participantId,
    ),
    index('idx_conversation_participants_participant').on(table.participantId, table.participantType),
  ],
);

export const messageAuthorType = ['user', 'agent', 'system'] as const;
export const messageStatus = [
  'pending',
  'streaming',
  'complete',
  'failed',
  'cancelled',
  'redacted',
] as const;

export const messages = mysqlTable(
  'messages',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: ulidColumn('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorType: mysqlEnum('author_type', messageAuthorType).notNull(),
    authorUserId: ulidColumn('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Sem chave estrangeira para `agent_runs`: a orquestração referencia o chat
    // e a volta fecharia um ciclo entre os módulos do schema.
    authorAgentRunId: ulidColumn('author_agent_run_id'),
    status: mysqlEnum('status', messageStatus).notNull().default('complete'),
    // Ordem estável dentro da conversa, exigida pelo índice do `Docs/07`.
    sequence: bigint('sequence', { mode: 'number', unsigned: true }).notNull(),
    parentMessageId: ulidColumn('parent_message_id'),
    ...timestamps(),
    version: version(),
    // Mensagem apagada continua recuperável enquanto a conversa existir.
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('uq_messages_conversation_sequence').on(table.conversationId, table.sequence),
    index('idx_messages_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_messages_conversation_created_at').on(table.conversationId, table.createdAt),
    index('idx_messages_author_user').on(table.authorUserId, table.createdAt),
  ],
);

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

export const messageParts = mysqlTable(
  'message_parts',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: ulidColumn('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sequence: int('sequence').notNull(),
    type: mysqlEnum('type', messagePartType).notNull(),
    // Conteúdo textual da parte. Em `reasoning_summary` guarda o resumo
    // operacional permitido — nunca a cadeia de raciocínio bruta do modelo.
    content: mediumtext('content'),
    // Dados estruturados: argumentos de ferramenta, resultado, referência.
    payload: json('payload').$type<Record<string, unknown>>(),
    toolName: varchar('tool_name', { length: 128 }),
    tokenCount: int('token_count'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_message_parts_message_sequence').on(table.messageId, table.sequence),
    index('idx_message_parts_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const attachmentScanStatus = ['pending', 'clean', 'rejected'] as const;

export const messageAttachments = mysqlTable(
  'message_attachments',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: ulidColumn('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 191 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }).notNull(),
    // Chave no storage isolado; o binário nunca fica no MySQL.
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }).notNull(),
    scanStatus: mysqlEnum('scan_status', attachmentScanStatus).notNull().default('pending'),
    ...auditColumns(),
  },
  (table) => [
    index('idx_message_attachments_message').on(table.messageId),
    index('idx_message_attachments_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

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

export const messageContextRefs = mysqlTable(
  'message_context_refs',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    messageId: ulidColumn('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    refType: mysqlEnum('ref_type', contextRefType).notNull(),
    // Identificador da referência no seu próprio domínio (caminho, ULID, URL).
    refId: varchar('ref_id', { length: 512 }).notNull(),
    label: varchar('label', { length: 255 }),
    // Revisão/commit/linha que fixa o que foi enviado — o Hub minimiza código,
    // então guardamos o ponteiro, não o conteúdo.
    revision: varchar('revision', { length: 191 }),
    metadata: json('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_message_context_refs_message').on(table.messageId, table.refType),
    index('idx_message_context_refs_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

/** Camadas do resumo em `Docs/10`. */
export const summaryLayer = [
  'current_summary',
  'decisions',
  'facts',
  'tasks',
  'open_questions',
  'references',
] as const;

export const conversationSummaries = mysqlTable(
  'conversation_summaries',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: ulidColumn('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    layer: mysqlEnum('layer', summaryLayer).notNull(),
    fromSequence: bigint('from_sequence', { mode: 'number', unsigned: true }).notNull(),
    toSequence: bigint('to_sequence', { mode: 'number', unsigned: true }).notNull(),
    content: mediumtext('content').notNull(),
    // IDs das mensagens que sustentam o resumo: auditoria e recuperação.
    sourceMessageIds: json('source_message_ids').$type<string[]>(),
    model: varchar('model', { length: 128 }),
    tokenCount: int('token_count'),
    ...auditColumns(),
  },
  (table) => [
    index('idx_conversation_summaries_conversation').on(
      table.conversationId,
      table.layer,
      table.toSequence,
    ),
    index('idx_conversation_summaries_org_created_at').on(table.organizationId, table.createdAt),
  ],
);
