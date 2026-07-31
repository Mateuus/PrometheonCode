/**
 * Leitura e escrita da administração da plataforma.
 *
 * Duas coisas separam este repositório do de `billing`: ele atravessa todas as
 * organizações (nenhuma consulta é filtrada por tenant) e ele **escreve** em
 * `plans`, que para o resto da aplicação é tabela só de leitura.
 */

import {
  newId,
  organizations,
  plans,
  users,
  writable,
  type Database,
  type Plan,
} from '@prometheon/database';
import { In, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

import { applyKeyset, affectedRows, escapeLike } from '../../shared/query.js';
import type { CursorPayload } from '../../shared/cursor.js';
import type { LimitOverrides } from '../billing/repository.js';

export type PlanRow = Plan;

/** Uma organização como a administração da plataforma a enxerga. */
export interface AdminOrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'pending_deletion';
  createdAt: Date;
  version: number;
  planCode: string;
  planName: string;
  ownerEmail: string | null;
  overrides: LimitOverrides;
  plan: PlanRow;
}

interface RawOrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: AdminOrganizationRow['status'];
  created_at: Date;
  version: number;
  plan_id: string;
  owner_email: string | null;
  max_members: unknown;
  max_projects: unknown;
  max_knowledge_items: unknown;
  max_agent_runs_per_month: unknown;
  max_storage_bytes: unknown;
  retention_days: unknown;
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/** Campos de plano que a escrita aceita; `code` fica de fora de propósito. */
export interface PlanWrite {
  name?: string;
  description?: string | null;
  priceCents?: number;
  currency?: string;
  billingPeriod?: 'none' | 'monthly' | 'yearly';
  maxMembers?: number;
  maxProjects?: number;
  maxKnowledgeItems?: number;
  maxAgentRunsPerMonth?: number;
  maxStorageBytes?: number;
  retentionDays?: number;
  features?: Record<string, unknown> | null;
  isDefault?: boolean;
  isActive?: boolean;
}

