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

/**
 * Convite já consumido.
 *
 * 409 e não 400: o pedido está bem formado e o token é real; o que mudou foi o
 * estado do recurso. É também a resposta de quem perdeu uma corrida entre duas
 * aceitações simultâneas — um conflito, não uma falha do servidor.
 */
export function invitationAlreadyAccepted(): ApiError {
  return conflict('INVITATION_ALREADY_USED', 'This invitation has already been accepted.');
}

/** Convite cancelado por quem administra a organização. */
export function invitationRevoked(): ApiError {
  return conflict('INVITATION_REVOKED', 'This invitation was cancelled.');
}

/**
 * O convite é de outro endereço.
 *
 * DECISÃO DE SEGURANÇA — por que isto é recusado em vez de aceito:
 *
 * O convite não é um cupom ao portador. Ele autoriza **uma pessoa** —
 * identificada pelo endereço para onde o link foi enviado — a entrar num tenant
 * com um papel definido por quem convidou. Deixar qualquer conta autenticada
 * consumir o token transformaria posse do link em pertencimento à organização, e
 * um link vaza por muitos caminhos que não são invasão de caixa postal: histórico
 * de navegador, encaminhamento de e-mail, captura de tela em suporte, log de
 * proxy. Quem convidou `financeiro@empresa.com` como `admin` não consentiu com
 * uma conta pessoal qualquer virando `admin`.
 *
 * A mensagem não diz para qual endereço o convite foi: quem legitimamente
 * recebeu já sabe, e quem só tem o token não fica sabendo.
 */
export function invitationEmailMismatch(): ApiError {
  return forbidden(
    'This invitation was sent to a different email address. ' +
      'Sign in with the invited account, or ask for an invitation to the address you use.',
    'INVITATION_EMAIL_MISMATCH',
  );
}

/**
 * A conta não participa da organização pedida.
 *
 * Mesma resposta para "esta organização não existe" e "existe, mas você não está
 * nela". Diferenciar as duas transformaria a rota num verificador de
 * identificadores: quem tivesse uma lista de ULIDs descobriria quais são tenants
 * reais sem pertencer a nenhum.
 */
export function organizationAccessDenied(): ApiError {
  return forbidden(
    'You do not have an active membership in this organization.',
    'ORGANIZATION_ACCESS_DENIED',
  );
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

// ---------------------------------------------------------------------------
// Login por provedor externo
// ---------------------------------------------------------------------------

export function providerNotConfigured(): ApiError {
  return badRequest('PROVIDER_NOT_CONFIGURED', 'This Hub does not offer that sign-in provider.');
}

/** `state` ausente, expirado, já usado ou desconhecido. */
export function oauthStateInvalid(): ApiError {
  return badRequest('PROVIDER_REJECTED', 'This sign-in attempt is no longer valid. Start again.');
}

/**
 * O provedor confirmou a identidade, mas sem e-mail verificado.
 *
 * A conta não é criada porque uma conta sem endereço não tem recuperação, não
 * recebe convite e não recebe aviso de segurança — ficaria irrecuperável no dia
 * em que a pessoa perdesse o acesso ao provedor.
 */
export function providerEmailRequired(): ApiError {
  return badRequest(
    'PROVIDER_REJECTED',
    'Your provider account has no verified email address. Verify one there and try again.',
  );
}

/**
 * O e-mail já pertence a uma conta daqui, e não há prova bastante para vincular.
 *
 * Vincular por e-mail coincidente entregaria a conta a quem cadastrasse o
 * endereço de outra pessoa e nunca o confirmasse: bastaria registrar
 * `voce@exemplo.com` com uma senha qualquer e esperar você entrar pelo provedor.
 * Por isso a vinculação automática exige as duas pontas verificadas.
 *
 * A saída não é um beco: entrar com a senha e ligar o provedor de dentro da
 * conta, onde a posse já está provada.
 */
export function identityLinkRequired(): ApiError {
  return conflict(
    'IDENTITY_LINK_REQUIRED',
    'An account already uses that email address. Sign in with your password to connect this provider.',
  );
}
