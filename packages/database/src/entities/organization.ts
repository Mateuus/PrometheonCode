// Organização: o tenant. Plano, membros, papéis e convites.
//
// `plans` não está listado no `Docs/07`, mas o `Docs/HUB_PLANO_DE_EXECUCAO`
// (fase 3) fala em "planos e limites" e o seed exige um plano gratuito — daí a
// tabela. Todo valor monetário é inteiro na menor unidade da moeda.

import { EntitySchema } from 'typeorm';

import {
  auditColumns,
  createdAt,
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

/** Periodicidade da cobrança. `none` é o plano gratuito. */
export const planBillingPeriod = ['none', 'monthly', 'yearly'] as const;
export type PlanBillingPeriod = (typeof planBillingPeriod)[number];

export interface Plan extends TimestampFields {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  billingPeriod: PlanBillingPeriod;
  maxMembers: number;
  maxProjects: number;
  maxKnowledgeItems: number;
  maxAgentRunsPerMonth: number;
  maxStorageBytes: number;
  retentionDays: number;
  isDefault: boolean;
  isActive: boolean;
  features: Record<string, unknown> | null;
  version: number;
}

export const plans = new EntitySchema<Plan>({
  name: 'plans',
  tableName: 'plans',
  columns: {
    id: primaryId(),
    // Chave estável usada no código e no seed (`free`, `team`, `enterprise`).
    code: requiredText('code', 32),
    name: requiredText('name', 96),
    description: text('description', 512),
    // Dinheiro em inteiro na menor unidade (centavos), nunca ponto flutuante.
    priceCents: { type: 'int', name: 'price_cents', nullable: false, default: 0 },
    currency: requiredText('currency', 3, { default: 'USD' }),
    billingPeriod: enumColumn('billing_period', planBillingPeriod, { default: 'none' }),
    maxMembers: { type: 'int', name: 'max_members', nullable: false, default: 3 },
    maxProjects: { type: 'int', name: 'max_projects', nullable: false, default: 1 },
    maxAgentRunsPerMonth: {
      type: 'int',
      name: 'max_agent_runs_per_month',
      nullable: false,
      default: 200,
    },
    maxStorageBytes: unsignedBigint('max_storage_bytes', { default: 1_073_741_824 }),
    retentionDays: { type: 'int', name: 'retention_days', nullable: false, default: 30 },
    // Plano atribuído a organizações novas quando nada for informado.
    isDefault: { type: 'boolean', name: 'is_default', nullable: false, default: false },
    isActive: { type: 'boolean', name: 'is_active', nullable: false, default: true },
    features: jsonColumn('features'),
    ...timestamps(),
    version: version(),
    // Itens de conhecimento por organização. O teto existe porque o cérebro
    // coletivo é o que mais cresce sem alguém pedir (`Docs/10`). Declarado por
    // último porque foi acrescentado pela migration `0001`, e a ordem das
    // colunas na entidade acompanha a ordem física da tabela.
    maxKnowledgeItems: {
      type: 'int',
      name: 'max_knowledge_items',
      nullable: false,
      default: 500,
    },
  },
  uniques: [{ name: 'uq_plans_code', columns: ['code'] }],
  indices: [{ name: 'idx_plans_active', columns: ['isActive'] }],
});

export const organizationStatus = ['active', 'suspended', 'pending_deletion'] as const;
export type OrganizationStatus = (typeof organizationStatus)[number];

export interface Organization extends AuditFields {
  id: string;
  slug: string;
  name: string;
  planId: string;
  ownerUserId: string | null;
  billingEmail: string | null;
  status: OrganizationStatus;
  policy: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  retentionDays: number | null;
  deletedAt: Date | null;
}

export const organizations = new EntitySchema<Organization>({
  name: 'organizations',
  tableName: 'organizations',
  columns: {
    id: primaryId(),
    slug: requiredText('slug', 64),
    name: requiredText('name', 160),
    planId: requiredUlidColumn('plan_id'),
    ownerUserId: ulidColumn('owner_user_id'),
    billingEmail: text('billing_email', 320),
    status: enumColumn('status', organizationStatus, { default: 'active' }),
    // Política da organização — camada mais alta da precedência do `Docs/09`.
    policy: jsonColumn('policy'),
    settings: jsonColumn('settings'),
    // Retenção própria; quando nulo, vale a do plano.
    retentionDays: { type: 'int', name: 'retention_days', nullable: true },
    ...auditColumns(),
    // Exclusão de organização é reversível dentro da janela de retenção.
    deletedAt: deletedAt(),
  },
  uniques: [{ name: 'uq_organizations_slug', columns: ['slug'] }],
  indices: [
    { name: 'idx_organizations_created_at', columns: ['createdAt'] },
    { name: 'idx_organizations_status_updated_at', columns: ['status', 'updatedAt'] },
  ],
});

export interface Role extends TimestampFields {
  id: string;
  organizationId: string | null;
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  priority: number;
  isDefault: boolean;
  /** Coluna gerada pelo banco; nunca é escrita pela aplicação. */
  systemSlug: string | null;
  version: number;
}

export const roles = new EntitySchema<Role>({
  name: 'roles',
  tableName: 'roles',
  columns: {
    id: primaryId(),
    // Nulo = papel padrão do sistema, compartilhado por todas as organizações.
    // Preenchido = papel personalizado, visível apenas naquele tenant.
    organizationId: ulidColumn('organization_id'),
    slug: requiredText('slug', 64),
    name: requiredText('name', 96),
    description: text('description', 512),
    isSystem: { type: 'boolean', name: 'is_system', nullable: false, default: false },
    // Precedência entre papéis: maior vence em comparações de privilégio.
    priority: { type: 'int', name: 'priority', nullable: false, default: 0 },
    // Papel aplicado a quem entra na organização sem papel explícito.
    isDefault: { type: 'boolean', name: 'is_default', nullable: false, default: false },
    // Coluna gerada só para a unicidade: o MySQL trata cada NULL como
    // distinto, então `(organization_id, slug)` sozinho não impediria dois
    // papéis de sistema com o mesmo slug.
    systemSlug: {
      type: 'varchar',
      name: 'system_slug',
      length: 64,
      nullable: true,
      asExpression: "(case when `organization_id` is null then `slug` else null end)",
      generatedType: 'VIRTUAL',
      insert: false,
      update: false,
    },
    ...timestamps(),
    version: version(),
  },
  uniques: [
    { name: 'uq_roles_organization_slug', columns: ['organizationId', 'slug'] },
    { name: 'uq_roles_system_slug', columns: ['systemSlug'] },
  ],
});

export interface RolePermission {
  roleId: string;
  permission: string;
  createdAt: Date;
}

export const rolePermissions = new EntitySchema<RolePermission>({
  name: 'role_permissions',
  tableName: 'role_permissions',
  // Junção pura: a chave natural já identifica a linha, não há ULID próprio.
  columns: {
    roleId: { type: 'char', length: 26, name: 'role_id', primary: true, nullable: false },
    // Permissão granular do `Docs/09` (`chat.write`, `audit.read`, …). Fica
    // como texto para que uma permissão nova não exija migração de enum.
    permission: { type: 'varchar', length: 64, name: 'permission', primary: true, nullable: false },
    createdAt: createdAt(),
  },
});

export const membershipStatus = ['invited', 'active', 'suspended'] as const;
export type MembershipStatus = (typeof membershipStatus)[number];

export interface OrganizationMember extends AuditFields {
  id: string;
  organizationId: string;
  userId: string;
  roleId: string;
  status: MembershipStatus;
  invitedBy: string | null;
  joinedAt: Date | null;
  lastActiveAt: Date | null;
}

export const organizationMembers = new EntitySchema<OrganizationMember>({
  name: 'organization_members',
  tableName: 'organization_members',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    userId: requiredUlidColumn('user_id'),
    roleId: requiredUlidColumn('role_id'),
    status: enumColumn('status', membershipStatus, { default: 'active' }),
    invitedBy: ulidColumn('invited_by'),
    joinedAt: utcDatetime('joined_at'),
    lastActiveAt: utcDatetime('last_active_at'),
    ...auditColumns(),
  },
  uniques: [
    // Unique natural do membership: uma pessoa, um vínculo por organização.
    { name: 'uq_organization_members_org_user', columns: ['organizationId', 'userId'] },
  ],
  indices: [
    { name: 'idx_organization_members_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_organization_members_user', columns: ['userId', 'status'] },
  ],
});