export class AdminRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Planos
  // -------------------------------------------------------------------------

  async listPlans(): Promise<PlanRow[]> {
    // Sem filtro de `isActive`: quem administra precisa ver o plano escondido
    // justamente para poder reativá-lo.
    return this.db.manager.find(plans, { order: { priceCents: 'ASC', code: 'ASC' } });
  }

  async findPlanByCode(code: string): Promise<PlanRow | undefined> {
    return (await this.db.manager.findOne(plans, { where: { code } })) ?? undefined;
  }

  async createPlan(input: PlanWrite & { code: string; name: string }): Promise<string> {
    const id = newId();

    await this.db.manager.insert(plans, writable<Plan>({ id, ...input }));

    return id;
  }

  async updatePlan(id: string, changes: PlanWrite): Promise<boolean> {
    if (Object.keys(changes).length === 0) {
      return true;
    }

    const result = await this.db.manager
      .createQueryBuilder()
      .update(plans)
      .set({ ...writable<Plan>(changes), version: () => 'version + 1', updatedAt: new Date() })
      .where('id = :id', { id })
      .execute();

    return affectedRows(result) > 0;
  }

  /**
   * Tira a marca de padrão dos demais planos.
   *
   * Dois planos padrão fariam a criação de organização depender da ordem da
   * consulta — e é o tipo de bug que só aparece meses depois, num tenant novo.
   */
  async clearDefaultExcept(id: string): Promise<void> {
    await this.db.manager
      .createQueryBuilder()
      .update(plans)
      .set({ isDefault: false, updatedAt: new Date() })
      .where('id <> :id', { id })
      .andWhere('is_default = true')
      .execute();
  }

  async countOrganizationsOnPlan(planId: string): Promise<number> {
    return this.db.manager.count(organizations, { where: { planId } });
  }

  // -------------------------------------------------------------------------
  // Organizações
  // -------------------------------------------------------------------------

  private organizationQuery(): SelectQueryBuilder<ObjectLiteral> {
    return this.db.manager
      .createQueryBuilder()
      .select([
        'organization.id AS id',
        'organization.name AS name',
        'organization.slug AS slug',
        'organization.status AS status',
        'organization.created_at AS created_at',
        'organization.version AS version',
        'organization.plan_id AS plan_id',
        'organization.max_members AS max_members',
        'organization.max_projects AS max_projects',
        'organization.max_knowledge_items AS max_knowledge_items',
        'organization.max_agent_runs_per_month AS max_agent_runs_per_month',
        'organization.max_storage_bytes AS max_storage_bytes',
        'organization.retention_days AS retention_days',
        'owner.email AS owner_email',
      ])
      .from(organizations, 'organization')
      .leftJoin(users.options.name, 'owner', 'owner.id = organization.owner_user_id')
      .where('organization.deleted_at IS NULL');
  }

  /**
   * Uma página de organizações, da mais nova para a mais antiga.
   *
   * O plano vem hidratado de `plans` — os tetos precisam passar pelos
   * transformadores das colunas, e `max_storage_bytes` é `bigint`.
   */
  async listOrganizations(input: {
    limit: number;
    after: CursorPayload | undefined;
    search?: string | undefined;
    planCode?: string | undefined;
  }): Promise<AdminOrganizationRow[]> {
    let query = this.organizationQuery();

    if (input.search !== undefined && input.search !== '') {
      query = query.andWhere('(organization.name LIKE :term OR organization.slug LIKE :term)', {
        term: `%${escapeLike(input.search)}%`,
      });
    }

    if (input.planCode !== undefined) {
      query = query.andWhere(
        'organization.plan_id = (SELECT id FROM plans WHERE code = :planCode)',
        { planCode: input.planCode },
      );
    }

    query = applyKeyset(query, 'organization', { createdAt: 'created_at', id: 'id' }, input.after);

    const rows = await query
      .orderBy('organization.created_at', 'DESC')
      .addOrderBy('organization.id', 'DESC')
      .limit(input.limit + 1)
      .getRawMany<RawOrganizationRow>();

    const planIds = [...new Set(rows.map((row) => row.plan_id))];
    const planRows =
      planIds.length === 0
        ? []
        : await this.db.manager.find(plans, { where: { id: In(planIds) } });
    const planById = new Map(planRows.map((plan) => [plan.id, plan]));

    return rows.flatMap((row) => {
      const plan = planById.get(row.plan_id);

      // Organização apontando para um plano que sumiu não existe pelo schema
      // (há chave estrangeira); se existisse, listá-la sem plano só produziria
      // uma linha que nenhuma tela sabe desenhar.
      return plan === undefined ? [] : [toAdminOrganizationRow(row, plan)];
    });
  }

  async findOrganization(organizationId: string): Promise<AdminOrganizationRow | undefined> {
    const row = await this.organizationQuery()
      .andWhere('organization.id = :organizationId', { organizationId })
      .getRawOne<RawOrganizationRow>();

    if (row === undefined) {
      return undefined;
    }

    const plan = await this.db.manager.findOne(plans, { where: { id: row.plan_id } });

    return plan === null ? undefined : toAdminOrganizationRow(row, plan);
  }

  /** Grava as exceções de limite. `null` numa chave devolve o teto ao plano. */
  async updateOverrides(organizationId: string, overrides: Partial<LimitOverrides>): Promise<boolean> {
    if (Object.keys(overrides).length === 0) {
      return true;
    }

    const result = await this.db.manager
      .createQueryBuilder()
      .update(organizations)
      .set({ ...overrides, version: () => 'version + 1', updatedAt: new Date() })
      .where('id = :organizationId', { organizationId })
      .andWhere('deleted_at IS NULL')
      .execute();

    return affectedRows(result) > 0;
  }

  /**
   * Atribui o plano sem concorrência otimista.
   *
   * A troca feita pelo cliente exige a versão que ele leu (ver `billing`). Aqui
   * quem decide é quem administra a plataforma, e a versão só faria a
   * atribuição falhar porque alguém convidou um membro no mesmo minuto.
   */
  async assignPlan(organizationId: string, planId: string): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .update(organizations)
      .set({ planId, version: () => 'version + 1', updatedAt: new Date() })
      .where('id = :organizationId', { organizationId })
      .andWhere('deleted_at IS NULL')
      .execute();

    return affectedRows(result) > 0;
  }
}

function toAdminOrganizationRow(row: RawOrganizationRow, plan: PlanRow): AdminOrganizationRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    version: row.version,
    planCode: plan.code,
    planName: plan.name,
    ownerEmail: row.owner_email,
    plan,
    overrides: {
      maxMembers: toNullableInt(row.max_members),
      maxProjects: toNullableInt(row.max_projects),
      maxKnowledgeItems: toNullableInt(row.max_knowledge_items),
      maxAgentRunsPerMonth: toNullableInt(row.max_agent_runs_per_month),
      maxStorageBytes: toNullableInt(row.max_storage_bytes),
      retentionDays: toNullableInt(row.retention_days),
    },
  };
}
