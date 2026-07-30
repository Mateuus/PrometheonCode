import Link from 'next/link';
import type { Metadata } from 'next';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { ChangePasswordForm, UpdateProfileForm } from '@/components/forms/account-forms';
import { SwitchToOrganizationButton } from '@/components/layout/organization-switcher';
import { getViewer } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { roleLabel } from '@/lib/roles';

export const metadata: Metadata = { title: 'Account' };

/**
 * Conta do usuário.
 *
 * O perfil e a senha são editáveis aqui (`PATCH /v1/me` e `POST /v1/me/password`).
 * O **e-mail não é**: trocá-lo exige provar posse do novo endereço antes de o
 * antigo perder valor, e a API não expõe esse fluxo. Por isso ele aparece como
 * dado, fora do formulário — um campo editável que não salva seria pior que a
 * ausência dele.
 */
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
                <CardTitle>{t('account.identity')}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-line text-sm">
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
                <p className="mt-3 text-xs text-muted">{t('account.emailNotEditable')}</p>
              </CardContent>
              {data.user.emailVerified ? null : (
                <CardFooter>
                  <Button asChild size="sm">
                    <Link href="/verify-email">{t('auth.verify.action')}</Link>
                  </Button>
                </CardFooter>
              )}
            </Card>

            <UpdateProfileForm
              name={data.user.name}
              locale={data.user.locale}
              timeZone={data.user.timeZone}
            />

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
                      ) : (
                        <SwitchToOrganizationButton
                          organizationId={organization.id}
                          next="/settings/account"
                          label={t('organizations.switch')}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <ChangePasswordForm />

            <p className="text-xs text-muted">
              {t('account.forgotCurrentPassword')}{' '}
              <Link href="/forgot-password" className="text-link hover:underline">
                {t('auth.forgot.link')}
              </Link>
            </p>
          </div>
        )}
      </DataView>
    </div>
  );
}
