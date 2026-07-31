/**
 * Erros da gestão da própria conta.
 *
 * O ponto que merece atenção aqui é o **status** de "senha atual errada". O
 * caminho natural seria 401, mas 401 numa rota autenticada é lido pelo cliente
 * como "sua sessão morreu" — o Hub Web, por exemplo, classifica todo 401 como
 * `unauthorized` e manda a pessoa para o login. Errar a senha atual num
 * formulário não pode deslogar ninguém, então a resposta é 400 com o campo
 * apontado. O código continua sendo `INVALID_CREDENTIALS`: quem decide
 * comportamento pelo código não perde informação.
 */

import { badRequest, notFound, type ApiError } from '../../shared/errors.js';

export function currentPasswordInvalid(): ApiError {
  return badRequest('INVALID_CREDENTIALS', 'The current password is not correct.', {
    fields: [{ path: 'currentPassword', message: 'is not correct' }],
  });
}

/** Nova senha igual à atual: a troca não teria efeito nenhum. */
export function passwordUnchanged(): ApiError {
  return badRequest(
    'PASSWORD_TOO_WEAK',
    'The new password must be different from the current one.',
    { fields: [{ path: 'newPassword', message: 'must be different from the current one' }] },
  );
}

/**
 * Sessão inexistente **ou de outra pessoa**.
 *
 * Os dois casos respondem igual de propósito: distinguir "não existe" de "não é
 * sua" transformaria a rota num oráculo para descobrir identificadores de
 * sessão válidos de terceiros.
 */
export function sessionNotFound(): ApiError {
  return notFound('NOT_FOUND', 'This session does not exist.');
}

/** Dispositivo inexistente **ou de outra pessoa** — mesmo motivo da sessão. */
export function deviceNotFound(): ApiError {
  return notFound('NOT_FOUND', 'This device does not exist.');
}

/** Fuso horário com forma válida que a base de fusos do runtime não conhece. */
export function timeZoneUnknown(value: string): ApiError {
  return badRequest('VALIDATION_FAILED', `Unknown time zone: ${value}.`, {
    fields: [{ path: 'timeZone', message: 'is not a known IANA time zone' }],
  });
}

/** `PATCH` sem nenhum campo: o cliente pediu para mudar nada. */
export function emptyProfileUpdate(): ApiError {
  return badRequest('VALIDATION_FAILED', 'Provide at least one field to update.');
}
