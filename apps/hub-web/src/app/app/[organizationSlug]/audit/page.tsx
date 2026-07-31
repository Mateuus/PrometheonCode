import Link from 'next/link';
import type { Metadata } from 'next';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForbiddenState } from '@/components/states/screen-states';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { SwitchToOrganizationButton } from '@/components/layout/organization-switcher';
import { getOrganizationBySlug, getViewer, listAuditEvents } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
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
  const forced = devForcedState(query);
  const cursorRaw = query.cursor;
  const cursor = Array.isArray(cursorRaw) ? cursorRaw[0] : cursorRaw;

  const [organization, viewer] = await Promise.all([
    getOrganizationBySlug(organizationSlug),
    getViewer(),
  ]);

  // A auditoria é o caso em que a interface antecipa a negação: quem não tem
  // `audit.read` vê a explicação, não uma tabela vazia. A API decide de novo.
  if (
    organization.ok &&
    !viewerCan(
      { role: organization.data.role, permissions: organization.data.permissions },
      'audit.read',
    )
  ) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />
        <ForbiddenState backHref={base} />
      </div>
    );
  }

  /**
   * `GET /v1/audit` resolve a organização pelo **token**, não pela URL: não há
   * parâmetro de organização na rota. Se a sessão está ancorada noutra
   * organização, a lista abaixo não é a desta tela — e dizer isso é melhor que
   * mostrar registros do lugar errado com um título que promete outro.
   *
   * O aviso vem acompanhado da correção: `POST /v1/auth/switch-organization`
   * reancora a sessão aqui. Antes dessa rota existir, só restava avisar.
   */
  const scopeMismatch =
    organization.ok &&
    viewer.ok &&
    viewer.data.activeOrganizationId !== null &&
    viewer.data.activeOrganizationId !== organization.data.id;

  const events = await applyForcedState(
    forced,
    organization.ok ? await listAuditEvents(cursor) : organization,
  );

  return (
    <div className="space-y-6">
      <ForcedStateNotice forced={forced} />

      <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />

      {scopeMismatch && organization.ok ? (
        <Alert
          tone="alert"
          title={t('audit.scopeMismatch')}
          action={
            <SwitchToOrganizationButton
              organizationId={organization.data.id}
              next={`${base}/audit`}
              label={t('audit.scopeMismatchAction')}
            />
          }
        />
      ) : null}

      <DataView
        result={events}
        isEmpty={(page) => page.items.length === 0}
        emptyDescriptionKey="audit.empty"
        retryHref={`${base}/audit`}
        backHref={base}
      >
        {(page) => (
          <div className="space-y-3">
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
                  {page.items.map((event) => (
                    <tr key={event.id} className="border-b border-line bg-surface last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 text-muted">
                        {absoluteDateTime(event.createdAt, locale)}
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {event.actorUser?.name ?? t('audit.actor.system')}
                      </td>
                      <td className="px-4 py-3">
                        <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-accent">
                          {event.action}
                        </code>
                      </td>
                      <td className="px-4 py-3 text-muted">
                        <Badge>{event.resourceType}</Badge>
                        {event.resourceId ? (
                          <span className="ml-1.5 font-mono text-xs">
                            {event.resourceId.slice(-8)}
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">
                        {event.ipAddress ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {page.pageInfo.hasMore && page.pageInfo.nextCursor ? (
              <Button asChild variant="secondary" size="sm">
                <Link
                  href={`${base}/audit?cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`}
                >
                  {t('audit.loadMore')}
                </Link>
              </Button>
            ) : null}
          </div>
        )}
      </DataView>
    </div>
  );
}
