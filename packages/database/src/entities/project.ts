// Projeto: a unidade de trabalho dentro da organização, com seus repositórios,
// suas configurações e os perfis de agente habilitados.

import { EntitySchema } from 'typeorm';

import {
  auditColumns,
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

export const projectStatus = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof projectStatus)[number];
export const projectVisibility = ['private', 'organization'] as const;
export type ProjectVisibility = (typeof projectVisibility)[number];

export interface Project extends AuditFields {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  defaultBranch: string;
  tags: string[] | null;
  lastTaskNumber: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

export const projects = new EntitySchema<Project>({
  name: 'projects',
  tableName: 'projects',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    slug: requiredText('slug', 96),
    name: requiredText('name', 160),
    description: { type: 'text', name: 'description', nullable: true },
    status: enumColumn('status', projectStatus, { default: 'active' }),
    visibility: enumColumn('visibility', projectVisibility, { default: 'organization' }),
    defaultBranch: requiredText('default_branch', 191, { default: 'main' }),
    archivedAt: utcDatetime('archived_at'),
    ...auditColumns(),
    // Projeto excluído entra em janela de recuperação antes do apagamento.
    deletedAt: deletedAt(),
    // Etiquetas livres do contrato de projeto. JSON em vez de tabela própria:
    // elas são filtro e rótulo, nunca entidade com ciclo de vida.
    tags: jsonColumn('tags'),
    // Último `tasks.number` entregue neste projeto. O número curto por projeto
    // é distribuído incrementando esta coluna dentro da transação da tarefa —
    // o mesmo mecanismo de `conversations.last_sequence`, e pela mesma razão:
    // `MAX(number) + 1` corre com outra escrita simultânea.
    lastTaskNumber: unsignedBigint('last_task_number', { default: 0 }),
  },
  uniques: [{ name: 'uq_projects_org_slug', columns: ['organizationId', 'slug'] }],
  indices: [
    { name: 'idx_projects_org_created_at', columns: ['organizationId', 'createdAt'] },
    {
      name: 'idx_projects_org_status_updated_at',
      columns: ['organizationId', 'status', 'updatedAt'],
    },
  ],
});

export const projectMemberStatus = ['active', 'suspended'] as const;
export type ProjectMemberStatus = (typeof projectMemberStatus)[number];

export interface ProjectMember extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  userId: string;
  roleId: string | null;
  status: ProjectMemberStatus;
  addedBy: string | null;
}

export const projectMembers = new EntitySchema<ProjectMember>({
  name: 'project_members',
  tableName: 'project_members',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    userId: requiredUlidColumn('user_id'),
    // Papel no projeto. Nulo = herda o papel da organização.
    roleId: ulidColumn('role_id'),
    status: enumColumn('status', projectMemberStatus, { default: 'active' }),
    addedBy: ulidColumn('added_by'),
    ...auditColumns(),
  },
  uniques: [
    // Unique natural do membership de projeto.
    { name: 'uq_project_members_project_user', columns: ['projectId', 'userId'] },
  ],
  indices: [
    { name: 'idx_project_members_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_project_members_user', columns: ['userId', 'status'] },
  ],
});

export interface ProjectRepositoryLink extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  gitRepositoryId: string;
  rootPath: string | null;
  defaultBranch: string | null;
  isPrimary: boolean;
}

