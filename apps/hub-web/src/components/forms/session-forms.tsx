'use client';

import { useTranslate } from '@/i18n/provider';
import { logoutEverywhereAction } from '@/lib/actions/auth-actions';
import { revokeSessionAction } from '@/lib/actions/account-actions';
import { SubmitButton } from './disclosure-form';

/**
 * Encerra todas as sessões da conta.
 *
 * Chama `POST /v1/auth/logout` com `allSessions: true`, que derruba inclusive
 * esta — por isso a action limpa o cookie e manda para o login.
 */
export function SignOutEverywhereForm() {
  const t = useTranslate();
  return (
    <form action={logoutEverywhereAction}>
      <SubmitButton label={t('action.revokeAll')} variant="danger" />
    </form>
  );
}

/**
 * Derruba uma sessão específica (`DELETE /v1/sessions/:id`).
 *
 * O rótulo muda quando a linha é a sessão atual: "sair" e "sair daqui" são
 * ações diferentes, e apertar uma achando que era a outra é o erro que esta
 * tela mais convida a cometer.
 */
export function RevokeSessionForm({ sessionId, current }: { sessionId: string; current: boolean }) {
  const t = useTranslate();
  return (
    <form action={revokeSessionAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <SubmitButton
        label={current ? t('sessions.revokeCurrent') : t('sessions.revoke')}
        variant={current ? 'outline' : 'danger'}
      />
    </form>
  );
}
