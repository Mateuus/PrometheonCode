'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '@prometheon/contracts';
import { changePassword, revokeAccountDevice,
  revokeAccountSession, updateProfile } from '@/lib/api/commands';
import type { ApiFailure } from '@/lib/api/result';
import { clearSession, readSession, writeSession } from '@/lib/auth/session';
import { formError, formSuccess, type FormState } from './form-state';

/**
 * Gestão da própria conta: perfil, senha e sessões.
 *
 * Vale o mesmo que para o resto das actions: quem decide é a Hub API. Aqui a
 * entrada é validada só para o formulário conseguir apontar o campo errado sem
 * uma ida à rede — a validação que importa é a do contrato, do outro lado.
 */

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH);

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function translateFailure(failure: ApiFailure): FormState {
  if (failure.kind === 'offline') {
    return formError('auth.error.offline');
  }
  if (failure.kind === 'unauthorized') {
    return formError('state.unauthorized.title');
  }
  return formError('auth.error.generic');
}

// -------------------------------------------------------------------- perfil

export async function updateProfileAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const name = field(formData, 'name');

  if (name === '') {
    return formError('auth.error.requiredName', { name: 'auth.error.requiredName' });
  }

  const timeZone = field(formData, 'timeZone');
  const locale = field(formData, 'locale');

  const result = await updateProfile({
    name,
    ...(locale === '' ? {} : { locale }),
    ...(timeZone === '' ? {} : { timeZone }),
  });

  if (!result.ok) {
    if (result.code === 'VALIDATION_FAILED') {
      return formError('account.error.invalidTimeZone', {
        timeZone: 'account.error.invalidTimeZone',
      });
    }
    return translateFailure(result);
  }

  // O nome aparece no menu do usuário, que é montado a partir do cookie da
  // sessão. Sem atualizá-lo, a pessoa salvaria o novo nome e continuaria vendo o
  // antigo no canto da tela até o próximo login.
  const session = await readSession();
  if (session) {
    await writeSession({ ...session, user: { ...session.user, name: result.data.user.name } });
  }

  revalidatePath('/settings/account');
  return formSuccess('account.profileSaved');
}

// --------------------------------------------------------------------- senha

export async function changePasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const currentPassword = formData.get('currentPassword');
  const parsed = z
    .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
    .safeParse({ currentPassword, newPassword: formData.get('newPassword') });

  if (!parsed.success) {
    const issues = z.flattenError(parsed.error).fieldErrors;
    return formError('auth.error.generic', {
      ...(issues.currentPassword
        ? { currentPassword: 'account.error.currentPasswordRequired' as const }
        : {}),
      ...(issues.newPassword ? { newPassword: 'auth.error.shortPassword' as const } : {}),
    });
  }

  const confirmation = formData.get('confirmPassword');
  if (typeof confirmation === 'string' && confirmation !== parsed.data.newPassword) {
    return formError('account.error.passwordMismatch', {
      confirmPassword: 'account.error.passwordMismatch',
    });
  }

  const result = await changePassword(parsed.data);

  if (!result.ok) {
    if (result.code === 'INVALID_CREDENTIALS') {
      return formError('account.error.wrongCurrentPassword', {
        currentPassword: 'account.error.wrongCurrentPassword',
      });
    }
    if (result.code === 'PASSWORD_TOO_WEAK') {
      return formError('account.error.samePassword', { newPassword: 'account.error.samePassword' });
    }
    if (result.code === 'RATE_LIMITED') {
      return formError('account.error.tooManyAttempts');
    }
    return translateFailure(result);
  }

  // A API preserva a sessão que trocou a senha, então não há cookie a mexer
  // aqui. O que muda são as listas de sessões e dispositivos, que acabaram de
  // encolher.
  revalidatePath('/settings/sessions');

  // O aviso sobre dispositivos vem antes do de sessões porque é o que exige
  // ação: entrar de novo no VS Code. Descobrir isso só na próxima vez que abrir
  // o editor é a pior hora possível.
  if (result.data.revokedDevices > 0) {
    return formSuccess('account.passwordChangedAndDevicesRevoked');
  }

  return formSuccess(
    result.data.revokedSessions > 0 ? 'account.passwordChangedAndRevoked' : 'account.passwordChanged',
  );
}

// ------------------------------------------------------------------- sessões

/**
 * Derruba uma sessão da conta.
 *
 * Devolve `FormState` porque a falha aqui é invisível de outro jeito: a linha
 * continua na lista, e quem clicou não tem como saber se a sessão sobreviveu ou
 * se o pedido nem saiu. Foi exatamente o que aconteceu enquanto o refresh
 * estava quebrado — o token vencia, `accessToken()` devolvia nada, e o clique
 * morria no servidor do Hub Web sem nunca virar uma chamada à API.
 */
export async function revokeSessionAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const sessionId = field(formData, 'sessionId');
  if (sessionId === '') {
    return formError('auth.error.generic');
  }

  const result = await revokeAccountSession(sessionId);

  if (!result.ok) {
    return translateFailure(result);
  }

  // A pessoa derrubou a própria sessão: o cookie do Hub Web guarda um refresh
  // que a API acabou de invalidar. Mantê-lo só produziria um erro na próxima
  // navegação, em vez de a tela de login que ela está esperando.
  if (result.data.current) {
    await clearSession();
    redirect('/login');
  }

  revalidatePath('/settings/sessions');

  return formSuccess('sessions.revoked');
}

// -------------------------------------------------------------- dispositivos

export async function revokeDeviceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const deviceId = field(formData, 'deviceId');
  if (deviceId === '') {
    return formError('auth.error.generic');
  }

  const result = await revokeAccountDevice(deviceId);

  if (!result.ok) {
    return translateFailure(result);
  }

  // Nada de `clearSession()` aqui: o dispositivo da lista nunca é esta aba.
  revalidatePath('/settings/sessions');

  return formSuccess('devices.revoked');
}
