'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslate } from '@/i18n/provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { decideDeviceAction } from '@/lib/actions/device-actions';
import { idleFormState, type FormState } from '@/lib/actions/form-state';

/**
 * Aprova ou nega um dispositivo (`POST /v1/auth/device/decision`).
 *
 * Um formulário só, com dois botões de envio: `name="decision"` faz o navegador
 * mandar o valor do botão apertado, então a action recebe `approve` ou `deny`
 * sem precisar de dois forms duplicando o seletor de organização.
 *
 * Depois de decidido, o formulário sai da tela em vez de só mostrar um aviso:
 * o código já não vale — a API guarda a primeira decisão e ignora as próximas —
 * e manter botões clicáveis convidaria a uma segunda decisão que viraria erro.
 */

/** Botão de envio que carrega a decisão. `useFormStatus` trava os dois juntos. */
function DecisionButton({
  decision,
  label,
  variant,
}: {
  decision: 'approve' | 'deny';
  label: string;
  variant?: 'outline';
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      name="decision"
      value={decision}
      {...(variant ? { variant } : {})}
      disabled={pending}
      aria-disabled={pending}
    >
      {label}
    </Button>
  );
}

export function DeviceDecisionForm({
  userCode,
  organizations,
  defaultOrganizationId,
}: {
  userCode: string;
  organizations: { id: string; name: string }[];
  defaultOrganizationId: string | null;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(decideDeviceAction, idleFormState);

  // Estado final: a extensão está em polling e conclui sozinha — a pessoa só
  // precisa saber que pode voltar ao editor (ou que negou e acabou por aqui).
  if (state.status === 'success') {
    const approved = state.messageKey === 'device.approved.title';
    return (
      <Alert
        tone={approved ? 'success' : 'info'}
        title={t(approved ? 'device.approved.title' : 'device.denied.title')}
      >
        {t(approved ? 'device.approved.description' : 'device.denied.description')}
      </Alert>
    );
  }

  const single = organizations.length === 1 ? organizations[0] : undefined;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="userCode" value={userCode} />

      {state.status === 'error' && state.messageKey ? (
        <Alert tone="danger" title={t(state.messageKey)} />
      ) : null}

      {single ? (
        <>
          {/* Uma organização só não é escolha: o campo vai escondido e o texto
              diz aonde o dispositivo vai entrar, para a aprovação não ser cega. */}
          <input type="hidden" name="organizationId" value={single.id} />
          <p className="text-sm text-muted">
            {t('device.singleOrganization', { organization: single.name })}
          </p>
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="device-organization">{t('device.field.organization')}</Label>
          <Select
            id="device-organization"
            name="organizationId"
            defaultValue={defaultOrganizationId ?? organizations[0]?.id}
            required
            aria-invalid={state.fieldErrors?.organizationId ? true : undefined}
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted">{t('device.organizationHint')}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <DecisionButton decision="approve" label={t('device.approve')} />
        <DecisionButton decision="deny" label={t('device.deny')} variant="outline" />
      </div>
    </form>
  );
}
