import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ForgotPasswordForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Recover access' };

export default async function ForgotPasswordPage() {
  const t = await getTranslate();

  return (
    <PublicShell centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('auth.forgot.title')}</CardTitle>
          <CardDescription>{t('auth.forgot.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ForgotPasswordForm />
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
