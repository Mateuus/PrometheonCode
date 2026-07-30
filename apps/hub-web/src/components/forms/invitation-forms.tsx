'use client';

import { useActionState } from 'react';
import { useTranslate } from '@/i18n/provider';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { acceptInvitationAction } from '@/lib/actions/domain-actions';
import { FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Aceita um convite com a conta que já está autenticada.
 *
 * O token vai num campo escondido porque ele chega pela URL do e-mail e o
 * usuário não o digita. Quem confere se ele vale — e se é para esta conta — é a
 * Hub API; aqui só se mostra a recusa que ela devolveu.
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    acceptInvitationAction,
    idleFormState,
  );

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <FormFeedback state={state} />
      <SubmitButton label={t('action.acceptInvite')} size="md" />
    </form>
  );
}
