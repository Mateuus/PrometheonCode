/**
 * Leitura de planos e do consumo da organização.
 *
 * O uso é sempre contado no banco, na hora. Um contador materializado ficaria
 * mais barato e erraria em silêncio: o limite que este módulo cobra é o que
 * decide se uma criação passa, e ele não pode depender de um número que alguém
 * esqueceu de atualizar.
 */

import {
  agentRuns,
  knowledgeItems,
  organizationMembers,
  organizations,
  plans,
  projects,
  type Database,
} from '@prometheon/database';
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm';

export type PlanRow = typeof plans.$inferSelect;

export interface OrganizationPlanRow {
  readonly organizationId: string;
  readonly organizationStatus: 'active' | 'suspended' | 'pending_deletion';
  readonly organizationCreatedAt: Date;
  readonly organizationVersion: number;
  readonly plan: PlanRow;
}

export interface UsageCounts {
  readonly members: number;
  readonly projects: number;
  readonly knowledgeItems: number;
  readonly agentRunsThisMonth: number;
}

/** Primeiro instante do mês corrente em UTC. */
export function startOfMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class BillingRepository {
  constructor(private readonly db: Database) {}

  async listPlans(options: { activeOnly?: boolean } = {}): Promise<PlanRow[]> {
    const query = this.db.select().from(plans);

    if (options.activeOnly === true) {
      return query.where(eq(plans.isActive, true)).orderBy(asc(plans.priceCents), asc(plans.code));
    }

    return query.orderBy(asc(plans.priceCents), asc(plans.code));
  }

  async findPlanByCode(code: string): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(plans).where(eq(plans.code, code)).limit(1);

    return row;
  }

  /** Plano vigente da organização, junto do que a troca precisa saber. */
  async findOrganizationPlan(organizationId: string): Promise<OrganizationPlanRow | undefined> {
    const [row] = await this.db
      .select({
        organizationId: organizations.id,
        organizationStatus: organizations.status,
        organizationCreatedAt: organizations.createdAt,
        organizationVersion: organizations.version,
        plan: plans,
      })
      .from(organizations)
      .innerJoin(plans, eq(plans.id, organizations.planId))
      .where(eq(organizations.id, organizationId))
      .limit(1);

    return row;
  }

  /**
   * Troca o plano com concorrência otimista.
   *
   * Devolve `false` quando a versão não confere — quem chama transforma isso em
   * `VERSION_CONFLICT` em vez de sobrescrever a decisão de outra pessoa.
   */
  async changePlan(input: {
    organizationId: string;
    planId: string;
    version: number;
    actorId: string;
  }): Promise<boolean> {
    const result = await this.db
      .update(organizations)
      .set({
        planId: input.planId,
        version: sql`${organizations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(organizations.id, input.organizationId),
          eq(organizations.version, input.version),
          isNull(organizations.deletedAt),
        ),
      );

    return result[0].affectedRows > 0;
  }

  async countMembers(organizationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.status, 'active'),
        ),
      );

    return row?.value ?? 0;
  }

  async countProjects(organizationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), isNull(projects.deletedAt)));

    return row?.value ?? 0;
  }

  async countKnowledgeItems(organizationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(knowledgeItems)
      .where(
        and(eq(knowledgeItems.organizationId, organizationId), isNull(knowledgeItems.deletedAt)),
      );

    return row?.value ?? 0;
  }

  async countAgentRunsThisMonth(organizationId: string, now?: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.organizationId, organizationId),
          gte(agentRuns.createdAt, startOfMonth(now)),
        ),
      );

    return row?.value ?? 0;
  }

  async usage(organizationId: string, now?: Date): Promise<UsageCounts> {
    const [members, projectCount, knowledgeCount, runs] = await Promise.all([
      this.countMembers(organizationId),
      this.countProjects(organizationId),
      this.countKnowledgeItems(organizationId),
      this.countAgentRunsThisMonth(organizationId, now),
    ]);

    return {
      members,
      projects: projectCount,
      knowledgeItems: knowledgeCount,
      agentRunsThisMonth: runs,
    };
  }
}
