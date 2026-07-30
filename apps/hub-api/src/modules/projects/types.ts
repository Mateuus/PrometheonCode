/** Tipos do módulo de projetos, compartilhados com conversas, mensagens e tarefas. */

import type { Permission, Role } from '@prometheon/permissions';
import type { AutonomyLevel, WorkMode } from '@prometheon/contracts';

/** Projeto como as camadas internas o enxergam, antes de virar contrato. */
export interface ProjectRow {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'archived';
  visibility: 'private' | 'organization';
  tags: string[] | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  version: number;
}

export interface ProjectSettingsRow {
  defaultWorkMode: WorkMode;
  defaultAutonomy: AutonomyLevel;
  contextBudgetTokens: number;
  allowRemoteAgents: boolean;
  requireReview: boolean;
  retentionDays: number | null;
  policy: Record<string, unknown> | null;
}

export interface ProjectMemberRow {
  id: string;
  projectId: string;
  userId: string;
  roleSlug: string | null;
  status: 'active' | 'suspended';
  createdAt: Date;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
}

/**
 * Resultado da autorização de projeto, anexado à requisição pelo guarda de
 * `access.ts`. Quem chega ao handler já teve projeto, papel e política
 * resolvidos — o handler não repete nenhuma dessas perguntas.
 */
export interface ProjectAccessContext {
  readonly project: ProjectRow;
  /** Papel efetivo: o do projeto quando existe, o da organização caso contrário. */
  readonly role: Role;
  readonly organizationRole: Role;
  readonly permission: Permission;
  /** `true` quando o acesso veio do papel administrativo, não de `project_members`. */
  readonly viaOrganizationRole: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Preenchido pelo guarda de projeto (`modules/projects/access.ts`). */
    projectAccess?: ProjectAccessContext;
  }
}
