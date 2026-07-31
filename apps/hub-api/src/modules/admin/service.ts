/**
 * Regras da administração da plataforma.
 *
 * Três operações, todas fora do alcance de qualquer papel de organização:
 * manter o catálogo de planos, atribuir plano a uma organização e combinar
 * exceções de limite caso a caso.
 *
 * O que **não** está aqui, de propósito: cobrança. A atribuição é manual e
 * registrada em auditoria; quando existir pagamento, ele entra como origem da
 * atribuição, não como substituto dela.
 */

import type {
  AdminOrganization,
  CreatePlanRequest,
  OrganizationLimitOverrides,
  Plan,
  PlanLimitsInput,
  UpdatePlanRequest,
} from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { buildPage, decodeCursor, type CursorPage } from '../../shared/cursor.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { toIso } from '../../shared/time.js';
import { planLimitExceeded, planNotFound } from '../billing/errors.js';
import { effectiveLimits, violationsAgainstPlan, PLAN_LIMIT_FIELDS } from '../billing/limits.js';
import { BillingRepository, type LimitOverrides } from '../billing/repository.js';
import { toPlanView } from '../billing/service.js';
import { AdminRepository, type AdminOrganizationRow, type PlanWrite } from './repository.js';

export interface AssignPlanInput {
  readonly organizationId: string;
  readonly planCode: string;
  readonly allowOverLimit: boolean;
}

export interface AssignPlanResult {
  readonly organization: AdminOrganization;
  readonly previousPlanCode: string;
}

/**
 * Traduz os limites do contrato para as colunas de `plans`.
 *
 * `null` no contrato quer dizer "sem teto", e a coluna guarda isso como zero —
 * a mesma convenção que `toLimit()` lê de volta em `billing`.
 */
function toPlanColumns(limits: PlanLimitsInput | undefined): PlanWrite {
  if (limits === undefined) {
    return {};
  }

  const columns: PlanWrite = {};

  for (const field of PLAN_LIMIT_FIELDS) {
    const value = limits[field];

    if (value !== undefined) {
      columns[field] = value ?? 0;
    }
  }

  return columns;
}

export class AdminService {
  private readonly repository: AdminRepository;
  private readonly billing: BillingRepository;

  constructor(db: Database) {
    this.repository = new AdminRepository(db);
    this.billing = new BillingRepository(db);
  }

  // -------------------------------------------------------------------------
  // Planos
  // -------------------------------------------------------------------------

  async listPlans(): Promise<Plan[]> {
    return (await this.repository.listPlans()).map(toPlanView);
  }

  async createPlan(input: CreatePlanRequest): Promise<Plan> {
    const existing = await this.repository.findPlanByCode(input.code);

    if (existing !== undefined) {
      throw conflict('CONFLICT', `A plan with the code "${input.code}" already exists.`);
    }

    await this.repository.createPlan({
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      currency: input.currency.toUpperCase(),
      billingPeriod: input.billingPeriod,
      features: { enabled: input.features },
      isActive: input.isActive,
      isDefault: false,
      ...toPlanColumns(input.limits),
    });

    const created = await this.repository.findPlanByCode(input.code);

    if (created === undefined) {
      throw notFound('PLAN_NOT_FOUND', `The plan "${input.code}" was not created.`);
    }

    return toPlanView(created);
  }

  async updatePlan(code: string, changes: UpdatePlanRequest): Promise<Plan> {
    const plan = await this.repository.findPlanByCode(code);

    if (plan === undefined) {
      throw planNotFound(code);
    }

    // Desativar o plano padrão deixaria a criação de organização sem destino.
    if (changes.isActive === false && plan.isDefault && changes.isDefault !== true) {
      throw badRequest(
        'VALIDATION_FAILED',
        'The default plan cannot be deactivated. Make another plan the default first.',
      );
    }

    const write: PlanWrite = {
      ...(changes.name === undefined ? {} : { name: changes.name }),
      ...(changes.description === undefined ? {} : { description: changes.description }),
      ...(changes.priceCents === undefined ? {} : { priceCents: changes.priceCents }),
      ...(changes.currency === undefined ? {} : { currency: changes.currency.toUpperCase() }),
      ...(changes.billingPeriod === undefined ? {} : { billingPeriod: changes.billingPeriod }),
      ...(changes.features === undefined ? {} : { features: { enabled: changes.features } }),
      ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
      ...(changes.isDefault === undefined ? {} : { isDefault: changes.isDefault }),
      ...toPlanColumns(changes.limits),
    };

    await this.repository.updatePlan(plan.id, write);

    if (changes.isDefault === true) {
      await this.repository.clearDefaultExcept(plan.id);
    }

    const refreshed = await this.repository.findPlanByCode(code);

    if (refreshed === undefined) {
      throw planNotFound(code);
    }

    return toPlanView(refreshed);
  }

