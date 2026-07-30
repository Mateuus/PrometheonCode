/** Erros do módulo de organizações. */

import { badRequest, conflict, notFound, type ApiError } from '../../shared/errors.js';

export function organizationNotFound(): ApiError {
  return notFound('ORGANIZATION_NOT_FOUND', 'This organization does not exist.');
}

export function memberNotFound(): ApiError {
  return notFound('MEMBER_NOT_FOUND', 'This member does not exist.');
}

export function memberAlreadyExists(): ApiError {
  return conflict('MEMBER_ALREADY_EXISTS', 'This person is already a member.');
}

export function invitationAlreadyPending(): ApiError {
  return conflict(
    'INVITATION_ALREADY_USED',
    'There is already a pending invitation for this address.',
  );
}

/**
 * Uma organização sem dono ativo fica sem ninguém capaz de administrá-la — e
 * nenhuma rota consegue devolver esse poder depois.
 */
export function lastOwnerCannotBeRemoved(): ApiError {
  return conflict(
    'LAST_OWNER_CANNOT_BE_REMOVED',
    'The organization must keep at least one active owner.',
  );
}

export function versionConflict(): ApiError {
  return conflict(
    'VERSION_CONFLICT',
    'This record changed since you read it. Reload and try again.',
  );
}

export function cannotOutrankSelf(): ApiError {
  return badRequest(
    'PERMISSION_DENIED',
    'You can only change members whose role is below yours.',
  );
}
