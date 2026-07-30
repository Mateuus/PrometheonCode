'use client';

import { useTranslate } from '@/i18n/provider';
import { logoutEverywhereAction } from '@/lib/actions/auth-actions';
import { SubmitButton } from './disclosure-form';

/**
 * Encerra todas as sessões da conta.
 *
 * Chama `POST /v1/auth/logout` com `allSessions: true`, que é o que a API
 * oferece hoje — revogar uma sessão específica ainda não tem rota.
 */
export function SignOutEverywhereForm() {
  const t = useTranslate();
  return (
    <form action={logoutEverywhereAction}>
      <SubmitButton label={t('action.revokeAll')} variant="danger" />
    </form>
  );
}
