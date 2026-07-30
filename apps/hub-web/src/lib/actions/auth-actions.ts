'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '@prometheon/contracts';
import { hubRequestWithCookies } from '@/lib/api/client';
import {
  emptyResultSchema,
  loginResultSchema,
  registerAcceptedSchema,
  verifyEmailResultSchema,
} from '@/lib/api/schemas';
import { buildSession, clearSession, readSession, revokeSession, writeSession } from '@/lib/auth/session';
import { safeRedirect } from '@/lib/auth/safe-redirect';
import { formError, formSuccess, type FormState } from './form-state';

/**
 * Autenticação.
 *
 * Uma Server Action **não substitui autorização de domínio** (`Docs/05`): ela
 * roda no servidor do Hub Web, que não é dono dos dados. O que ela faz é falar
 * com a Hub API e guardar o resultado num cookie `HttpOnly`. Se a API negar, a
 * action não tem como conceder.
 *
 * Todas as chamadas vão com `Origin` do Hub Web — é o que faz a API mandar o
 * refresh em cookie `HttpOnly` em vez do corpo, o caminho que ela desenhou para
 * o navegador.
 */

const emailSchema = z.string().trim().email();
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH);

const loginSchema = z.object({ email: emailSchema, password: passwordSchema });

const registerSchema = z.object({
  name: z.string().trim().min(1),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(1).optional(),
  invitationToken: z.string().trim().min(16).optional(),
});

function text(formData: FormData, field: string): string | undefined {
  const value = formData.get(field);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// --------------------------------------------------------------------- login

export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const issues = z.flattenError(parsed.error).fieldErrors;
    return formError('auth.error.generic', {
      ...(issues.email ? { email: 'auth.error.invalidEmail' as const } : {}),
      ...(issues.password ? { password: 'auth.error.shortPassword' as const } : {}),
    });
  }

  const { result, cookies } = await hubRequestWithCookies('/v1/auth/login', loginResultSchema, {
    method: 'POST',
    body: { ...parsed.data, clientName: 'Prometheon Hub Web' },
    browserOrigin: true,
  });

  if (!result.ok) {
    if (result.kind === 'offline') {
      return formError('auth.error.offline');
    }
    return formError(
      result.code === 'INVALID_CREDENTIALS' || result.kind === 'unauthorized'
        ? 'auth.error.invalidCredentials'
        : 'auth.error.generic',
    );
  }

  await writeSession(buildSession(result.data, cookies));

  // Entrar sem o e-mail confirmado é permitido; escrever não é. A tela de
  // confirmação explica isso antes de o usuário esbarrar num erro.
  if (!result.data.user.emailVerified) {
    redirect(`/verify-email?email=${encodeURIComponent(result.data.user.email)}`);
  }

  const next = formData.get('next');
  redirect(safeRedirect(typeof next === 'string' ? next : null));
}

// ------------------------------------------------------------------- cadastro

export async function registerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = registerSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    organizationName: text(formData, 'organizationName'),
    invitationToken: text(formData, 'invitationToken'),
  });

  if (!parsed.success) {
    const issues = z.flattenError(parsed.error).fieldErrors;
    return formError('auth.error.generic', {
      ...(issues.name ? { name: 'auth.error.requiredName' as const } : {}),
      ...(issues.email ? { email: 'auth.error.invalidEmail' as const } : {}),
      ...(issues.password ? { password: 'auth.error.shortPassword' as const } : {}),
    });
  }

  const { result } = await hubRequestWithCookies('/v1/auth/register', registerAcceptedSchema, {
    method: 'POST',
    body: { ...parsed.data, acceptedTerms: true },
    browserOrigin: true,
  });

  if (!result.ok) {
    if (result.kind === 'offline') {
      return formError('auth.error.offline');
    }
    return formError(
      result.code === 'PASSWORD_TOO_WEAK' ? 'auth.error.weakPassword' : 'auth.error.generic',
    );
  }

  // A API responde 202 e **nunca** devolve a conta criada — é o que impede o
  // cadastro de virar oráculo de e-mails registrados. Não há sessão para abrir
  // aqui: o próximo passo é confirmar o endereço.
  redirect(`/verify-email?email=${encodeURIComponent(result.data.email)}&sent=1`);
}

