/** Erros do módulo de projetos. */

import { conflict, forbidden, notFound, type ApiError } from '../../shared/errors.js';

/**
 * Projeto inexistente e projeto de outra organização devolvem a mesma coisa.
 * Distinguir os dois casos entregaria a existência do projeto a quem não pode
 * vê-lo — que é o mesmo raciocínio que o módulo de organizações aplica.
 */
export function projectNotFound(): ApiError {
  return notFound('PROJECT_NOT_FOUND', 'This project does not exist.');
}

export function projectSlugTaken(): ApiError {
  return conflict(
    'PROJECT_SLUG_TAKEN',
    'Another project in this organization already uses this slug.',
  );
}

/** Membro da organização que não participa do projeto. */
export function projectAccessDenied(): ApiError {
  return forbidden('You do not have access to this project.', 'PROJECT_ACCESS_DENIED');
}

export function projectVersionConflict(): ApiError {
  return conflict(
    'VERSION_CONFLICT',
    'This project changed since you read it. Reload and try again.',
  );
}
