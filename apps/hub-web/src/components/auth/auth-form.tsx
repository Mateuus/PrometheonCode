'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslate } from '@/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { idleFormState, type FormState } from '@/lib/actions/form-state';
import {
  loginAction,
  registerAction,
  requestPasswordResetAction,
  resendVerificationAction,
  resetPasswordAction,
  verifyEmailAction,
} from '@/lib/actions/auth-actions';

/**
 * Formulários de autenticação.
 *
 * A action roda no servidor e devolve **chaves** de tradução; quem escreve a
 * frase é este componente, no idioma da requisição. O erro de campo vai para
 * `aria-describedby` e o input recebe `aria-invalid`, então o problema é
 * anunciado e não fica só na cor da borda.
 */

function SubmitButton({ label, className }: { label: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      className={className ?? 'w-full'}
      disabled={pending}
      aria-disabled={pending}
    >
      {label}
    </Button>
  );
}

function FormMessage({ state }: { state: FormState }) {
  const t = useTranslate();
  if (state.status === 'idle' || !state.messageKey) {
    return null;
  }
  return (
    <Alert tone={state.status === 'error' ? 'danger' : 'success'} title={t(state.messageKey)} />
  );
}

function Field({
  id,
  name,
  label,
  type,
  autoComplete,
  hint,
  errorKey,
  defaultValue,
  required = true,
}: {
  id: string;
  name: string;
  label: string;
  type: string;
  autoComplete: string;
  hint?: string;
  errorKey?: string | undefined;
  defaultValue?: string | undefined;
  required?: boolean;
}) {
  const t = useTranslate();
  const describedBy = [errorKey ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        aria-invalid={errorKey ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {errorKey ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {t(errorKey as Parameters<typeof t>[0])}
        </p>
      ) : null}
    </div>
  );
}

export function LoginForm({ next }: { next: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(loginAction, idleFormState);

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />

      <FormMessage state={state} />

      <Field
        id="login-email"
        name="email"
        type="email"
        autoComplete="email"
        label={t('auth.field.email')}
        errorKey={state.fieldErrors?.email}
      />
      <Field
        id="login-password"
        name="password"
        type="password"
        autoComplete="current-password"
        label={t('auth.field.password')}
        errorKey={state.fieldErrors?.password}
      />

      <SubmitButton label={t('action.signIn')} />
      <p className="text-center text-xs text-muted">{t('auth.legal')}</p>
    </form>
  );
}

export function RegisterForm({
  invitationToken,
  email,
}: {
  invitationToken?: string | undefined;
  email?: string | undefined;
}) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(registerAction, idleFormState);

  return (
    <form action={action} className="space-y-4" noValidate>
      {invitationToken ? (
        <input type="hidden" name="invitationToken" value={invitationToken} />
      ) : null}

      <FormMessage state={state} />

      <Field
        id="register-name"
        name="name"
        type="text"
        autoComplete="name"
        label={t('auth.field.name')}
        errorKey={state.fieldErrors?.name}
      />
      <Field
        id="register-email"
        name="email"
        type="email"
        autoComplete="email"
        label={t('auth.field.email')}
        defaultValue={email}
        errorKey={state.fieldErrors?.email}
      />
      <Field
        id="register-password"
        name="password"
        type="password"
        autoComplete="new-password"
        label={t('auth.field.password')}
        hint={t('auth.field.passwordHint')}
        errorKey={state.fieldErrors?.password}
      />
      {/* Sem convite, a API cria uma organização junto da conta. Nomear aqui
          evita que o primeiro espaço de trabalho se chame "workspace de fulano". */}
      {invitationToken ? null : (
        <Field
          id="register-organization"
          name="organizationName"
          type="text"
          autoComplete="organization"
          label={t('auth.field.organizationName')}
          hint={t('auth.field.organizationHint')}
          required={false}
        />
      )}

      <SubmitButton label={t('action.signUp')} />
      <p className="text-center text-xs text-muted">{t('auth.legal')}</p>
    </form>
  );
}

/** Confirma o endereço com o token que veio no link do e-mail. */
export function VerifyEmailForm({ token }: { token: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(verifyEmailAction, idleFormState);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <SubmitButton label={t('auth.verify.confirm')} />
    </form>
  );
}

/** Reenvia a mensagem de confirmação. */
export function ResendVerificationForm({ email }: { email: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    resendVerificationAction,
    idleFormState,
  );

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field
        id="verify-email"
        name="email"
        type="email"
        autoComplete="email"
        label={t('auth.field.email')}
        defaultValue={email}
      />
      <SubmitButton label={t('auth.verify.resend')} />
    </form>
  );
}

export function ForgotPasswordForm() {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(
    requestPasswordResetAction,
    idleFormState,
  );

  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field
        id="forgot-email"
        name="email"
        type="email"
        autoComplete="email"
        label={t('auth.field.email')}
        errorKey={state.fieldErrors?.email}
      />
      <SubmitButton label={t('auth.forgot.submit')} />
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslate();
  const [state, action] = useActionState<FormState, FormData>(resetPasswordAction, idleFormState);

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <Field
        id="reset-password"
        name="password"
        type="password"
        autoComplete="new-password"
        label={t('account.newPassword')}
        hint={t('auth.field.passwordHint')}
        errorKey={state.fieldErrors?.password}
      />
      <SubmitButton label={t('auth.reset.submit')} />
    </form>
  );
}
