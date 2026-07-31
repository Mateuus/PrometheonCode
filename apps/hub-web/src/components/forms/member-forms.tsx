'use client';

import { useActionState } from 'react';
import { UserPlus } from 'lucide-react';
import { ORGANIZATION_ROLES } from '@prometheon/contracts';
import { useTranslate } from '@/i18n/provider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { roleLabel } from '@/lib/roles';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { inviteMemberAction } from '@/lib/actions/domain-actions';
import { Disclosure, FormFeedback, SubmitButton } from './disclosure-form';

/**
 * Convida alguém para a organização.
 *
 * O convite vira conta pelo cadastro: a Hub API consome o token dentro de
 * `POST /v1/auth/register`. Por isso a confirmação fala em "convite enviado", e
 * não em "membro adicionado" — o membro só existe depois que a pessoa aceita.
 */
export function InviteMemberForm({ organizationSlug }: { organizationSlug: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(inviteMemberAction, idleFormState);

  return (
    <Disclosure label={t('action.invite')} icon={<UserPlus aria-hidden className="size-4" />}>
      <form action={action} className="space-y-3" noValidate>
        <input type="hidden" name="organizationSlug" value={organizationSlug} />
        <FormFeedback state={state} />

        <div className="space-y-1.5">
          <Label htmlFor="invite-email">{t('auth.field.email')}</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            aria-invalid={state.fieldErrors?.email ? true : undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-role">{t('members.role')}</Label>
          <Select id="invite-role" name="role" defaultValue="developer">
            {ORGANIZATION_ROLES.map((role) => (
              <option key={role} value={role}>
                {roleLabel(role, t)}
              </option>
            ))}
          </Select>
        </div>

        <SubmitButton label={t('action.invite')} />
      </form>
    </Disclosure>
  );
}
