import Link from 'next/link';
import type { Metadata } from 'next';
import { KeyRound } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { PublicShell } from '@/components/layout/public-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StateBlock } from '@/components/states/state-block';
import { ResetPasswordForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Set a new password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, query] = await Promise.all([getTranslate(), searchParams]);
  const raw = query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  return (
    <PublicShell centered>
      <div className="w-full max-w-sm">
        {token ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('auth.reset.title')}</CardTitle>
              <CardDescription>{t('auth.reset.subtitle')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ResetPasswordForm token={token} />
            </CardContent>
          </Card>
        ) : (
          // Sem token não há o que confirmar; pedir um link novo é o único
          // caminho útil, e é isso que a tela oferece.
          <StateBlock
            icon={KeyRound}
            tone="alert"
            title={t('auth.reset.invalidToken')}
            description={t('auth.reset.invalidTokenHint')}
            actions={
              <Button asChild size="sm">
                <Link href="/forgot-password">{t('auth.forgot.submit')}</Link>
              </Button>
            }
          />
        )}
      </div>
    </PublicShell>
  );
}
