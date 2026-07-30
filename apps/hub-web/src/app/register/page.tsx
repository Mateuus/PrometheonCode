import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RegisterForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Create account' };

export default async function RegisterPage() {
  const t = await getTranslate();

  return (
    <PublicShell centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('auth.register.title')}</CardTitle>
          <CardDescription>{t('auth.register.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <RegisterForm />
          <p className="mt-4 text-center text-sm text-muted">
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
