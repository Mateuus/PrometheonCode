import type { Metadata } from 'next';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import {
  AdminDisclosure,
  AssignPlanForm,
  OrganizationLimitsForm,
} from '@/components/forms/admin-forms';
import { listAdminOrganizations, listPlans } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { formatBytes, formatNumber } from '@/lib/format';
import type { AdminOrganization, Plan } from '@/lib/api/types';
import type { MessageKey } from '@/i18n/catalog';
import type { Locale } from '@/i18n/config';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Organizations' };

/**
 * Organizações da plataforma, com o teto que vale e o consumo medido.
 *
 * A tela mostra os dois números lado a lado de propósito: teto sozinho não diz
 * se apertar ou soltar, e consumo sozinho não diz se já bateu. O que aparece
 * como limite é o **efetivo** — a exceção da organização quando existe, o plano
 * quando não.
 */

const USAGE_ROWS: {
  key: keyof AdminOrganization['usage'] & ('members' | 'projects' | 'knowledgeItems' | 'agentRunsThisMonth');
  limitKey: 'maxMembers' | 'maxProjects' | 'maxKnowledgeItems' | 'maxAgentRunsPerMonth';
  labelKey: MessageKey;
}[] = [
  { key: 'members', limitKey: 'maxMembers', labelKey: 'admin.plans.limit.members' },
  { key: 'projects', limitKey: 'maxProjects', labelKey: 'admin.plans.limit.projects' },
  { key: 'knowledgeItems', limitKey: 'maxKnowledgeItems', labelKey: 'admin.plans.limit.knowledge' },
  {
    key: 'agentRunsThisMonth',
    limitKey: 'maxAgentRunsPerMonth',
    labelKey: 'admin.plans.limit.agentRuns',
  },
];

function limitText(value: number | null, t: Translate, locale: Locale): string {
  return value === null ? t('admin.plans.unlimited') : formatNumber(value, locale);
}

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, t, locale] = await Promise.all([searchParams, getTranslate(), getLocale()]);
  const forced = devForcedState(query);
  const search = typeof query.search === 'string' ? query.search : undefined;

  const [organizations, plans] = await Promise.all([
    applyForcedState(forced, await listAdminOrganizations({ search }), []),
    listPlans(),
  ]);

  const planList: Plan[] = plans.ok ? plans.data : [];

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />

      <PageHeader
        title={t('admin.organizations.title')}
        description={t('admin.organizations.subtitle')}
      />

      {/* Busca por GET: o estado da tela mora na URL, então o link é
          compartilhável e o botão voltar funciona. */}
      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="search"
          defaultValue={search ?? ''}
          placeholder={t('admin.organizations.searchPlaceholder')}
          aria-label={t('admin.organizations.searchPlaceholder')}
          className="h-9 w-full max-w-sm rounded-[var(--radius-prom)] border border-line bg-surface px-3 text-sm"
        />
        <button
          type="submit"
          className="h-9 rounded-[var(--radius-prom)] bg-accent px-3 text-sm font-medium text-accent-foreground"
        >
          {t('admin.organizations.search')}
        </button>
      </form>

      <DataView
        result={organizations}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="admin.organizations.empty"
        retryHref="/admin/organizations"
        backHref="/app"
      >
        {(items) => (
          <ul className="space-y-4">
            {items.map((organization) => (
              <li key={organization.id}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{organization.name}</CardTitle>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge>{organization.slug}</Badge>
                      <StatusBadge tone={organization.status === 'active' ? 'success' : 'alert'}>
                        {organization.planName}
                      </StatusBadge>
                      {organization.ownerEmail ? (
                        <span className="text-xs text-muted">{organization.ownerEmail}</span>
                      ) : null}
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                      {USAGE_ROWS.map((row) => (
                        <div key={row.key} className="flex items-center justify-between gap-2">
                          <dt className="text-muted">{t(row.labelKey)}</dt>
                          <dd className="font-medium text-foreground">
                            {formatNumber(organization.usage[row.key], locale)}
                            {' / '}
                            {limitText(organization.limits[row.limitKey], t, locale)}
                            {organization.overrides[row.limitKey] === null ? null : (
                              <span className="ml-1.5 text-xs font-normal text-muted">
                                {t('admin.organizations.overridden')}
                              </span>
                            )}
                          </dd>
                        </div>
                      ))}

                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted">{t('admin.plans.limit.storage')}</dt>
                        <dd className="font-medium text-foreground">
                          {organization.limits.maxStorageBytes === null
                            ? t('admin.plans.unlimited')
                            : formatBytes(organization.limits.maxStorageBytes, locale)}
                        </dd>
                      </div>
                    </dl>

                    <div className="flex flex-wrap gap-2">
                      <AdminDisclosure label={t('admin.organizations.changePlan')}>
                        <AssignPlanForm organization={organization} plans={planList} />
                      </AdminDisclosure>

                      <AdminDisclosure label={t('admin.organizations.editLimits')}>
                        <OrganizationLimitsForm organization={organization} />
                      </AdminDisclosure>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </DataView>
    </div>
  );
}
