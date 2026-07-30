'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { env } from '@/lib/env';
import { hubRequest } from '@/lib/api/client';
import { clearSession, writeSession, type Session } from '@/lib/auth/session';
import { safeRedirect } from '@/lib/auth/safe-redirect';
import { formError, type FormState } from './form-state';

/**
 * Autenticação.
 *
 * Uma Server Action **não substitui autorização de domínio** (`Docs/05`): ela
 * roda no servidor do Hub Web, que não é dono dos dados. O que ela faz é falar
 * com a Hub API e guardar o resultado num cookie `HttpOnly`. Se a API negar, a
 * action não tem como conceder.
 */

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
});

const registerSchema = loginSchema.extend({
  name: z.string().trim().min(1),
});

const authResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
});

/**
 * PROVISÓRIO — sessão de exemplo.
 * Sem a Hub API no ar não há token para pedir. Estes valores não abrem nada:
 * qualquer chamada real continua sendo julgada pela API.
 */
function sampleSession(email: string, name: string): Session {
  return {
    accessToken: 'sample-access-token',
    refreshToken: 'sample-refresh-token',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    user: { id: '01JB7Q4X2N0000000000000001', name, email },
  };
}

export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    return formError('auth.error.generic', {
      ...(issues.email ? { email: 'auth.error.invalidEmail' as const } : {}),
      ...(issues.password ? { password: 'auth.error.shortPassword' as const } : {}),
    });
  }

  if (env().HUB_WEB_SAMPLE_DATA) {
    await writeSession(sampleSession(parsed.data.email, 'Mateus Rodrigues'));
  } else {
    const result = await hubRequest('/v1/auth/login', authResponseSchema, {
      method: 'POST',
      body: parsed.data,
    });

    if (!result.ok) {
      return formError(
        result.kind === 'unauthorized' ? 'auth.error.invalidCredentials' : 'auth.error.generic',
      );
    }
    await writeSession(result.data);
  }

  const next = formData.get('next');
  redirect(safeRedirect(typeof next === 'string' ? next : null));
}

export async function registerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = registerSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    return formError('auth.error.generic', {
      ...(issues.name ? { name: 'auth.error.requiredName' as const } : {}),
      ...(issues.email ? { email: 'auth.error.invalidEmail' as const } : {}),
      ...(issues.password ? { password: 'auth.error.shortPassword' as const } : {}),
    });
  }

  if (env().HUB_WEB_SAMPLE_DATA) {
    await writeSession(sampleSession(parsed.data.email, parsed.data.name));
  } else {
    const result = await hubRequest('/v1/auth/register', authResponseSchema, {
      method: 'POST',
      body: parsed.data,
    });

    if (!result.ok) {
      return formError(
        result.code === 'EMAIL_ALREADY_REGISTERED'
          ? 'auth.error.emailTaken'
          : 'auth.error.generic',
      );
    }
    await writeSession(result.data);
  }

  redirect('/app');
}

export async function logoutAction(): Promise<void> {
  if (!env().HUB_WEB_SAMPLE_DATA) {
    // Encerrar a sessão é ação auditada: quem registra é a API.
    await hubRequest('/v1/auth/logout', z.unknown(), { method: 'POST' });
  }
  await clearSession();
  redirect('/login');
}
