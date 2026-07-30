/**
 * Conhecimento do projeto (`Docs/06`, `Docs/07`).
 *
 * Conhecimento entra por proposta e só vale depois de revisão — quem propõe
 * (`knowledge.propose`) não é necessariamente quem aprova (`knowledge.approve`).
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

export const KNOWLEDGE_KINDS = [
  'decision',
  'convention',
  'runbook',
  'glossary',
  'architecture',
  'caveat',
  'reference',
] as const;

export const knowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);

export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>;

export const KNOWLEDGE_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'archived',
] as const;

export const knowledgeStatusSchema = z.enum(KNOWLEDGE_STATUSES);

export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;

/** De onde veio a informação: arquivo, conversa, tarefa ou link externo. */
export const knowledgeSourceSchema = z.object({
  kind: z.enum(['file', 'conversation', 'task', 'commit', 'url', 'manual']),
  reference: z.string().min(1).max(2048),
  label: shortTextSchema.nullable(),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export const KNOWLEDGE_RELATIONS = [
  'supersedes',
  'refines',
  'contradicts',
  'relates_to',
] as const;

export const knowledgeRelationSchema = z.object({
  relation: z.enum(KNOWLEDGE_RELATIONS),
  knowledgeId: ulidSchema,
});

export const knowledgeItemSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  projectId: ulidSchema,
  title: shortTextSchema,
  kind: knowledgeKindSchema,
  status: knowledgeStatusSchema,
  /** Conteúdo da versão vigente, em Markdown. */
  content: longTextSchema,
  /** Número da versão vigente, incrementado a cada aprovação. */
  currentVersion: z.int().positive(),
  tags: tagsSchema,
  sources: z.array(knowledgeSourceSchema),
  relations: z.array(knowledgeRelationSchema),
  proposedBy: publicUserSchema,
  reviewedBy: publicUserSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  version: versionSchema,
});

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;

export const knowledgeVersionSchema = z.object({
  id: ulidSchema,
  knowledgeId: ulidSchema,
  versionNumber: z.int().positive(),
  content: longTextSchema,
  changeSummary: shortTextSchema.nullable(),
  createdBy: publicUserSchema,
  createdAt: isoDateTimeSchema,
});

export const createKnowledgeProposalSchema = z.object({
  title: shortTextSchema,
  kind: knowledgeKindSchema,
  content: longTextSchema.min(1),
  tags: tagsSchema.default([]),
  sources: z.array(knowledgeSourceSchema).max(32).default([]),
  relations: z.array(knowledgeRelationSchema).max(32).default([]),
  /** Preenchido quando a proposta atualiza um item existente. */
  supersedesKnowledgeId: ulidSchema.optional(),
});

export type CreateKnowledgeProposal = z.infer<
  typeof createKnowledgeProposalSchema
>;

export const KNOWLEDGE_REVIEW_DECISIONS = [
  'approve',
  'reject',
  'request_changes',
] as const;

export const knowledgeReviewRequestSchema = z.object({
  decision: z.enum(KNOWLEDGE_REVIEW_DECISIONS),
  comment: longTextSchema.optional(),
  /** Versão do item que o revisor leu; evita aprovar texto já alterado. */
  version: versionSchema,
});

export const knowledgeReviewSchema = z.object({
  id: ulidSchema,
  knowledgeId: ulidSchema,
  decision: z.enum(KNOWLEDGE_REVIEW_DECISIONS),
  comment: longTextSchema.nullable(),
  reviewer: publicUserSchema,
  createdAt: isoDateTimeSchema,
});

export const knowledgeListQuerySchema = cursorPageQuerySchema.extend({
  status: knowledgeStatusSchema.optional(),
  kind: knowledgeKindSchema.optional(),
  tag: z.string().trim().max(48).optional(),
  search: z.string().trim().max(120).optional(),
});

export const knowledgePageSchema = cursorPageSchema(knowledgeItemSchema);
export const knowledgeVersionPageSchema = cursorPageSchema(
  knowledgeVersionSchema,
);