  // -------------------------------------------------------------------------
  // Organizações
  // -------------------------------------------------------------------------

  async listOrganizations(input: {
    limit: number;
    cursor?: string | undefined;
    search?: string | undefined;
    planCode?: string | undefined;
  }): Promise<CursorPage<AdminOrganization>> {
    const rows = await this.repository.listOrganizations({
      limit: input.limit,
      after: input.cursor === undefined ? undefined : decodeCursor(input.cursor),
      ...(input.search === undefined ? {} : { search: input.search }),
      ...(input.planCode === undefined ? {} : { planCode: input.planCode }),
    });

    const page = buildPage(rows, input.limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    // O uso é contado por organização, e a lista é uma página curta: o custo é
    // proporcional ao que está na tela, não ao tamanho da instalação.
    const items = await Promise.all(page.items.map((row) => this.describe(row)));

    return { items, pageInfo: page.pageInfo };
  }

  async getOrganization(organizationId: string): Promise<AdminOrganization> {
    return this.describe(await this.requireOrganization(organizationId));
  }

  /**
   * Atribui um plano à organização.
   *
   * Sem `allowOverLimit`, rebaixar quem já passou do teto é recusado — deixar o
   * tenant acima do limite cria um estado que nenhuma rota conserta. Com a
   * marca, a exceção é aceita e fica no registro de auditoria da rota.
   */
  async assignPlan(input: AssignPlanInput): Promise<AssignPlanResult> {
    const current = await this.requireOrganization(input.organizationId);
    const target = await this.repository.findPlanByCode(input.planCode);

    if (target === undefined) {
      throw planNotFound(input.planCode);
    }

    if (target.id !== current.plan.id && !input.allowOverLimit) {
      const violations = await violationsAgainstPlan(
        this.billing,
        input.organizationId,
        target,
        current.overrides,
      );
      const first = violations[0];

      if (first !== undefined) {
        throw planLimitExceeded(first);
      }
    }

    const assigned = await this.repository.assignPlan(input.organizationId, target.id);

    if (!assigned) {
      throw notFound('ORGANIZATION_NOT_FOUND', 'This organization does not exist.');
    }

    return {
      organization: await this.describe(await this.requireOrganization(input.organizationId)),
      previousPlanCode: current.planCode,
    };
  }

  /** Grava as exceções de limite; o que não vier no corpo fica como está. */
  async updateLimits(
    organizationId: string,
    overrides: OrganizationLimitOverrides,
  ): Promise<AdminOrganization> {
    await this.requireOrganization(organizationId);

    const changes: { -readonly [K in keyof LimitOverrides]?: number | null } = {};

    for (const field of PLAN_LIMIT_FIELDS) {
      const value = overrides[field];

      if (value !== undefined) {
        changes[field] = value;
      }
    }

    const updated = await this.repository.updateOverrides(organizationId, changes);

    if (!updated) {
      throw notFound('ORGANIZATION_NOT_FOUND', 'This organization does not exist.');
    }

    return this.describe(await this.requireOrganization(organizationId));
  }

  private async requireOrganization(organizationId: string): Promise<AdminOrganizationRow> {
    const row = await this.repository.findOrganization(organizationId);

    if (row === undefined) {
      throw notFound('ORGANIZATION_NOT_FOUND', 'This organization does not exist.');
    }

    return row;
  }

  /** Monta a visão do contrato: limites que valem, exceções e consumo medido. */
  private async describe(row: AdminOrganizationRow): Promise<AdminOrganization> {
    const usage = await this.billing.usage(row.id);

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      planCode: row.planCode,
      planName: row.planName,
      ownerEmail: row.ownerEmail,
      createdAt: toIso(row.createdAt),
      limits: effectiveLimits(row.plan, row.overrides),
      overrides: {
        maxMembers: row.overrides.maxMembers,
        maxProjects: row.overrides.maxProjects,
        maxKnowledgeItems: row.overrides.maxKnowledgeItems,
        maxAgentRunsPerMonth: row.overrides.maxAgentRunsPerMonth,
        maxStorageBytes: row.overrides.maxStorageBytes,
        retentionDays: row.overrides.retentionDays,
      },
      usage: { ...usage, measuredAt: toIso(new Date()) },
      version: row.version,
    };
  }
}
