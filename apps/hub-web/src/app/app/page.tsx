import Link from 'next/link';
import type { Metadata } from 'next';
import { Building2, Plus, ShieldCheck } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { listOrganizations } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { roleLabel } from '@/lib/roles';
import { plural } from '@/i18n/plural';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';

export const metadata: Metadata = { title: 'Organizations' };

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, query] = await Promise.all([getTranslate(), searchParams]);
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const organizations = await applyForcedState(forced, await listOrganizations(), []);

  return (
    <AppShell>
      <div className="space-y-6">
        <SampleDataNotice />

        <PageHeader
          title={t('organizations.title')}
          description={t('organizations.subtitle')}
          actions={
            <Button size="sm">
              <Plus aria-hidden />
              {t('organizations.create')}
            </Button>
          }
        />

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
                          {roleLabel(organization.viewerRole, t)}
                        </StatusBadge>
                      </div>
                      <CardTitle className="mt-2 text-base">
                        <Link href={`/app/${organization.slug}`} className="hover:text-accent">
                          {organization.name}
                        </Link>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex gap-2">
                      <Badge>
                        {plural(t, 'organizations.memberCount', organization.memberCount)}
                      </Badge>
                      <Badge>
                        {plural(t, 'organizations.projectCount', organization.projectCount)}
                      </Badge>
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
