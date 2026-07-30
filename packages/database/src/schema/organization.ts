// Organização: o tenant. Plano, membros, papéis e convites.
//
// `plans` não está listado no `Docs/07`, mas o `Docs/HUB_PLANO_DE_EXECUCAO`
// (fase 3) fala em "planos e limites" e o seed exige um plano gratuito — daí a
// tabela. Todo valor monetário é inteiro na menor unidade da moeda.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

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

/** Periodicidade da cobrança. `none` é o plano gratuito. */
export const planBillingPeriod = ['none', 'monthly', 'yearly'] as const;

export const plans = mysqlTable(
  'plans',
  {
    id: primaryId(),
    // Chave estável usada no código e no seed (`free`, `team`, `enterprise`).
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 96 }).notNull(),
    description: varchar('description', { length: 512 }),
    // Dinheiro em inteiro na menor unidade (centavos), nunca ponto flutuante.
    priceCents: int('price_cents').notNull().default(0),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    billingPeriod: mysqlEnum('billing_period', planBillingPeriod).notNull().default('none'),
    maxMembers: int('max_members').notNull().default(3),
    maxProjects: int('max_projects').notNull().default(1),
    maxAgentRunsPerMonth: int('max_agent_runs_per_month').notNull().default(200),
    maxStorageBytes: bigint('max_storage_bytes', { mode: 'number', unsigned: true })
      .notNull()
      .default(1_073_741_824),
    retentionDays: int('retention_days').notNull().default(30),
    // Plano atribuído a organizações novas quando nada for informado.
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    features: json('features').$type<Record<string, unknown>>(),
    ...timestamps(),
    version: version(),
  },
  (table) => [uniqueIndex('uq_plans_code').on(table.code), index('idx_plans_active').on(table.isActive)],
);

export const organizationStatus = ['active', 'suspended', 'pending_deletion'] as const;

export const organizations = mysqlTable(
  'organizations',
  {
    id: primaryId(),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    planId: ulidColumn('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    ownerUserId: ulidColumn('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    billingEmail: varchar('billing_email', { length: 320 }),
    status: mysqlEnum('status', organizationStatus).notNull().default('active'),
    // Política da organização — camada mais alta da precedência do `Docs/09`.
    policy: json('policy').$type<Record<string, unknown>>(),
    settings: json('settings').$type<Record<string, unknown>>(),
    // Retenção própria; quando nulo, vale a do plano.
    retentionDays: int('retention_days'),
    ...auditColumns(),
    // Exclusão de organização é reversível dentro da janela de retenção.
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('uq_organizations_slug').on(table.slug),
    index('idx_organizations_created_at').on(table.createdAt),
    index('idx_organizations_status_updated_at').on(table.status, table.updatedAt),
  ],
);

export const roles = mysqlTable(
  'roles',
  {
    id: primaryId(),
    // Nulo = papel padrão do sistema, compartilhado por todas as organizações.
    // Preenchido = papel personalizado, visível apenas naquele tenant.
    organizationId: ulidColumn('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 96 }).notNull(),
    description: varchar('description', { length: 512 }),
    isSystem: boolean('is_system').notNull().default(false),
    // Precedência entre papéis: maior vence em comparações de privilégio.
    priority: int('priority').notNull().default(0),
    // Papel aplicado a quem entra na organização sem papel explícito.
    isDefault: boolean('is_default').notNull().default(false),
    // Coluna gerada só para a unicidade: o MySQL trata cada NULL como
    // distinto, então `(organization_id, slug)` sozinho não impediria dois
    // papéis de sistema com o mesmo slug.
    systemSlug: varchar('system_slug', { length: 64 }).generatedAlwaysAs(
      sql`(case when \`organization_id\` is null then \`slug\` else null end)`,
      { mode: 'virtual' },
    ),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_roles_organization_slug').on(table.organizationId, table.slug),
    uniqueIndex('uq_roles_system_slug').on(table.systemSlug),
  ],
);

export const rolePermissions = mysqlTable(
  'role_permissions',
  {
    roleId: ulidColumn('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    // Permissão granular do `Docs/09` (`chat.write`, `audit.read`, …). Fica
    // como texto para que uma permissão nova não exija migração de enum.
    permission: varchar('permission', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  // Junção pura: a chave natural já identifica a linha, não há ULID próprio.
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

export const membershipStatus = ['invited', 'active', 'suspended'] as const;

export const organizationMembers = mysqlTable(
  'organization_members',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: ulidColumn('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    status: mysqlEnum('status', membershipStatus).notNull().default('active'),
    invitedBy: ulidColumn('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: utcDatetime('joined_at'),
    lastActiveAt: utcDatetime('last_active_at'),
    ...auditColumns(),
  },
  (table) => [
    // Unique natural do membership: uma pessoa, um vínculo por organização.
    uniqueIndex('uq_organization_members_org_user').on(table.organizationId, table.userId),
    index('idx_organization_members_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_organization_members_user').on(table.userId, table.status),
  ],
);

export const invitationStatus = ['pending', 'accepted', 'revoked', 'expired'] as const;

export const invitations = mysqlTable(
  'invitations',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    roleId: ulidColumn('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    // SEGREDO: SHA-256 hexadecimal do token do convite. O link com o valor
    // puro existe só no e-mail enviado.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    status: mysqlEnum('status', invitationStatus).notNull().default('pending'),
    message: text('message'),
    invitedBy: ulidColumn('invited_by').references(() => users.id, { onDelete: 'set null' }),
    acceptedByUserId: ulidColumn('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: utcDatetime('expires_at').notNull(),
    acceptedAt: utcDatetime('accepted_at'),
    revokedAt: utcDatetime('revoked_at'),
    // Mesma técnica de `roles.system_slug`: garante um único convite aberto
    // por e-mail sem impedir reenvio depois de revogado ou expirado.
    pendingEmail: varchar('pending_email', { length: 320 }).generatedAlwaysAs(
      sql`(case when \`status\` = 'pending' then \`email\` else null end)`,
      { mode: 'virtual' },
    ),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_invitations_token_hash').on(table.tokenHash),
    // Unique natural do convite: um convite pendente por e-mail e organização.
    uniqueIndex('uq_invitations_org_pending_email').on(table.organizationId, table.pendingEmail),
    index('idx_invitations_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_invitations_email_status').on(table.email, table.status),
  ],
);
