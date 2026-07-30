'use client';

import { useActionState } from 'react';
import { useTranslate } from '@/i18n/provider';
import { LOCALE_LABELS, SUPPORTED_LOCALES, LOCALE_BCP47 } from '@/i18n/config';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import { changePasswordAction, updateProfileAction } from '@/lib/actions/account-actions';
import { FormFeedback, SubmitButton } from './disclosure-form';

/** Mensagem de erro de um campo, quando a action apontou um. */
function FieldError({ state, field }: { state: FormState; field: string }) {
  const t = useTranslate();
  const key = state.fieldErrors?.[field];
  return key ? (
    <p className="text-xs text-danger" role="alert">
      {t(key)}
    </p>
  ) : null;
}

/**
 * Edita nome, idioma e fuso do perfil.
 *
 * O e-mail aparece na tela, fora deste formulário, e não é editável: trocá-lo
 * exige verificar o novo endereço antes de o antigo perder valor, que é um
 * fluxo próprio e não um campo a mais aqui.
 */
export function UpdateProfileForm({
  name,
  locale,
  timeZone,
}: {
  name: string;
  locale: string;
  timeZone: string;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(updateProfileAction, idleFormState);

  return (
    <form action={action}>
      <Card>
        <CardHeader>
          <CardTitle>{t('account.profile')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />

          <div className="space-y-1.5">
            <Label htmlFor="profile-name">{t('auth.field.name')}</Label>
            <Input
              id="profile-name"
              name="name"
              defaultValue={name}
              required
              autoComplete="name"
              aria-invalid={state.fieldErrors?.name ? true : undefined}
            />
            <FieldError state={state} field="name" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-locale">{t('account.field.locale')}</Label>
            <Select id="profile-locale" name="locale" defaultValue={locale}>
              {/* O idioma gravado na conta pode ser um que o Hub Web ainda não
                  traduz — a extensão e os e-mails também o consultam. Nesse caso
                  ele entra como primeira opção para não ser trocado em silêncio
                  ao salvar qualquer outro campo. */}
              {SUPPORTED_LOCALES.some((supported) => LOCALE_BCP47[supported] === locale) ? null : (
                <option value={locale}>{locale}</option>
              )}
              {SUPPORTED_LOCALES.map((supported) => (
                <option key={supported} value={LOCALE_BCP47[supported]}>
                  {LOCALE_LABELS[supported]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-timezone">{t('account.field.timeZone')}</Label>
            <Input
              id="profile-timezone"
              name="timeZone"
              defaultValue={timeZone}
              placeholder="America/Sao_Paulo"
              aria-invalid={state.fieldErrors?.timeZone ? true : undefined}
            />
            <p className="text-xs text-muted">{t('account.field.timeZoneHint')}</p>
            <FieldError state={state} field="timeZone" />
          </div>
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('action.save')} />
        </CardFooter>
      </Card>
    </form>
  );
}

/**
 * Troca a senha estando logado.
 *
 * A senha atual é pedida porque a API a exige — e a API a exige porque uma
 * sessão roubada não pode virar uma conta roubada. Quem não lembra a senha atual
 * tem o link do fluxo de recuperação logo abaixo.
 */
export function ChangePasswordForm() {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(changePasswordAction, idleFormState);

  return (
    <form action={action}>
      <Card>
        <CardHeader>
          <CardTitle>{t('account.security')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormFeedback state={state} />
          <p className="text-sm text-muted">{t('account.changePasswordHint')}</p>

          <div className="space-y-1.5">
            <Label htmlFor="current-password">{t('account.currentPassword')}</Label>
            <Input
              id="current-password"
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              aria-invalid={state.fieldErrors?.currentPassword ? true : undefined}
            />
            <FieldError state={state} field="currentPassword" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-password">{t('account.newPassword')}</Label>
            <Input
              id="new-password"
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              aria-invalid={state.fieldErrors?.newPassword ? true : undefined}
            />
            <p className="text-xs text-muted">{t('auth.field.passwordHint')}</p>
            <FieldError state={state} field="newPassword" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">{t('account.confirmPassword')}</Label>
            <Input
              id="confirm-password"
              name="confirmPassword"
              type="password"
              required
              autoComplete="new-password"
              aria-invalid={state.fieldErrors?.confirmPassword ? true : undefined}
            />
            <FieldError state={state} field="confirmPassword" />
          </div>
        </CardContent>
        <CardFooter>
          <SubmitButton label={t('account.changePassword')} />
        </CardFooter>
      </Card>
    </form>
  );
}
