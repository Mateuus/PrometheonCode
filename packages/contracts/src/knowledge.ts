/**
 * Conhecimento do projeto — o cérebro coletivo do `Docs/10`.
 *
 * O fluxo é proposta → revisão → aprovação, e as três etapas têm permissões
 * distintas (`knowledge.propose`, `knowledge.review`, `knowledge.approve`).
 *
 * Duas decisões que atravessam todos os schemas daqui:
 *
 * - **o item é a identidade estável; o conteúdo vive em versões.** Aprovar não
 *   sobrescreve: cria uma versão nova e aposenta a anterior como `superseded`.
 *   É esse histórico que permite responder "de onde veio esta afirmação?".
 * - **procedência é obrigatória para aprovar.** O `Docs/10` exige que a fonte
 *   seja marcada como extraída ou inferida; informação inferida apresentada como
 *   fato envenena o grafo de conhecimento do time.
 *
 * Os enums espelham exatamente as listas do `Docs/10` e as colunas de
 * `knowledge_items` / `knowledge_versions` / `knowledge_sources`.
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import {
  isoDateTimeSchema,
  longTextSchema,
  shortTextSchema,
  tagsSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

/** Pastas do Vault Obsidian (`Docs/10`). */
export const KNOWLEDGE_CATEGORIES = [
  'architecture',
  'component',
  'decision',
  'problem',
  'solution',
  'lesson',
] as const;

export const knowledgeCategorySchema = z.enum(KNOWLEDGE_CATEGORIES);

export type KnowledgeCategory = z.infer<typeof knowledgeCategorySchema>;

/** Estados do conhecimento (`Docs/10`). */
export const KNOWLEDGE_STATUSES = [
  'draft',
  'proposed',
  'verified',
  'approved',
  'official',
  'superseded',
  'rejected',
] as const;

export const knowledgeStatusSchema = z.enum(KNOWLEDGE_STATUSES);

export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;

/**
 * Origem da afirmação (`Docs/10`).
 *
 * `extracted` saiu de uma fonte que pode ser reaberta; `inferred` é conclusão do
 * agente. A distinção é o que impede um palpite de circular como fato.
 */
export const KNOWLEDGE_ORIGINS = [
  'extracted',
  'inferred',
  'human',
  'decision',
  'experimental',
] as const;

export const knowledgeOriginSchema = z.enum(KNOWLEDGE_ORIGINS);

export type KnowledgeOrigin = z.infer<typeof knowledgeOriginSchema>;

/** De onde o conhecimento veio, no domínio de cada fonte. */
export const KNOWLEDGE_SOURCE_TYPES = [
  'file',
  'commit',
  'message',
  'agent_run',
  'task',
  'graph_node',
  'url',
] as const;

export const knowledgeSourceTypeSchema = z.enum(KNOWLEDGE_SOURCE_TYPES);

/** Confiança de 0 a 100. Inteiro para não depender de ponto flutuante. */
export const confidenceSchema = z.int().min(0).max(100);

