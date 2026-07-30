import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { LoginForm } from '@/components/auth/auth-form';
import { safeRedirect } from '@/lib/auth/safe-redirect';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslate();
  const params = await searchParams;

  // O `next` só volta ao formulário depois de passar pelo filtro de open
  // redirect — o que chega pela URL nunca é confiável.
  const raw = params.next;
  const next = safeRedirect(Array.isArray(raw) ? raw[0] : raw);

  return (
    <PublicShell centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('auth.login.title')}</CardTitle>
          <CardDescription>{t('auth.login.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next} />
          <p className="mt-4 text-center text-sm text-muted">
            {t('auth.login.noAccount')}{' '}
            <Link href="/register" className="text-link underline underline-offset-4">
              {t('action.signUp')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </PublicShell>
  );
}
