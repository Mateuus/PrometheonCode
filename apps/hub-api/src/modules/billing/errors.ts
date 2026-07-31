/** Erros do módulo de planos e assinatura. */

import type { PlanLimitViolation } from '@prometheon/contracts';

import { conflict, notFound, type ApiError } from '../../shared/errors.js';

export function planNotFound(code?: string): ApiError {
  return notFound(
    'PLAN_NOT_FOUND',
    code === undefined
      ? 'This plan does not exist.'
      : `The plan "${code}" does not exist or is no longer available.`,
  );
}

export function subscriptionNotFound(): ApiError {
  return notFound(
    'SUBSCRIPTION_NOT_FOUND',
    'This organization is not linked to any plan.',
  );
}

export function versionConflict(): ApiError {
  return conflict(
    'VERSION_CONFLICT',
    'This record changed since you read it. Reload and try again.',
  );
}

/** Texto legível de cada teto, usado na mensagem do erro. */
const LIMIT_NOUN: Readonly<Record<PlanLimitViolation['limit'], string>> = {
  maxMembers: 'members',
  maxProjects: 'projects',
  maxKnowledgeItems: 'knowledge items',
  maxAgentRunsPerMonth: 'agent runs per month',
  maxStorageBytes: 'bytes of storage',
};

/**
 * 409 com o teto que bateu.
 *
 * A mensagem diz qual limite, quanto o plano permite, quanto já existe e o que
 * fazer — um erro de limite que não responde essas quatro coisas obriga quem
 * usa a abrir um chamado. O par `fields` repete o mesmo em forma de dado, para
 * o cliente decidir sem interpretar texto.
 */
export function planLimitExceeded(violation: PlanLimitViolation): ApiError {
  const noun = LIMIT_NOUN[violation.limit];
  const remedy =
    violation.limit === 'maxAgentRunsPerMonth'
      ? 'Wait for the next billing month or move to a plan with a higher limit.'
      : `Upgrade the plan or remove an existing ${noun.replace(/s$/, '')} to continue.`;

  return conflict(
    'PLAN_LIMIT_EXCEEDED',
    `The "${violation.planCode}" plan allows up to ${String(violation.allowed)} ${noun}; ` +
      `this organization already has ${String(violation.current)}. ${remedy}`,
    {
      fields: [
        {
          path: violation.limit,
          message: `limit reached: ${String(violation.current)} of ${String(violation.allowed)}`,
        },
      ],
      details: { ...violation },
    },
  );
}