// -------------------------------------------------------- verificação de e-mail

export async function verifyEmailAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const token = text(formData, 'token');
  if (!token) {
    return formError('auth.verify.invalidToken');
  }

  const { result } = await hubRequestWithCookies('/v1/auth/verify-email', verifyEmailResultSchema, {
    method: 'POST',
    body: { token },
    browserOrigin: true,
  });

  if (!result.ok) {
    return formError(result.kind === 'offline' ? 'auth.error.offline' : 'auth.verify.invalidToken');
  }

  // A sessão em curso carrega `emailVerified: false`; sem atualizar o cookie a
  // interface continuaria pedindo uma confirmação que já aconteceu.
  const session = await readSession();
  if (session) {
    await writeSession({ ...session, user: { ...session.user, emailVerified: true } });
    redirect('/app?verified=1');
  }

  // Quem chegou pelo link do e-mail logo depois do cadastro ainda não tem
  // sessão: o registro responde 202 e não emite token. Mandar para `/app` só
  // faria o middleware devolver ao login sem explicar nada.
  redirect('/login?verified=1');
}

export async function resendVerificationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = emailSchema.safeParse(formData.get('email'));
  if (!email.success) {
    return formError('auth.error.invalidEmail');
  }

  const { result } = await hubRequestWithCookies('/v1/auth/resend-verification', emptyResultSchema, {
    method: 'POST',
    body: { email: email.data },
    browserOrigin: true,
  });

  // 202 sem detalhe: a resposta é a mesma para endereço conhecido e desconhecido.
  return result.ok || result.kind !== 'offline'
    ? formSuccess('auth.verify.resent')
    : formError('auth.error.offline');
}

// ------------------------------------------------------------------- senha

export async function requestPasswordResetAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = emailSchema.safeParse(formData.get('email'));
  if (!email.success) {
    return formError('auth.error.invalidEmail', { email: 'auth.error.invalidEmail' });
  }

  const { result } = await hubRequestWithCookies('/v1/auth/password-reset', emptyResultSchema, {
    method: 'POST',
    body: { email: email.data },
    browserOrigin: true,
  });

  if (!result.ok && result.kind === 'offline') {
    return formError('auth.error.offline');
  }
  // Confirmação neutra de propósito: dizer "não existe conta" entregaria a
  // lista de e-mails cadastrados a quem perguntasse.
  return formSuccess('auth.forgot.sent');
}

export async function resetPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = z
    .object({ token: z.string().min(16), password: passwordSchema })
    .safeParse({ token: formData.get('token'), password: formData.get('password') });

  if (!parsed.success) {
    return formError('auth.error.generic', { password: 'auth.error.shortPassword' });
  }

  const { result } = await hubRequestWithCookies('/v1/auth/password-reset/confirm', emptyResultSchema, {
    method: 'POST',
    body: parsed.data,
    browserOrigin: true,
  });

  if (!result.ok) {
    if (result.kind === 'offline') {
      return formError('auth.error.offline');
    }
    return formError(
      result.code === 'PASSWORD_TOO_WEAK' ? 'auth.error.weakPassword' : 'auth.reset.invalidToken',
    );
  }

  // A API invalida as sessões ao trocar a senha; o cookie local acompanha.
  await clearSession();
  redirect('/login?reset=1');
}

// -------------------------------------------------------------------- logout

export async function logoutAction(): Promise<void> {
  const session = await readSession();
  if (session) {
    // Encerrar a sessão é ação auditada: quem registra é a API.
    await revokeSession(session, false);
  }
  await clearSession();
  redirect('/login');
}

export async function logoutEverywhereAction(): Promise<void> {
  const session = await readSession();
  if (session) {
    await revokeSession(session, true);
  }
  await clearSession();
  redirect('/login');
}
