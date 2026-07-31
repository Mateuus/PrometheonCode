/** Erros do módulo de dispositivos, com os códigos estáveis do `Docs/06`. */

import { forbidden, notFound } from '../../shared/errors.js';
import type { ApiError } from '../../shared/errors.js';

/**
 * Dispositivo de outra pessoa responde igual a dispositivo inexistente.
 *
 * Distinguir os dois transformaria a rota num oráculo: quem tem um identificador
 * saberia se ele existe, e um ULID de dispositivo não é segredo.
 */
export function deviceNotFound(): ApiError {
  return notFound('DEVICE_NOT_FOUND', 'This device does not exist.');
}

export function deviceRevoked(): ApiError {
  return forbidden('This device has been revoked.', 'DEVICE_REVOKED');
}

export function projectAccessDenied(): ApiError {
  return forbidden('You do not have access to this project.', 'PROJECT_ACCESS_DENIED');
}

export function projectNotFound(): ApiError {
  return notFound('PROJECT_NOT_FOUND', 'This project does not exist.');
}