export const invitationStatus = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof invitationStatus)[number];

export interface Invitation extends AuditFields {
  id: string;
  organizationId: string;
  email: string;
  roleId: string;
  tokenHash: string;
  status: InvitationStatus;
  message: string | null;
  invitedBy: string | null;
  acceptedByUserId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  /** Coluna gerada pelo banco; nunca é escrita pela aplicação. */
  pendingEmail: string | null;
}

export const invitations = new EntitySchema<Invitation>({
  name: 'invitations',
  tableName: 'invitations',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    email: requiredText('email', 320),
    roleId: requiredUlidColumn('role_id'),
    // SEGREDO: SHA-256 hexadecimal do token do convite. O link com o valor
    // puro existe só no e-mail enviado.
    tokenHash: requiredText('token_hash', 64),
    status: enumColumn('status', invitationStatus, { default: 'pending' }),
    message: { type: 'text', name: 'message', nullable: true },
    invitedBy: ulidColumn('invited_by'),
    acceptedByUserId: ulidColumn('accepted_by_user_id'),
    expiresAt: { type: 'datetime', precision: 3, name: 'expires_at', nullable: false },
    acceptedAt: utcDatetime('accepted_at'),
    revokedAt: utcDatetime('revoked_at'),
    // Mesma técnica de `roles.system_slug`: garante um único convite aberto
    // por e-mail sem impedir reenvio depois de revogado ou expirado.
    pendingEmail: {
      type: 'varchar',
      name: 'pending_email',
      length: 320,
      nullable: true,
      asExpression: "(case when `status` = 'pending' then `email` else null end)",
      generatedType: 'VIRTUAL',
      insert: false,
      update: false,
    },
    ...auditColumns(),
  },
  uniques: [
    { name: 'uq_invitations_token_hash', columns: ['tokenHash'] },
    // Unique natural do convite: um convite pendente por e-mail e organização.
    { name: 'uq_invitations_org_pending_email', columns: ['organizationId', 'pendingEmail'] },
  ],
  indices: [
    { name: 'idx_invitations_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_invitations_email_status', columns: ['email', 'status'] },
  ],
});
