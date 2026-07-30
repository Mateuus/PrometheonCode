// Conhecimento: o cérebro coletivo do `Docs/10`.
//
// O item é a identidade estável; o conteúdo vive em versões. Estado e origem
// seguem exatamente as listas do documento. Conhecimento rejeitado continua
// gravado (histórico) mas não pode voltar a ser injetado nos agentes — a
// consulta filtra por `status`.

import { EntitySchema } from 'typeorm';

import {
  auditColumns,
  createdAt,
  createdBy,
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
  utcDatetime,
  version,
  type AuditFields,
  type TimestampFields,
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
export type KnowledgeStatus = (typeof knowledgeStatus)[number];
/** Origem do conhecimento (`Docs/10`). */
export const knowledgeOrigin = [
  'extracted',
  'inferred',
  'human',
  'decision',
  'experimental',
] as const;
export type KnowledgeOrigin = (typeof knowledgeOrigin)[number];
/** Pastas do Vault Obsidian (`Docs/10`). */
export const knowledgeCategory = [
  'architecture',
  'component',
  'decision',
  'problem',
  'solution',
  'lesson',
] as const;
export type KnowledgeCategory = (typeof knowledgeCategory)[number];

export interface KnowledgeItem extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string | null;
  slug: string;
  title: string;
  category: KnowledgeCategory;
  status: KnowledgeStatus;
  origin: KnowledgeOrigin;
  confidence: number;
  scope: string | null;
  path: string | null;
  currentVersionId: string | null;
  supersededById: string | null;
  tags: string[] | null;
  approvedAt: Date | null;
  /** Coluna gerada pelo banco; nunca é escrita pela aplicação. */
  scopeKey: string;
  deletedAt: Date | null;
}

export const knowledgeItems = new EntitySchema<KnowledgeItem>({
  name: 'knowledge_items',
  tableName: 'knowledge_items',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    // Nulo = conhecimento da organização, válido para todos os projetos.
    projectId: ulidColumn('project_id'),
    slug: requiredText('slug', 191),
    title: requiredText('title', 255),
    category: enumColumn('category', knowledgeCategory),
    status: enumColumn('status', knowledgeStatus, { default: 'draft' }),
    origin: enumColumn('origin', knowledgeOrigin, { default: 'human' }),
    // Confiança de 0 a 100; inteiro para não depender de ponto flutuante.
    confidence: { type: 'smallint', name: 'confidence', nullable: false, default: 50 },
    // Escopo declarado na proposta (módulo, serviço, área do código).
    scope: text('scope', 255),
    // Caminho no Vault Markdown (`.prometheon/knowledge/...`).
    path: text('path', 512),
    // Sem FK para `knowledge_versions`: seria uma referência circular entre as
    // duas tabelas, e o MySQL passaria a exigir ordem em toda exclusão.
    currentVersionId: ulidColumn('current_version_id'),
    supersededById: ulidColumn('superseded_by_id'),
    tags: jsonColumn('tags'),
    approvedAt: utcDatetime('approved_at'),
    // Chave de escopo derivada: o MySQL trata NULL como distinto, então
    // `(organization_id, project_id, slug)` não impediria dois itens de
    // organização com o mesmo slug.
    scopeKey: {
      type: 'varchar',
      name: 'scope_key',
      length: 26,
      nullable: true,
      asExpression: "(coalesce(`project_id`, ''))",
      generatedType: 'VIRTUAL',
      insert: false,
      update: false,
    },
    ...auditColumns(),
    // Conhecimento apagado é recuperável: pode ser a única memória de uma
    // decisão de arquitetura.
    deletedAt: deletedAt(),
  },
  uniques: [
    {
      name: 'uq_knowledge_items_scope_slug',
      columns: ['organizationId', 'scopeKey', 'slug'],
    },
  ],
  indices: [
    { name: 'idx_knowledge_items_org_created_at', columns: ['organizationId', 'createdAt'] },
    {
      name: 'idx_knowledge_items_project_status_updated',
      columns: ['projectId', 'status', 'updatedAt'],
    },
  ],
});

export interface KnowledgeVersion extends AuditFields {
  id: string;
  organizationId: string;
  knowledgeItemId: string;
  versionNumber: number;
  title: string;
  content: string;
  contentFormat: string;
  summary: string | null;
  checksumSha256: string | null;
  status: KnowledgeStatus;
  origin: KnowledgeOrigin;
  confidence: number;
  evidence: Record<string, unknown> | null;
  changeNote: string | null;
}