export const knowledgeSourceSchema = z.object({
  type: knowledgeSourceTypeSchema,
  /** Ponteiro para a fonte no seu domínio: caminho, SHA, ULID, URL. */
  reference: z.string().trim().min(1).max(512),
  /** Recorte dentro da fonte: linhas, âncora, seção. */
  locator: z.string().trim().max(191).nullable().default(null),
  origin: knowledgeOriginSchema,
  confidence: confidenceSchema.default(50),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export const KNOWLEDGE_RELATIONS = [
  'relates_to',
  'depends_on',
  'supersedes',
  'contradicts',
  'derived_from',
  'part_of',
] as const;

export const knowledgeRelationSchema = z.object({
  relation: z.enum(KNOWLEDGE_RELATIONS),
  knowledgeId: ulidSchema,
});

export type KnowledgeRelation = z.infer<typeof knowledgeRelationSchema>;

export const knowledgeVersionSchema = z.object({
  id: ulidSchema,
  knowledgeId: ulidSchema,
  versionNumber: z.int().positive(),
  title: shortTextSchema,
  content: longTextSchema,
  summary: longTextSchema.nullable(),
  status: knowledgeStatusSchema,
  origin: knowledgeOriginSchema,
  confidence: confidenceSchema,
  changeNote: z.string().max(512).nullable(),
  createdBy: publicUserSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export type KnowledgeVersion = z.infer<typeof knowledgeVersionSchema>;

/** O que a listagem devolve: sem o corpo Markdown, que pode ter 64 KiB. */
export const knowledgeItemSummarySchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  /** Nulo = conhecimento da organização, válido para todos os projetos. */
  projectId: ulidSchema.nullable(),
  slug: z.string().min(1).max(191),
  title: shortTextSchema,
  category: knowledgeCategorySchema,
  status: knowledgeStatusSchema,
  origin: knowledgeOriginSchema,
  confidence: confidenceSchema,
  scope: z.string().max(255).nullable(),
  tags: tagsSchema,
  /** Número da versão vigente; nulo enquanto nada foi aprovado. */
  currentVersionNumber: z.int().positive().nullable(),
  /** Número da versão aguardando revisão, quando houver. */
  pendingVersionNumber: z.int().positive().nullable(),
  /** Quantas fontes sustentam a versão vigente ou a pendente. */
  sourceCount: z.int().nonnegative(),
  proposedBy: publicUserSchema.nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  version: versionSchema,
});

export type KnowledgeItemSummary = z.infer<typeof knowledgeItemSummarySchema>;

export const knowledgeItemSchema = knowledgeItemSummarySchema.extend({
  currentVersion: knowledgeVersionSchema.nullable(),
  pendingVersion: knowledgeVersionSchema.nullable(),
  sources: z.array(knowledgeSourceSchema),
  relations: z.array(knowledgeRelationSchema),
});

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

export const createKnowledgeProposalSchema = z.object({
  title: shortTextSchema,
  category: knowledgeCategorySchema,
  content: longTextSchema.min(1),
  summary: longTextSchema.optional(),
  origin: knowledgeOriginSchema,
  confidence: confidenceSchema.default(50),
  scope: z.string().trim().max(255).optional(),
  tags: tagsSchema.default([]),
  sources: z.array(knowledgeSourceSchema).max(32).default([]),
  relations: z.array(knowledgeRelationSchema).max(32).default([]),
  /** Nota do que mudou; obrigatória na prática quando revisa item existente. */
  changeNote: z.string().trim().max(512).optional(),
  /**
   * Preenchido quando a proposta é uma nova versão de um item existente. Sem
   * ele, a proposta cria um item novo.
   */
  knowledgeId: ulidSchema.optional(),
});

export type CreateKnowledgeProposal = z.infer<
  typeof createKnowledgeProposalSchema
>;

export const KNOWLEDGE_REVIEW_DECISIONS = [
  'approve',
  'reject',
  'request_changes',
] as const;

export const knowledgeReviewDecisionSchema = z.enum(KNOWLEDGE_REVIEW_DECISIONS);

export type KnowledgeReviewDecision = z.infer<
  typeof knowledgeReviewDecisionSchema
>;

export const knowledgeReviewRequestSchema = z.object({
  decision: knowledgeReviewDecisionSchema,
  comment: longTextSchema.optional(),
  /** Versão do item que o revisor leu; evita decidir sobre texto já alterado. */
  version: versionSchema,
});

export type KnowledgeReviewRequest = z.infer<
  typeof knowledgeReviewRequestSchema
>;

export const knowledgeReviewSchema = z.object({
  id: ulidSchema,
  knowledgeId: ulidSchema,
  knowledgeVersionId: ulidSchema,
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  comment: longTextSchema.nullable(),
  reviewer: publicUserSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export type KnowledgeReview = z.infer<typeof knowledgeReviewSchema>;

/** Resposta da revisão: a decisão e como o item ficou depois dela. */
export const knowledgeReviewResultSchema = z.object({
  review: knowledgeReviewSchema,
  item: knowledgeItemSchema,
});

/**
 * Diferença entre a versão pendente e a vigente.
 *
 * Existe porque revisar sem ver o que mudou é carimbar. As linhas vêm no
 * formato clássico (`added`, `removed`, `context`) para a interface desenhar
 * lado a lado sem precisar de um algoritmo próprio.
 */
export const knowledgeDiffLineSchema = z.object({
  kind: z.enum(['added', 'removed', 'context']),
  /** Número da linha na versão vigente; nulo em linha adicionada. */
  baseLine: z.int().positive().nullable(),
  /** Número da linha na versão proposta; nulo em linha removida. */
  proposedLine: z.int().positive().nullable(),
  text: z.string(),
});

export const knowledgeDiffSchema = z.object({
  knowledgeId: ulidSchema,
  /** Nulo quando a proposta é a primeira versão do item. */
  base: knowledgeVersionSchema.nullable(),
  proposed: knowledgeVersionSchema,
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  lines: z.array(knowledgeDiffLineSchema),
  /** Fontes declaradas na versão proposta; vazio impede a aprovação. */
  sources: z.array(knowledgeSourceSchema),
});

export type KnowledgeDiff = z.infer<typeof knowledgeDiffSchema>;

export const knowledgeListQuerySchema = cursorPageQuerySchema.extend({
  status: knowledgeStatusSchema.optional(),
  category: knowledgeCategorySchema.optional(),
  origin: knowledgeOriginSchema.optional(),
  tag: z.string().trim().max(48).optional(),
  search: z.string().trim().max(120).optional(),
  /** `true` inclui o conhecimento de organização junto ao do projeto. */
  includeOrganization: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

export type KnowledgeListQuery = z.infer<typeof knowledgeListQuerySchema>;

export const knowledgePageSchema = cursorPageSchema(knowledgeItemSummarySchema);
export const knowledgeVersionPageSchema = cursorPageSchema(
  knowledgeVersionSchema,
);
