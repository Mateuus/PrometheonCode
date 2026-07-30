import Link from 'next/link';
import type { Metadata } from 'next';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { getViewer } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { roleLabel } from '@/lib/roles';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, t] = await Promise.all([searchParams, getTranslate()]);
  await getLocale();
  const forced = devForcedState(query);
  const viewer = await applyForcedState(forced, await getViewer());

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />

      <DataView result={viewer} retryHref="/settings/account" backHref="/app">
        {(data) => (
          <div className="max-w-2xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.profile')}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-line text-sm">
                  <div className="flex items-center justify-between gap-2 py-2">
                    <dt className="text-muted">{t('auth.field.name')}</dt>
                    <dd className="font-medium text-foreground">{data.user.name}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 py-2">
                    <dt className="text-muted">{t('auth.field.email')}</dt>
                    <dd className="flex items-center gap-2 font-medium text-foreground">
                      {data.user.email}
                      <StatusBadge tone={data.user.emailVerified ? 'success' : 'alert'}>
                        {data.user.emailVerified
                          ? t('account.emailVerified')
                          : t('account.emailUnverified')}
                      </StatusBadge>
                    </dd>
                  </div>
                </dl>
                {/* A Hub API não expõe atualização de perfil; um formulário aqui
                    seria um campo que não salva em lugar nenhum. */}
                <p className="mt-3 text-xs text-muted">{t('account.profileReadOnly')}</p>
              </CardContent>
              {data.user.emailVerified ? null : (
                <CardFooter>
                  <Button asChild size="sm">
                    <Link href="/verify-email">{t('auth.verify.action')}</Link>
                  </Button>
                </CardFooter>
              )}
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('nav.organization')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {data.organizations.map((organization) => (
                    <li key={organization.id} className="flex items-center gap-2">
                      <Link
                        href={`/app/${organization.slug}`}
                        className="min-w-0 flex-1 truncate text-link hover:underline"
                      >
                        {organization.name}
                      </Link>
                      <StatusBadge tone="accent">{roleLabel(organization.role, t)}</StatusBadge>
                      {organization.id === data.activeOrganizationId ? (
                        <StatusBadge tone="activity">{t('account.activeOrganization')}</StatusBadge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('account.security')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Trocar a senha logado ainda não tem rota na API; o caminho
                    honesto é o mesmo da recuperação, que existe e funciona. */}
                <p className="text-sm text-muted">{t('account.changePasswordHint')}</p>
                <Alert title={t('account.changePasswordViaEmail')} />
              </CardContent>
              <CardFooter>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/forgot-password">{t('account.changePassword')}</Link>
                </Button>
              </CardFooter>
            </Card>
          </div>
        )}
      </DataView>
    </div>
  );
}
