import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { RegisterForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Create account' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, query] = await Promise.all([getTranslate(), searchParams]);

  // Aceitar um convite é criar a conta com o token junto: a Hub API consome o
  // convite dentro do próprio cadastro, e não tem endpoint separado para isso.
  const invitationToken = first(query.invitation);
  const email = first(query.email);

  return (
    <PublicShell centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('auth.register.title')}</CardTitle>
          <CardDescription>{t('auth.register.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {invitationToken ? <Alert title={t('invite.registerToAccept')} /> : null}

          <RegisterForm invitationToken={invitationToken} email={email} />

          <p className="text-center text-sm text-muted">
            {t('auth.register.hasAccount')}{' '}
            <Link href="/login" className="text-link underline underline-offset-4">
              {t('action.signIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
