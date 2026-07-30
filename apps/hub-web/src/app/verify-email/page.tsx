import Link from 'next/link';
import type { Metadata } from 'next';
import { MailCheck } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { ResendVerificationForm, VerifyEmailForm } from '@/components/auth/auth-form';
import { readSession } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Confirm your email' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Confirmação de e-mail.
 *
 * Duas entradas na mesma tela, porque são o mesmo assunto:
 *
 * - com `?token=`, veio do link da mensagem e só falta confirmar;
 * - sem token, o usuário chegou aqui depois de se cadastrar ou de esbarrar num
 *   `EMAIL_NOT_VERIFIED`, e o que ele precisa é reenviar a mensagem.
 *
 * Entrar sem confirmar é permitido pela API; escrever não é. Dizer isso antes
 * do erro é a diferença entre uma interface que explica e uma que só reclama.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, query, session] = await Promise.all([getTranslate(), searchParams, readSession()]);

  const token = first(query.token);
  const justSent = first(query.sent) === '1';
  const email = first(query.email) ?? session?.user.email ?? '';

  return (
    <PublicShell centered>
      <Card className="w-full max-w-md">
        <CardHeader>
          <span className="mb-2 flex size-9 items-center justify-center rounded-[var(--radius-prom)] bg-accent-soft text-accent">
            <MailCheck aria-hidden className="size-4" />
          </span>
          <CardTitle className="text-lg">{t('auth.verify.title')}</CardTitle>
          <CardDescription>
            {email === ''
              ? t('auth.verify.description')
              : t('auth.verify.sentTo', { email })}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {justSent ? <Alert tone="success" title={t('auth.verify.checkInbox')} /> : null}

          {token ? (
            <VerifyEmailForm token={token} />
          ) : (
            <>
              <p className="text-sm text-muted">{t('auth.verify.resendHint')}</p>
              <ResendVerificationForm email={email} />
            </>
          )}

          <p className="text-center text-sm text-muted">
            <Link href="/login" className="text-link underline underline-offset-4">
              {t('action.signIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