export const knowledgeVersions = new EntitySchema<KnowledgeVersion>({
  name: 'knowledge_versions',
  tableName: 'knowledge_versions',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    knowledgeItemId: requiredUlidColumn('knowledge_item_id'),
    versionNumber: { type: 'int', name: 'version_number', nullable: false },
    title: requiredText('title', 255),
    content: { type: 'mediumtext', name: 'content', nullable: false },
    contentFormat: requiredText('content_format', 32, { default: 'markdown' }),
    summary: { type: 'text', name: 'summary', nullable: true },
    checksumSha256: text('checksum_sha256', 64),
    status: enumColumn('status', knowledgeStatus, { default: 'proposed' }),
    origin: enumColumn('origin', knowledgeOrigin, { default: 'human' }),
    confidence: { type: 'smallint', name: 'confidence', nullable: false, default: 50 },
    // Evidência que sustenta a proposta (trechos, resultados de teste, links).
    evidence: jsonColumn('evidence'),
    changeNote: text('change_note', 512),
    ...auditColumns(),
  },
  uniques: [
    {
      name: 'uq_knowledge_versions_item_number',
      columns: ['knowledgeItemId', 'versionNumber'],
    },
  ],
  indices: [
    { name: 'idx_knowledge_versions_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

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
export type KnowledgeSourceType = (typeof knowledgeSourceType)[number];

export interface KnowledgeSource {
  id: string;
  organizationId: string;
  knowledgeItemId: string;
  knowledgeVersionId: string | null;
  sourceType: KnowledgeSourceType;
  sourceRef: string;
  locator: string | null;
  origin: KnowledgeOrigin;
  confidence: number;
  extractedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
}

export const knowledgeSources = new EntitySchema<KnowledgeSource>({
  name: 'knowledge_sources',
  tableName: 'knowledge_sources',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    knowledgeItemId: requiredUlidColumn('knowledge_item_id'),
    knowledgeVersionId: ulidColumn('knowledge_version_id'),
    sourceType: enumColumn('source_type', knowledgeSourceType),
    // Ponteiro para a fonte no seu domínio (caminho, SHA, ULID, URL).
    sourceRef: requiredText('source_ref', 512),
    // Recorte dentro da fonte (linhas, âncora, seção).
    locator: text('locator', 191),
    // O `Docs/10` exige marcar se a fonte foi extraída ou inferida.
    origin: enumColumn('origin', knowledgeOrigin, { default: 'extracted' }),
    confidence: { type: 'smallint', name: 'confidence', nullable: false, default: 50 },
    extractedAt: utcDatetime('extracted_at'),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  indices: [
    { name: 'idx_knowledge_sources_item', columns: ['knowledgeItemId', 'sourceType'] },
    { name: 'idx_knowledge_sources_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

export const knowledgeRelationType = [
  'relates_to',
  'depends_on',
  'supersedes',
  'contradicts',
  'derived_from',
  'part_of',
] as const;
export type KnowledgeRelationType = (typeof knowledgeRelationType)[number];

export interface KnowledgeRelation {
  id: string;
  organizationId: string;
  fromItemId: string;
  toItemId: string;
  relationType: KnowledgeRelationType;
  createdAt: Date;
  createdBy: string | null;
}

export const knowledgeRelations = new EntitySchema<KnowledgeRelation>({
  name: 'knowledge_relations',
  tableName: 'knowledge_relations',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    fromItemId: requiredUlidColumn('from_item_id'),
    toItemId: requiredUlidColumn('to_item_id'),
    relationType: enumColumn('relation_type', knowledgeRelationType),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  uniques: [
    { name: 'uq_knowledge_relations', columns: ['fromItemId', 'toItemId', 'relationType'] },
  ],
  indices: [{ name: 'idx_knowledge_relations_to', columns: ['toItemId', 'relationType'] }],
});

export const knowledgeReviewDecision = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
] as const;
export type KnowledgeReviewDecision = (typeof knowledgeReviewDecision)[number];

export interface KnowledgeReview extends AuditFields {
  id: string;
  organizationId: string;
  knowledgeItemId: string;
  knowledgeVersionId: string;
  reviewerUserId: string | null;
  decision: KnowledgeReviewDecision;
  rationale: string | null;
  reviewedAt: Date | null;
}

export const knowledgeReviews = new EntitySchema<KnowledgeReview>({
  name: 'knowledge_reviews',
  tableName: 'knowledge_reviews',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    knowledgeItemId: requiredUlidColumn('knowledge_item_id'),
    knowledgeVersionId: requiredUlidColumn('knowledge_version_id'),
    reviewerUserId: ulidColumn('reviewer_user_id'),
    decision: enumColumn('decision', knowledgeReviewDecision, { default: 'pending' }),
    rationale: { type: 'text', name: 'rationale', nullable: true },
    reviewedAt: utcDatetime('reviewed_at'),
    ...auditColumns(),
  },
  indices: [
    { name: 'idx_knowledge_reviews_item_created_at', columns: ['knowledgeItemId', 'createdAt'] },
    { name: 'idx_knowledge_reviews_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

export interface SyncCheckpoint extends TimestampFields {
  id: string;
  organizationId: string;
  scope: string;
  scopeKey: string;
  cursor: string | null;
  lastEventId: string | null;
  lastSyncedAt: Date | null;
  state: Record<string, unknown> | null;
  version: number;
}

export const syncCheckpoints = new EntitySchema<SyncCheckpoint>({
  name: 'sync_checkpoints',
  tableName: 'sync_checkpoints',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    // Assunto do checkpoint: `graphify`, `knowledge`, `events`, `webhooks`…
    scope: requiredText('scope', 64),
    // Chave montada pela aplicação (`project:<ulid>|device:<ulid>`) para que o
    // upsert tenha um alvo único sem depender de colunas nulas.
    scopeKey: requiredText('scope_key', 191),
    cursor: text('cursor', 255),
    lastEventId: ulidColumn('last_event_id'),
    lastSyncedAt: utcDatetime('last_synced_at'),
    state: jsonColumn('state'),
    ...timestamps(),
    version: version(),
  },
  uniques: [
    { name: 'uq_sync_checkpoints_scope', columns: ['organizationId', 'scope', 'scopeKey'] },
  ],
  indices: [
    { name: 'idx_sync_checkpoints_org_updated_at', columns: ['organizationId', 'updatedAt'] },
  ],
});