export const projectRepositories = new EntitySchema<ProjectRepositoryLink>({
  name: 'project_repositories',
  tableName: 'project_repositories',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    gitRepositoryId: requiredUlidColumn('git_repository_id'),
    // Subdiretório do repositório que interessa ao projeto (monorepos).
    rootPath: text('root_path', 512),
    defaultBranch: text('default_branch', 191),
    isPrimary: { type: 'boolean', name: 'is_primary', nullable: false, default: false },
    ...auditColumns(),
  },
  uniques: [
    {
      name: 'uq_project_repositories_project_repo',
      columns: ['projectId', 'gitRepositoryId'],
    },
  ],
  indices: [
    { name: 'idx_project_repositories_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

/** Modos de trabalho da extensão (`Docs/04`). */
export const workMode = ['plan', 'edit', 'agent_team'] as const;
export type WorkMode = (typeof workMode)[number];
/** Níveis de autonomia (`Docs/04`). `bypass` é sempre local e temporário. */
export const autonomyLevel = ['manual', 'auto', 'bypass'] as const;
export type AutonomyLevel = (typeof autonomyLevel)[number];

export interface ProjectSettingsEntity extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  defaultWorkMode: WorkMode;
  defaultAutonomy: AutonomyLevel;
  contextBudgetTokens: number;
  allowRemoteAgents: boolean;
  requireReview: boolean;
  policy: Record<string, unknown> | null;
  knowledgePath: string;
  retentionDays: number | null;
}

export const projectSettings = new EntitySchema<ProjectSettingsEntity>({
  name: 'project_settings',
  tableName: 'project_settings',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    defaultWorkMode: enumColumn('default_work_mode', workMode, { default: 'plan' }),
    defaultAutonomy: enumColumn('default_autonomy', autonomyLevel, { default: 'manual' }),
    contextBudgetTokens: {
      type: 'int',
      name: 'context_budget_tokens',
      nullable: false,
      default: 120_000,
    },
    allowRemoteAgents: {
      type: 'boolean',
      name: 'allow_remote_agents',
      nullable: false,
      default: false,
    },
    requireReview: { type: 'boolean', name: 'require_review', nullable: false, default: true },
    // Política do projeto — segunda camada da precedência do `Docs/09`. Um
    // `deny` aqui não pode ser liberado por camada inferior.
    policy: jsonColumn('policy'),
    knowledgePath: requiredText('knowledge_path', 512, { default: '.prometheon/knowledge' }),
    retentionDays: { type: 'int', name: 'retention_days', nullable: true },
    ...auditColumns(),
  },
  uniques: [{ name: 'uq_project_settings_project', columns: ['projectId'] }],
});

/** Papel funcional do perfil dentro do time de agentes. */
export const agentRole = [
  'main',
  'planner',
  'implementer',
  'reviewer',
  'researcher',
  'tester',
  'documenter',
] as const;
export type AgentRole = (typeof agentRole)[number];
/** Como o Core fala com o agente (`Docs/04`). */
export const agentTransport = ['cli', 'api'] as const;
export type AgentTransport = (typeof agentTransport)[number];

export interface AgentProfile extends AuditFields {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  provider: string;
  transport: AgentTransport;
  model: string | null;
  role: AgentRole;
  defaultWorkMode: WorkMode;
  defaultAutonomy: AutonomyLevel;
  concurrencyLimit: number;
  instructions: string | null;
  config: Record<string, unknown> | null;
  isDefault: boolean;
  isActive: boolean;
}

export const agentProfiles = new EntitySchema<AgentProfile>({
  name: 'agent_profiles',
  tableName: 'agent_profiles',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    slug: requiredText('slug', 96),
    name: requiredText('name', 160),
    description: text('description', 512),
    // Identificador do adaptador (`claude-code`, `codex`, `kimi`, …). Texto
    // para não exigir migração a cada provedor novo.
    provider: requiredText('provider', 64),
    transport: enumColumn('transport', agentTransport, { default: 'cli' }),
    model: text('model', 128),
    role: enumColumn('role', agentRole, { default: 'implementer' }),
    defaultWorkMode: enumColumn('default_work_mode', workMode, { default: 'plan' }),
    defaultAutonomy: enumColumn('default_autonomy', autonomyLevel, { default: 'manual' }),
    concurrencyLimit: { type: 'int', name: 'concurrency_limit', nullable: false, default: 1 },
    // Instruções operacionais do perfil. Não guarda credencial de conta: o
    // login dos CLIs acontece na máquina do usuário (`Docs/09`).
    instructions: { type: 'text', name: 'instructions', nullable: true },
    config: jsonColumn('config'),
    isDefault: { type: 'boolean', name: 'is_default', nullable: false, default: false },
    isActive: { type: 'boolean', name: 'is_active', nullable: false, default: true },
    ...auditColumns(),
  },
  uniques: [{ name: 'uq_agent_profiles_org_slug', columns: ['organizationId', 'slug'] }],
  indices: [
    { name: 'idx_agent_profiles_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

export interface ProjectAgentProfile extends TimestampFields {
  id: string;
  organizationId: string;
  projectId: string;
  agentProfileId: string;
  isEnabled: boolean;
  priority: number;
  overrides: Record<string, unknown> | null;
  version: number;
}

export const projectAgentProfiles = new EntitySchema<ProjectAgentProfile>({
  name: 'project_agent_profiles',
  tableName: 'project_agent_profiles',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    agentProfileId: requiredUlidColumn('agent_profile_id'),
    isEnabled: { type: 'boolean', name: 'is_enabled', nullable: false, default: true },
    priority: { type: 'int', name: 'priority', nullable: false, default: 0 },
    // Ajustes que valem só neste projeto (modelo, autonomia, limites).
    overrides: jsonColumn('overrides'),
    ...timestamps(),
    version: version(),
  },
  uniques: [{ name: 'uq_project_agent_profiles', columns: ['projectId', 'agentProfileId'] }],
  indices: [{ name: 'idx_project_agent_profiles_org', columns: ['organizationId', 'isEnabled'] }],
});
