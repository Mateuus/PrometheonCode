import type { Metadata } from 'next';
import { Download } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { DataView } from '@/components/states/data-view';
import { ForbiddenState } from '@/components/states/screen-states';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getOrganizationBySlug, listAuditEvents } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { absoluteDateTime } from '@/lib/format';
import { viewerCan } from '@/lib/roles';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationSlug }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
    getLocale(),
  ]);

  const base = `/app/${organizationSlug}`;
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const organization = await getOrganizationBySlug(organizationSlug);

  // A auditoria é o caso em que a interface antecipa a negação: quem não tem
  // `audit.read` vê a explicação, não uma tabela vazia. A API decide de novo.
  if (organization.ok && !viewerCan(organization.data.viewerRole, 'audit.read')) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />
        <ForbiddenState backHref={base} />
      </div>
    );
  }

  const events = await applyForcedState(
    forced,
    organization.ok ? await listAuditEvents(organization.data.id) : { ok: false, kind: 'not-found' },
    [],
  );

  return (
    <div className="space-y-6">
      <SampleDataNotice />

      <PageHeader
        title={t('audit.title')}
        description={t('audit.subtitle')}
        actions={
          <Button size="sm" variant="secondary">
            <Download aria-hidden />
            {t('action.export')}
          </Button>
        }
      />

      <DataView
        result={events}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="audit.empty"
        retryHref={`${base}/audit`}
        backHref={base}
      >
        {(items) => (
          <div className="overflow-x-auto rounded-[var(--radius-prom)] border border-line">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <caption className="sr-only">{t('audit.title')}</caption>
              <thead>
                <tr className="border-b border-line bg-surface-raised text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('audit.column.when')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('audit.column.actor')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('audit.column.action')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('audit.column.target')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t('audit.column.ip')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((event) => (
                  <tr key={event.id} className="border-b border-line bg-surface last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {absoluteDateTime(event.occurredAt, locale)}
                    </td>
                    <td className="px-4 py-3 text-foreground">{event.actorName}</td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-accent">
                        {event.action}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted">{event.target}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">
                      {event.ipAddress}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataView>
    </div>
  );
}
