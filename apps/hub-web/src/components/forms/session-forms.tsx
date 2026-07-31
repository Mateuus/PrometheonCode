'use client';

import { useActionState } from 'react';
import { useTranslate } from '@/i18n/provider';
import { logoutEverywhereAction } from '@/lib/actions/auth-actions';
import { revokeDeviceAction, revokeSessionAction } from '@/lib/actions/account-actions';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { FormFeedback, SubmitButton } from './disclosure-form';

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
 *
 * O resultado é mostrado ao lado do botão. Sem isso, a falha é indistinguível
 * do sucesso: a linha continua na lista nos dois casos, e quem clicou fica sem
 * saber se a sessão sobreviveu ou se o pedido nem chegou a sair.
 */
export function RevokeSessionForm({ sessionId, current }: { sessionId: string; current: boolean }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(revokeSessionAction, idleFormState);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="sessionId" value={sessionId} />
      <SubmitButton
        label={current ? t('sessions.revokeCurrent') : t('sessions.revoke')}
        variant={current ? 'outline' : 'danger'}
      />
      <FormFeedback state={state} />
    </form>
  );
}

/**
 * Desconecta um dispositivo (`DELETE /v1/devices/:id`).
 *
 * Não tem a variante "daqui" da sessão: o dispositivo da lista nunca é esta aba
 * — quem está ali é a extensão do VS Code.
 */
export function RevokeDeviceForm({ deviceId }: { deviceId: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(revokeDeviceAction, idleFormState);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="deviceId" value={deviceId} />
      <SubmitButton label={t('devices.revoke')} variant="danger" />
      <FormFeedback state={state} />
    </form>
  );
}
