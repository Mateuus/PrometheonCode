/**
 * Regras de plano e assinatura.
 *
 * O MVP tem um único plano gratuito, mas nada aqui assume isso: o plano é
 * sempre lido da tabela, o vínculo é `organizations.plan_id`, e a troca é uma
 * operação de administração com concorrência otimista e auditoria.
 */

import { PLAN_FEATURES, type Plan, type PlanFeature } from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { toIso } from '../../shared/time.js';
import { planLimitExceeded, planNotFound, subscriptionNotFound, versionConflict } from './errors.js';
import { violationsAgainstPlan } from './limits.js';
import { BillingRepository, type OrganizationPlanRow, type PlanRow, type UsageCounts } from './repository.js';

export interface SubscriptionView {
  organizationId: string;
  planCode: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  startedAt: string;
  currentPeriodEnd: string | null;
  version: number;
}

export interface PlanChangeInput {
  readonly organizationId: string;
  readonly planCode: string;
  readonly version: number;
  readonly actorId: string;
}

export interface PlanChangeResult {
  readonly previousPlanCode: string;
  readonly plan: Plan;
  readonly subscription: SubscriptionView;
}

/**
 * `plans.features` é JSON livre.
 *
 * Aceita tanto `["web_chat"]` quanto `{ "enabled": ["web_chat"] }`, e descarta
 * o que não for uma feature conhecida — uma coluna JSON escrita à mão não pode
 * derrubar a listagem de planos.
 */
export function toFeatures(value: unknown): PlanFeature[] {
  const known = new Set<string>(PLAN_FEATURES);
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { enabled?: unknown }).enabled)
      ? ((value as { enabled: unknown[] }).enabled)
      : [];

  return candidates.filter((item): item is PlanFeature => typeof item === 'string' && known.has(item));
}

/** `0` ou menos numa coluna de limite significa "sem teto". */
function toLimit(value: number): number | null {
  return value <= 0 ? null : value;
}

export function toPlanView(row: PlanRow): Plan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    price: { amount: row.priceCents, currency: row.currency },
    billingPeriod: row.billingPeriod,
    limits: {
      maxMembers: toLimit(row.maxMembers),
      maxProjects: toLimit(row.maxProjects),
      maxKnowledgeItems: toLimit(row.maxKnowledgeItems),
      maxAgentRunsPerMonth: toLimit(row.maxAgentRunsPerMonth),
      maxStorageBytes: toLimit(row.maxStorageBytes),
      retentionDays: toLimit(row.retentionDays),
    },
    features: toFeatures(row.features),
    isDefault: row.isDefault,
    isActive: row.isActive,
  };
}

/**
 * Situação da assinatura a partir da situação da organização.
 *
 * Não há ciclo de cobrança no plano gratuito, então `currentPeriodEnd` é nulo.
 * Organização suspensa vira `past_due`; em exclusão, `canceled`.
 */
function toSubscriptionView(row: OrganizationPlanRow): SubscriptionView {
  const status =
    row.organizationStatus === 'active'
      ? ('active' as const)
      : row.organizationStatus === 'suspended'
        ? ('past_due' as const)
        : ('canceled' as const);

  return {
    organizationId: row.organizationId,
    planCode: row.plan.code,
    status,
    startedAt: toIso(row.organizationCreatedAt),
    currentPeriodEnd: null,
    version: row.organizationVersion,
  };
}

export class BillingService {
  private readonly repository: BillingRepository;

  constructor(db: Database) {
    this.repository = new BillingRepository(db);
  }

  async listPlans(options: { includeInactive?: boolean } = {}): Promise<Plan[]> {
    const rows = await this.repository.listPlans({
      activeOnly: options.includeInactive !== true,
    });

    return rows.map(toPlanView);
  }

  async overview(organizationId: string): Promise<{
    subscription: SubscriptionView;
    plan: Plan;
    usage: UsageCounts & { measuredAt: string };
  }> {
    const row = await this.repository.findOrganizationPlan(organizationId);

    if (row === undefined) {
      throw subscriptionNotFound();
    }

    const usage = await this.repository.usage(organizationId);

    return {
      subscription: toSubscriptionView(row),
      plan: toPlanView(row.plan),
      usage: { ...usage, measuredAt: toIso(new Date()) },
    };
  }

  /**
   * Troca o plano da organização.
   *
   * Rebaixar só é aceito quando o consumo atual cabe no plano novo: aprovar a
   * troca e deixar o tenant acima do teto criaria um estado que nenhuma rota
   * conserta — nem criar, nem apagar em massa.
   */
  async changePlan(input: PlanChangeInput): Promise<PlanChangeResult> {
    const current = await this.repository.findOrganizationPlan(input.organizationId);

    if (current === undefined) {
      throw subscriptionNotFound();
    }

    const target = await this.repository.findPlanByCode(input.planCode);

    if (!target?.isActive) {
      throw planNotFound(input.planCode);
    }

    if (target.id !== current.plan.id) {
      const violations = await violationsAgainstPlan(
        this.repository,
        input.organizationId,
        target,
      );
      const first = violations[0];

      if (first !== undefined) {
        throw planLimitExceeded(first);
      }
    }

    const changed = await this.repository.changePlan({
      organizationId: input.organizationId,
      planId: target.id,
      version: input.version,
      actorId: input.actorId,
    });

    if (!changed) {
      throw versionConflict();
    }

    const refreshed = await this.repository.findOrganizationPlan(input.organizationId);

    if (refreshed === undefined) {
      throw subscriptionNotFound();
    }

    return {
      previousPlanCode: current.plan.code,
      plan: toPlanView(refreshed.plan),
      subscription: toSubscriptionView(refreshed),
    };
  }
}
