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
  type Plan,
} from '@prometheon/database';
import { IsNull, MoreThanOrEqual } from 'typeorm';

import { affectedRows } from '../../shared/query.js';

export type PlanRow = Plan;

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

/** Colunas da organização que acompanham o plano na mesma leitura. */
interface OrganizationColumns {
  organizationId: string;
  organizationStatus: OrganizationPlanRow['organizationStatus'];
  organizationCreatedAt: Date;
  organizationVersion: number;
}

/** Primeiro instante do mês corrente em UTC. */
export function startOfMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class BillingRepository {
  constructor(private readonly db: Database) {}

  async listPlans(options: { activeOnly?: boolean } = {}): Promise<PlanRow[]> {
    return this.db.manager.find(plans, {
      ...(options.activeOnly === true ? { where: { isActive: true } } : {}),
      order: { priceCents: 'ASC', code: 'ASC' },
    });
  }

  async findPlanByCode(code: string): Promise<PlanRow | undefined> {
    const row = await this.db.manager.findOne(plans, { where: { code } });

    return row ?? undefined;
  }

  /**
   * Plano vigente da organização, junto do que a troca precisa saber.
   *
   * A consulta parte de `plans` e junta `organizations` para que o plano venha
   * **hidratado** — os tetos passam pelos transformadores das colunas, e não
   * pelo que o driver devolveria numa linha crua. As quatro colunas da
   * organização vêm no lado cru da mesma consulta: uma leitura só, sem janela
   * em que o plano pudesse trocar entre duas idas ao banco.
   */
  async findOrganizationPlan(organizationId: string): Promise<OrganizationPlanRow | undefined> {
    const result = await this.db.manager
      .createQueryBuilder(plans, 'plan')
      .addSelect('organization.id', 'organizationId')
      .addSelect('organization.status', 'organizationStatus')
      .addSelect('organization.createdAt', 'organizationCreatedAt')
      .addSelect('organization.version', 'organizationVersion')
      .innerJoin(organizations.options.name, 'organization', 'organization.planId = plan.id')
      .where('organization.id = :organizationId', { organizationId })
      .limit(1)
      .getRawAndEntities<OrganizationColumns>();

    const plan = result.entities[0];
    const row = result.raw[0];

    if (plan === undefined || row === undefined) {
      return undefined;
    }

    return {
      organizationId: row.organizationId,
      organizationStatus: row.organizationStatus,
      organizationCreatedAt: row.organizationCreatedAt,
      organizationVersion: row.organizationVersion,
      plan,
    };
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
    const result = await this.db.manager
      .createQueryBuilder()
      .update(organizations)
      .set({
        planId: input.planId,
        version: () => 'version + 1',
        updatedAt: new Date(),
      })
      .where('id = :organizationId', { organizationId: input.organizationId })
      .andWhere('version = :version', { version: input.version })
      .andWhere('deleted_at IS NULL')
      .execute();

    return affectedRows(result) > 0;
  }

  async countMembers(organizationId: string): Promise<number> {
    return this.db.manager.count(organizationMembers, {
      where: { organizationId, status: 'active' },
    });
  }

  async countProjects(organizationId: string): Promise<number> {
    return this.db.manager.count(projects, {
      where: { organizationId, deletedAt: IsNull() },
    });
  }

  async countKnowledgeItems(organizationId: string): Promise<number> {
    return this.db.manager.count(knowledgeItems, {
      where: { organizationId, deletedAt: IsNull() },
    });
  }

  async countAgentRunsThisMonth(organizationId: string, now?: Date): Promise<number> {
    return this.db.manager.count(agentRuns, {
      where: { organizationId, createdAt: MoreThanOrEqual(startOfMonth(now)) },
    });
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
