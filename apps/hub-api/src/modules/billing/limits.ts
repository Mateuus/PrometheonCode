/**
 * Aplicação dos limites do plano.
 *
 * Um limite que aparece na tela e não é verificado no servidor é decoração:
 * quem quiser passar dele só precisa chamar a API direto. Por isso o teto é
 * cobrado **aqui**, imediatamente antes da escrita, contando o que já existe no
 * banco — nunca a partir de um número que o cliente enviou.
 *
 * Este módulo é a porta única desse cálculo. Qualquer rota que crie recurso
 * limitado por plano — projeto, membro, item de conhecimento, execução de
 * agente — chama `assertPlanLimit()` antes de gravar, e recebe de graça a
 * mensagem de erro padronizada com o teto, o consumo e o que fazer.
 *
 * ```ts
 * await assertPlanLimit(app.db, { organizationId, limit: 'maxProjects' });
 * ```
 */

import type { PlanLimitViolation } from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { planLimitExceeded, subscriptionNotFound } from './errors.js';
import {
  BillingRepository,
  EMPTY_OVERRIDES,
  type LimitOverrides,
  type PlanRow,
} from './repository.js';

/**
 * Tetos que o servidor sabe contar.
 *
 * `maxStorageBytes` fica de fora de propósito: não há medição de armazenamento
 * ainda, e cobrar um limite contra um número inventado seria pior que não
 * cobrá-lo. Ele entra aqui quando existir a medição.
 */
export const COUNTABLE_PLAN_LIMITS = [
  'maxMembers',
  'maxProjects',
  'maxKnowledgeItems',
  'maxAgentRunsPerMonth',
] as const;

export type CountablePlanLimit = (typeof COUNTABLE_PLAN_LIMITS)[number];

export interface AssertPlanLimitInput {
  readonly organizationId: string;
  readonly limit: CountablePlanLimit;
  /** Quantos registros a operação vai criar. O padrão é um. */
  readonly additional?: number;
  /** Instante de referência, para o teto mensal não depender do relógio real. */
  readonly now?: Date;
}

/**
 * Valor do teto que vale de fato. Zero ou negativo significa "sem teto".
 *
 * A exceção da organização vence o plano quando existe. É por isso que ela é
 * consultada aqui, e não só na tela: um teto que a interface mostra e o
 * servidor não cobra é decoração, e o inverso — servidor cobrando um teto que
 * a pessoa combinou aumentar — é chamado de suporte.
 */
function allowanceOf(
  plan: PlanRow,
  limit: CountablePlanLimit,
  overrides: LimitOverrides = EMPTY_OVERRIDES,
): number | null {
  const value = overrides[limit] ?? plan[limit];

  return value <= 0 ? null : value;
}

async function currentUsage(
  repository: BillingRepository,
  organizationId: string,
  limit: CountablePlanLimit,
  now: Date | undefined,
): Promise<number> {
  switch (limit) {
    case 'maxMembers':
      return repository.countMembers(organizationId);
    case 'maxProjects':
      return repository.countProjects(organizationId);
    case 'maxKnowledgeItems':
      return repository.countKnowledgeItems(organizationId);
    case 'maxAgentRunsPerMonth':
      return repository.countAgentRunsThisMonth(organizationId, now);
  }
}

/**
 * Lança `PLAN_LIMIT_EXCEEDED` quando a criação passaria do teto do plano.
 *
 * Não devolve nada em caso de sucesso: o chamador só precisa saber que pode
 * seguir. Rodar isto dentro da mesma transação da escrita é o ideal quando a
 * corrida importa; para os volumes do MVP, a checagem imediatamente anterior à
 * gravação já é suficiente e não segura lock em tabela grande.
 */
export async function assertPlanLimit(
  db: Database,
  input: AssertPlanLimitInput,
): Promise<void> {
  const repository = new BillingRepository(db);
  const current = await checkPlanLimit(repository, input);

  if (current !== null) {
    throw planLimitExceeded(current);
  }
}

/**
 * Versão que devolve a violação em vez de lançar. Existe para a troca de plano,
 * que precisa examinar todos os tetos de uma vez antes de decidir.
 */
export async function checkPlanLimit(
  repository: BillingRepository,
  input: AssertPlanLimitInput,
): Promise<PlanLimitViolation | null> {
  const organizationPlan = await repository.findOrganizationPlan(input.organizationId);

  if (organizationPlan === undefined) {
    throw subscriptionNotFound();
  }

  const allowed = allowanceOf(organizationPlan.plan, input.limit, organizationPlan.overrides);

  if (allowed === null) {
    return null;
  }

  const additional = input.additional ?? 1;
  const used = await currentUsage(repository, input.organizationId, input.limit, input.now);

  if (used + additional <= allowed) {
    return null;
  }

  return {
    limit: input.limit,
    planCode: organizationPlan.plan.code,
    allowed,
    current: used,
  };
}

/**
 * Confere se o consumo atual cabe num plano candidato.
 *
 * Usado no rebaixamento: aceitar a troca e só depois descobrir que a
 * organização tem o dobro de projetos do que o plano novo permite deixaria o
 * tenant num estado que nenhuma rota consegue consertar.
 */
export async function violationsAgainstPlan(
  repository: BillingRepository,
  organizationId: string,
  plan: PlanRow,
  overrides: LimitOverrides = EMPTY_OVERRIDES,
  now?: Date,
): Promise<PlanLimitViolation[]> {
  const usage = await repository.usage(organizationId, now);
  const used: Readonly<Record<CountablePlanLimit, number>> = {
    maxMembers: usage.members,
    maxProjects: usage.projects,
    maxKnowledgeItems: usage.knowledgeItems,
    maxAgentRunsPerMonth: usage.agentRunsThisMonth,
  };

  const violations: PlanLimitViolation[] = [];

  for (const limit of COUNTABLE_PLAN_LIMITS) {
    // A exceção da organização sobrevive à troca de plano: quem já tinha
    // autorização para passar do teto não perde a autorização por trocar de
    // plano — só perde quando a exceção for retirada.
    const allowed = allowanceOf(plan, limit, overrides);

    if (allowed !== null && used[limit] > allowed) {
      violations.push({ limit, planCode: plan.code, allowed, current: used[limit] });
    }
  }

  return violations;
}

/** Chaves de limite que aparecem no contrato, incluindo a retenção. */
export const PLAN_LIMIT_FIELDS = [
  'maxMembers',
  'maxProjects',
  'maxKnowledgeItems',
  'maxAgentRunsPerMonth',
  'maxStorageBytes',
  'retentionDays',
] as const;

export type PlanLimitField = (typeof PLAN_LIMIT_FIELDS)[number];

/**
 * Os tetos que valem para a organização, no formato do contrato.
 *
 * `null` significa "sem teto", como no resto do módulo — e é o que a coluna
 * zerada quer dizer.
 */
export function effectiveLimits(
  plan: PlanRow,
  overrides: LimitOverrides = EMPTY_OVERRIDES,
): Record<PlanLimitField, number | null> {
  const resolved = {} as Record<PlanLimitField, number | null>;

  for (const field of PLAN_LIMIT_FIELDS) {
    const value = overrides[field] ?? plan[field];

    resolved[field] = value <= 0 ? null : value;
  }

  return resolved;
}
