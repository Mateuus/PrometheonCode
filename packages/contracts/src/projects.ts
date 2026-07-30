/**
 * Projetos (`Docs/06`, `Docs/07`).
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import { organizationRoleSchema, permissionSchema } from './permissions.js';
import {
  isoDateTimeSchema,
  longTextSchema,
  shortTextSchema,
  slugSchema,
  tagsSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const PROJECT_VISIBILITIES = ['organization', 'private'] as const;

export const projectVisibilitySchema = z.enum(PROJECT_VISIBILITIES);

/** Repositório ligado ao projeto. A URL é validada contra SSRF no servidor. */
export const projectRepositorySchema = z.object({
  id: ulidSchema,
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'azure_devops', 'other']),
  remoteUrl: z.url(),
  defaultBranch: z.string().trim().min(1).max(255),
  /** Subdiretório do monorepo que interessa ao projeto, quando houver. */
  rootPath: z.string().max(512).nullable(),
});

export type ProjectRepository = z.infer<typeof projectRepositorySchema>;

/** Modos de trabalho da extensão (`Docs/04`). */
export const WORK_MODES = ['plan', 'edit', 'agent_team'] as const;

export const workModeSchema = z.enum(WORK_MODES);

export type WorkMode = z.infer<typeof workModeSchema>;

/**
 * Níveis de autonomia do `Docs/04`. `bypass` é sempre local e temporário: ele
 * nunca é gravado como padrão de projeto, mas o enum é o mesmo em toda parte
 * para que o valor não precise ser traduzido na fronteira.
 */
export const AUTONOMY_LEVELS = ['manual', 'auto', 'bypass'] as const;

export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS);

export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const projectSettingsSchema = z.object({
  /** Modo de trabalho com que as conversas do projeto nascem. */
  defaultWorkMode: workModeSchema,
  /**
   * Autonomia padrão dos agentes deste projeto. `bypass` está fora de
   * propósito: o `Docs/09` diz que ele é local, temporário e nunca vira padrão
   * permanente — permiti-lo aqui seria exatamente torná-lo permanente.
   */
  defaultAutonomy: z.enum(['manual', 'auto']),
  /** Exige revisão humana antes de aplicar mudança em código. */
  requireReview: z.boolean(),
  /** Permite iniciar agente remoto a partir do Hub. */
  allowRemoteAgents: z.boolean(),
  /** Teto de contexto por conversa, em tokens. */
  contextBudgetTokens: z.int().positive().max(10_000_000),
  /** Dias de retenção de conversa; `null` segue a política da organização. */
  conversationRetentionDays: z.int().positive().max(3650).nullable(),
});

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const projectSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  name: shortTextSchema,
  slug: slugSchema,
  description: longTextSchema.nullable(),
  status: projectStatusSchema,
  visibility: projectVisibilitySchema,
  tags: tagsSchema,
  repositories: z.array(projectRepositorySchema),
  settings: projectSettingsSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  createdBy: ulidSchema,
  version: versionSchema,
});

export type Project = z.infer<typeof projectSchema>;

export const projectWithAccessSchema = projectSchema.extend({
  role: organizationRoleSchema,
  permissions: z.array(permissionSchema),
});

export const createProjectRequestSchema = z.object({
  name: shortTextSchema,
  slug: slugSchema.optional(),
  description: longTextSchema.optional(),
  visibility: projectVisibilitySchema.default('organization'),
  tags: tagsSchema.default([]),
  settings: projectSettingsSchema.partial().optional(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z.object({
  name: shortTextSchema.optional(),
  slug: slugSchema.optional(),
  description: longTextSchema.nullable().optional(),
  status: projectStatusSchema.optional(),
  visibility: projectVisibilitySchema.optional(),
  tags: tagsSchema.optional(),
  settings: projectSettingsSchema.partial().optional(),
  version: versionSchema,
});

export const projectListQuerySchema = cursorPageQuerySchema.extend({
  status: projectStatusSchema.optional(),
  search: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(48).optional(),
});

export const projectPageSchema = cursorPageSchema(projectSchema);

export const projectMemberSchema = z.object({
  id: ulidSchema,
  projectId: ulidSchema,
  user: publicUserSchema,
  role: organizationRoleSchema,
  createdAt: isoDateTimeSchema,
});

export const projectMemberPageSchema = cursorPageSchema(projectMemberSchema);
