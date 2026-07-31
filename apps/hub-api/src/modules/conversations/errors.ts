/** Erros do módulo de conversas. */

import { conflict, notFound, type ApiError } from '../../shared/errors.js';

export function conversationNotFound(): ApiError {
  return notFound('CONVERSATION_NOT_FOUND', 'This conversation does not exist.');
}

/**
 * Conversa arquivada ou trancada não aceita mensagem nova.
 *
 * O mesmo código serve aos dois estados: para quem escreve, a diferença entre
 * "saiu da lista" e "foi encerrada por política" não muda o que fazer a seguir.
 */
export function conversationClosed(status: 'archived' | 'locked'): ApiError {
  return conflict(
    'CONVERSATION_ARCHIVED',
    status === 'locked'
      ? 'This conversation is locked and no longer accepts messages.'
      : 'This conversation is archived. Reopen it before sending messages.',
  );
}

export function conversationVersionConflict(): ApiError {
  return conflict(
    'VERSION_CONFLICT',
    'This conversation changed since you read it. Reload and try again.',
  );
}
