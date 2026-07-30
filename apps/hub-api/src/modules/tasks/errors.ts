/** Erros do módulo de tarefas. */

import { badRequest, conflict, notFound, type ApiError } from '../../shared/errors.js';

export function taskNotFound(): ApiError {
  return notFound('TASK_NOT_FOUND', 'This task does not exist.');
}

/**
 * Outra pessoa (ou outro agente) segura a reivindicação, e ela ainda vale.
 *
 * A decisão é do banco: o `UPDATE` condicional não afetou linha nenhuma. Este
 * erro é a tradução disso, e nunca uma checagem feita antes da escrita — entre
 * a checagem e a escrita cabe a reivindicação de outra pessoa.
 */
export function taskAlreadyClaimed(): ApiError {
  return conflict(
    'TASK_ALREADY_CLAIMED',
    'Someone else holds an active claim on this task.',
  );
}

/** Soltar tarefa que não é sua. */
export function taskNotClaimedByActor(): ApiError {
  return conflict(
    'TASK_NOT_CLAIMED_BY_ACTOR',
    'You cannot release a task you do not hold.',
  );
}

/** Tarefa encerrada não volta a ser trabalho reivindicável. */
export function taskNotClaimable(status: string): ApiError {
  return conflict('CONFLICT', `A task in status "${status}" cannot be claimed.`);
}

export function taskVersionConflict(): ApiError {
  return conflict(
    'VERSION_CONFLICT',
    'This task changed since you read it. Reload and try again.',
  );
}

/** Dependência apontando para fora do projeto ou para a própria tarefa. */
export function invalidDependency(taskId: string): ApiError {
  return badRequest('VALIDATION_FAILED', 'A dependency must be another task of the same project.', {
    fields: [{ path: 'dependsOn', message: `${taskId} is not a task of this project` }],
  });
}

export function dependencyCycle(): ApiError {
  return conflict(
    'TASK_DEPENDENCY_CYCLE',
    'These dependencies would make the task depend on itself.',
  );
}
