import Link from 'next/link';
import type { Metadata } from 'next';
import { Building2, ShieldCheck } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { Alert } from '@/components/ui/alert';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { SwitchToOrganizationButton } from '@/components/layout/organization-switcher';
import { getViewer, listOrganizations } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { readSession } from '@/lib/auth/session';
import { roleLabel } from '@/lib/roles';

export const metadata: Metadata = { title: 'Organizations' };

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, query, session, viewer] = await Promise.all([
    getTranslate(),
    searchParams,
    readSession(),
    getViewer(),
  ]);
  const forced = devForcedState(query);
  // A sessão fica ancorada numa organização por vez, e é ela que responde as
  // rotas sem `:orgId`. O cartão da organização ancorada diz isso; os outros
  // oferecem a troca, em vez de deixar o usuário descobrir o descompasso lá
  // dentro.
  const activeOrganizationId = viewer.ok ? viewer.data.activeOrganizationId : null;
  const organizations = await applyForcedState(forced, await listOrganizations(), []);
  const justVerified = (Array.isArray(query.verified) ? query.verified[0] : query.verified) === '1';

  return (
    <AppShell>
      <div className="space-y-6">
        <ForcedStateNotice forced={forced} />

        {justVerified ? <Alert tone="success" title={t('auth.verify.done')} /> : null}

        {session && !session.user.emailVerified ? (
          <Alert tone="alert" title={t('auth.verify.requiredToWrite')}>
            <Link href="/verify-email" className="text-link underline underline-offset-4">
              {t('auth.verify.action')}
            </Link>
          </Alert>
        ) : null}

        <PageHeader title={t('organizations.title')} description={t('organizations.subtitle')} />

        <DataView
          result={organizations}
          isEmpty={(items) => items.length === 0}
          emptyDescriptionKey="organizations.empty"
          retryHref="/app"
        >
          {(items) => (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((organization) => (
                <li key={organization.id}>
                  <Card className="h-full transition-colors hover:border-line-strong">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex size-8 items-center justify-center rounded-[var(--radius-prom)] bg-accent-soft text-accent">
                          <Building2 aria-hidden className="size-4" />
                        </span>
                        <StatusBadge tone="accent" icon={ShieldCheck}>
                          {roleLabel(organization.role, t)}
                        </StatusBadge>
                      </div>
                      <CardTitle className="mt-2 text-base">
                        <Link href={`/app/${organization.slug}`} className="hover:text-accent">
                          {organization.name}
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <Badge>{organization.planCode}</Badge>
                        <Badge>{organization.slug}</Badge>
                      </div>
                      {organization.id === activeOrganizationId ? (
                        <StatusBadge tone="activity">
                          {t('account.activeOrganization')}
                        </StatusBadge>
                      ) : (
                        <SwitchToOrganizationButton
                          organizationId={organization.id}
                          next={`/app/${organization.slug}`}
                          label={t('organizations.switchTo', { organization: organization.name })}
                        />
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </DataView>
      </div>
    </AppShell>
  );
}
