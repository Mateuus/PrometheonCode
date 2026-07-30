/**
 * Erros do módulo de autenticação.
 *
 * O ponto delicado deste arquivo é o que ele **não** distingue. Registro, login
 * e recuperação de senha respondem exatamente a mesma coisa exista ou não a
 * conta — é o requisito de não-enumeração do `Docs/09`. As mensagens abaixo são
 * escritas para serem indistinguíveis entre esses casos.
 */

import { badRequest, conflict, forbidden, unauthenticated, type ApiError } from '../../shared/errors.js';

/**
 * Falha de login.
 *
 * Uma mensagem só, para senha errada, e-mail inexistente e conta sem senha
 * definida. Dizer "essa conta não existe" seria entregar a lista de clientes a
 * quem tentar um dicionário de endereços.
 */
export function invalidCredentials(): ApiError {
  return unauthenticated('Invalid email address or password.', 'INVALID_CREDENTIALS');
}

export function emailNotVerified(): ApiError {
  return forbidden(
    'Confirm your email address before continuing.',
    'EMAIL_NOT_VERIFIED',
  );
}

export function accountDisabled(): ApiError {
  // Mesmo código e status de credencial inválida: uma conta suspensa não
  // precisa se anunciar para quem está tentando entrar nela.
  return unauthenticated('Invalid email address or password.', 'INVALID_CREDENTIALS');
}

export function verificationTokenInvalid(): ApiError {
  return badRequest(
    'VERIFICATION_TOKEN_INVALID',
    'This verification link is invalid or has already been used.',
  );
}

export function resetTokenInvalid(): ApiError {
  return badRequest(
    'RESET_TOKEN_INVALID',
    'This password reset link is invalid or has already been used.',
  );
}

export function refreshTokenInvalid(): ApiError {
  return unauthenticated('The refresh token is invalid or has expired.', 'TOKEN_INVALID');
}

export function sessionRevoked(): ApiError {
  return unauthenticated('This session has been revoked. Sign in again.', 'SESSION_REVOKED');
}

export function invitationInvalid(): ApiError {
  return badRequest('INVITATION_NOT_FOUND', 'This invitation is invalid or has expired.');
}

export function invitationExpired(): ApiError {
  return badRequest('INVITATION_EXPIRED', 'This invitation has expired.');
}

export function emailAlreadyRegistered(): ApiError {
  // Reservado para fluxos autenticados (convidar alguém que já é membro), onde
  // quem chama já tem direito de saber quem está na organização. O registro
  // público nunca devolve este código.
  return conflict('EMAIL_ALREADY_REGISTERED', 'This email address is already registered.');
}

export function deviceCodeInvalid(): ApiError {
  return badRequest('DEVICE_CODE_INVALID', 'This device code is invalid.');
}

export function deviceCodeExpired(): ApiError {
  return badRequest('DEVICE_CODE_EXPIRED', 'This device code has expired. Start over.');
}

export function deviceAuthorizationPending(): ApiError {
  // 428: a requisição está correta, falta uma precondição — a autorização do
  // usuário. O cliente deve continuar o polling.
  return badRequest(
    'DEVICE_AUTHORIZATION_PENDING',
    'The device authorization is still pending.',
  );
}

export function deviceAuthorizationDenied(): ApiError {
  return forbidden('The device authorization was denied.', 'DEVICE_AUTHORIZATION_DENIED');
}

export function deviceRevoked(): ApiError {
  return unauthenticated('This device credential has been revoked.', 'DEVICE_REVOKED');
}

export function passwordTooWeak(reason: string): ApiError {
  return badRequest('PASSWORD_TOO_WEAK', reason, {
    fields: [{ path: 'password', message: reason }],
  });
}
