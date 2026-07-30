// Conhecimento: o cérebro coletivo do `Docs/10`.
//
// O item é a identidade estável; o conteúdo vive em versões. Estado e origem
// seguem exatamente as listas do documento. Conhecimento rejeitado continua
// gravado (histórico) mas não pode voltar a ser injetado nos agentes — a
// consulta filtra por `status`.

import { sql } from 'drizzle-orm';
import {
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

import { projects } from './project.js';
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

/** Estados do conhecimento (`Docs/10`). */
export const knowledgeStatus = [
  'draft',
  'proposed',
  'verified',
  'approved',
  'official',
  'superseded',
  'rejected',
] as const;
/** Origem do conhecimento (`Docs/10`). */
export const knowledgeOrigin = [
  'extracted',
  'inferred',
  'human',
  'decision',
  'experimental',
] as const;
/** Pastas do Vault Obsidian (`Docs/10`). */
export const knowledgeCategory = [
  'architecture',
  'component',
  'decision',
  'problem',
  'solution',
  'lesson',
] as const;

export const knowledgeItems = mysqlTable(
  'knowledge_items',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    // Nulo = conhecimento da organização, válido para todos os projetos.
    projectId: ulidColumn('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 191 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    category: mysqlEnum('category', knowledgeCategory).notNull(),
    status: mysqlEnum('status', knowledgeStatus).notNull().default('draft'),
    origin: mysqlEnum('origin', knowledgeOrigin).notNull().default('human'),
    // Confiança de 0 a 100; inteiro para não depender de ponto flutuante.
    confidence: smallint('confidence').notNull().default(50),
    // Escopo declarado na proposta (módulo, serviço, área do código).
    scope: varchar('scope', { length: 255 }),
    // Caminho no Vault Markdown (`.prometheon/knowledge/...`).
    path: varchar('path', { length: 512 }),
    // Sem FK para `knowledge_versions`: seria uma referência circular entre as
    // duas tabelas, e o MySQL passaria a exigir ordem em toda exclusão.
    currentVersionId: ulidColumn('current_version_id'),
    supersededById: ulidColumn('superseded_by_id'),
    tags: json('tags').$type<string[]>(),
    approvedAt: utcDatetime('approved_at'),
    // Chave de escopo derivada: o MySQL trata NULL como distinto, então
    // `(organization_id, project_id, slug)` não impediria dois itens de
    // organização com o mesmo slug.
    scopeKey: varchar('scope_key', { length: 26 }).generatedAlwaysAs(
      sql`(coalesce(\`project_id\`, ''))`,
      { mode: 'virtual' },
    ),
    ...auditColumns(),
    // Conhecimento apagado é recuperável: pode ser a única memória de uma
    // decisão de arquitetura.
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('uq_knowledge_items_scope_slug').on(
      table.organizationId,
      table.scopeKey,
      table.slug,
    ),
    index('idx_knowledge_items_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_knowledge_items_project_status_updated').on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const knowledgeVersions = mysqlTable(
  'knowledge_versions',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    knowledgeItemId: ulidColumn('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    versionNumber: int('version_number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    content: mediumtext('content').notNull(),
    contentFormat: varchar('content_format', { length: 32 }).notNull().default('markdown'),
    summary: text('summary'),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    status: mysqlEnum('status', knowledgeStatus).notNull().default('proposed'),
    origin: mysqlEnum('origin', knowledgeOrigin).notNull().default('human'),
    confidence: smallint('confidence').notNull().default(50),
    // Evidência que sustenta a proposta (trechos, resultados de teste, links).
    evidence: json('evidence').$type<Record<string, unknown>>(),
    changeNote: varchar('change_note', { length: 512 }),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_knowledge_versions_item_number').on(table.knowledgeItemId, table.versionNumber),
    index('idx_knowledge_versions_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

/** De onde o conhecimento veio. */
export const knowledgeSourceType = [
  'file',
  'commit',
  'message',
  'agent_run',
  'task',
  'graph_node',
  'url',
] as const;

export const knowledgeSources = mysqlTable(
  'knowledge_sources',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    knowledgeItemId: ulidColumn('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    knowledgeVersionId: ulidColumn('knowledge_version_id').references(() => knowledgeVersions.id, {
      onDelete: 'cascade',
    }),
    sourceType: mysqlEnum('source_type', knowledgeSourceType).notNull(),
    // Ponteiro para a fonte no seu domínio (caminho, SHA, ULID, URL).
    sourceRef: varchar('source_ref', { length: 512 }).notNull(),
    // Recorte dentro da fonte (linhas, âncora, seção).
    locator: varchar('locator', { length: 191 }),
    // O `Docs/10` exige marcar se a fonte foi extraída ou inferida.
    origin: mysqlEnum('origin', knowledgeOrigin).notNull().default('extracted'),
    confidence: smallint('confidence').notNull().default(50),
    extractedAt: utcDatetime('extracted_at'),
    createdAt: createdAt(),
    createdBy: ulidColumn('created_by'),
  },
  (table) => [
    index('idx_knowledge_sources_item').on(table.knowledgeItemId, table.sourceType),
    index('idx_knowledge_sources_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const knowledgeRelationType = [
  'relates_to',
  'depends_on',
  'supersedes',
  'contradicts',
  'derived_from',
  'part_of',
] as const;

export const knowledgeRelations = mysqlTable(
  'knowledge_relations',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    fromItemId: ulidColumn('from_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    toItemId: ulidColumn('to_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    relationType: mysqlEnum('relation_type', knowledgeRelationType).notNull(),
    createdAt: createdAt(),
    createdBy: ulidColumn('created_by'),
  },
  (table) => [
    uniqueIndex('uq_knowledge_relations').on(table.fromItemId, table.toItemId, table.relationType),
    index('idx_knowledge_relations_to').on(table.toItemId, table.relationType),
  ],
);

export const knowledgeReviewDecision = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
] as const;

export const knowledgeReviews = mysqlTable(
  'knowledge_reviews',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    knowledgeItemId: ulidColumn('knowledge_item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    knowledgeVersionId: ulidColumn('knowledge_version_id')
      .notNull()
      .references(() => knowledgeVersions.id, { onDelete: 'cascade' }),
    reviewerUserId: ulidColumn('reviewer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decision: mysqlEnum('decision', knowledgeReviewDecision).notNull().default('pending'),
    rationale: text('rationale'),
    reviewedAt: utcDatetime('reviewed_at'),
    ...auditColumns(),
  },
  (table) => [
    index('idx_knowledge_reviews_item_created_at').on(table.knowledgeItemId, table.createdAt),
    index('idx_knowledge_reviews_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const syncCheckpoints = mysqlTable(
  'sync_checkpoints',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    // Assunto do checkpoint: `graphify`, `knowledge`, `events`, `webhooks`…
    scope: varchar('scope', { length: 64 }).notNull(),
    // Chave montada pela aplicação (`project:<ulid>|device:<ulid>`) para que o
    // upsert tenha um alvo único sem depender de colunas nulas.
    scopeKey: varchar('scope_key', { length: 191 }).notNull(),
    cursor: varchar('cursor', { length: 255 }),
    lastEventId: ulidColumn('last_event_id'),
    lastSyncedAt: utcDatetime('last_synced_at'),
    state: json('state').$type<Record<string, unknown>>(),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_sync_checkpoints_scope').on(table.organizationId, table.scope, table.scopeKey),
    index('idx_sync_checkpoints_org_updated_at').on(table.organizationId, table.updatedAt),
  ],
);
