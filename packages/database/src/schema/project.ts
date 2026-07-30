// Projeto: a unidade de trabalho dentro da organização, com seus repositórios,
// suas configurações e os perfis de agente habilitados.

import {
  bigint,
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

import { gitRepositories } from './integrations.js';
import { organizations, roles } from './organization.js';
import { users } from './identity.js';
import {
  auditColumns,
  deletedAt,
  organizationId,
  primaryId,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
} from './columns.js';

export const projectStatus = ['active', 'paused', 'archived'] as const;
export const projectVisibility = ['private', 'organization'] as const;

export const projects = mysqlTable(
  'projects',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: text('description'),
    status: mysqlEnum('status', projectStatus).notNull().default('active'),
    visibility: mysqlEnum('visibility', projectVisibility).notNull().default('organization'),
    defaultBranch: varchar('default_branch', { length: 191 }).notNull().default('main'),
    // Etiquetas livres do contrato de projeto. JSON em vez de tabela própria:
    // elas são filtro e rótulo, nunca entidade com ciclo de vida.
    tags: json('tags').$type<string[]>(),
    // Último `tasks.number` entregue neste projeto. O número curto por projeto
    // é distribuído incrementando esta coluna dentro da transação da tarefa —
    // o mesmo mecanismo de `conversations.last_sequence`, e pela mesma razão:
    // `MAX(number) + 1` corre com outra escrita simultânea.
    lastTaskNumber: bigint('last_task_number', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    archivedAt: utcDatetime('archived_at'),
    ...auditColumns(),
    // Projeto excluído entra em janela de recuperação antes do apagamento.
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('uq_projects_org_slug').on(table.organizationId, table.slug),
    index('idx_projects_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_projects_org_status_updated_at').on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const projectMemberStatus = ['active', 'suspended'] as const;

export const projectMembers = mysqlTable(
  'project_members',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Papel no projeto. Nulo = herda o papel da organização.
    roleId: ulidColumn('role_id').references(() => roles.id, { onDelete: 'set null' }),
    status: mysqlEnum('status', projectMemberStatus).notNull().default('active'),
    addedBy: ulidColumn('added_by').references(() => users.id, { onDelete: 'set null' }),
    ...auditColumns(),
  },
  (table) => [
    // Unique natural do membership de projeto.
    uniqueIndex('uq_project_members_project_user').on(table.projectId, table.userId),
    index('idx_project_members_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_project_members_user').on(table.userId, table.status),
  ],
);

export const projectRepositories = mysqlTable(
  'project_repositories',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    gitRepositoryId: ulidColumn('git_repository_id')
      .notNull()
      .references(() => gitRepositories.id, { onDelete: 'cascade' }),
    // Subdiretório do repositório que interessa ao projeto (monorepos).
    rootPath: varchar('root_path', { length: 512 }),
    defaultBranch: varchar('default_branch', { length: 191 }),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_project_repositories_project_repo').on(table.projectId, table.gitRepositoryId),
    index('idx_project_repositories_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

/** Modos de trabalho da extensão (`Docs/04`). */
export const workMode = ['plan', 'edit', 'agent_team'] as const;
/** Níveis de autonomia (`Docs/04`). `bypass` é sempre local e temporário. */
export const autonomyLevel = ['manual', 'auto', 'bypass'] as const;

export const projectSettings = mysqlTable(
  'project_settings',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    defaultWorkMode: mysqlEnum('default_work_mode', workMode).notNull().default('plan'),
    defaultAutonomy: mysqlEnum('default_autonomy', autonomyLevel).notNull().default('manual'),
    contextBudgetTokens: int('context_budget_tokens').notNull().default(120_000),
    allowRemoteAgents: boolean('allow_remote_agents').notNull().default(false),
    requireReview: boolean('require_review').notNull().default(true),
    // Política do projeto — segunda camada da precedência do `Docs/09`. Um
    // `deny` aqui não pode ser liberado por camada inferior.
    policy: json('policy').$type<Record<string, unknown>>(),
    knowledgePath: varchar('knowledge_path', { length: 512 })
      .notNull()
      .default('.prometheon/knowledge'),
    retentionDays: int('retention_days'),
    ...auditColumns(),
  },
  (table) => [uniqueIndex('uq_project_settings_project').on(table.projectId)],
);

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
/** Como o Core fala com o agente (`Docs/04`). */
export const agentTransport = ['cli', 'api'] as const;

export const agentProfiles = mysqlTable(
  'agent_profiles',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: varchar('description', { length: 512 }),
    // Identificador do adaptador (`claude-code`, `codex`, `kimi`, …). Texto
    // para não exigir migração a cada provedor novo.
    provider: varchar('provider', { length: 64 }).notNull(),
    transport: mysqlEnum('transport', agentTransport).notNull().default('cli'),
    model: varchar('model', { length: 128 }),
    role: mysqlEnum('role', agentRole).notNull().default('implementer'),
    defaultWorkMode: mysqlEnum('default_work_mode', workMode).notNull().default('plan'),
    defaultAutonomy: mysqlEnum('default_autonomy', autonomyLevel).notNull().default('manual'),
    concurrencyLimit: int('concurrency_limit').notNull().default(1),
    // Instruções operacionais do perfil. Não guarda credencial de conta: o
    // login dos CLIs acontece na máquina do usuário (`Docs/09`).
    instructions: text('instructions'),
    config: json('config').$type<Record<string, unknown>>(),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_agent_profiles_org_slug').on(table.organizationId, table.slug),
    index('idx_agent_profiles_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const projectAgentProfiles = mysqlTable(
  'project_agent_profiles',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentProfileId: ulidColumn('agent_profile_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    isEnabled: boolean('is_enabled').notNull().default(true),
    priority: int('priority').notNull().default(0),
    // Ajustes que valem só neste projeto (modelo, autonomia, limites).
    overrides: json('overrides').$type<Record<string, unknown>>(),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_project_agent_profiles').on(table.projectId, table.agentProfileId),
    index('idx_project_agent_profiles_org').on(table.organizationId, table.isEnabled),
  ],
);
