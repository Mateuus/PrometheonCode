import type { Metadata } from 'next';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { AdminDisclosure, CreatePlanForm, UpdatePlanForm } from '@/components/forms/admin-forms';
import { listPlans } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { formatBytes, formatMoney, formatNumber } from '@/lib/format';
import { plural } from '@/i18n/plural';
import type { Locale } from '@/i18n/config';
import type { PlanLimits } from '@/lib/api/types';
import type { MessageKey } from '@/i18n/catalog';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Plans' };

/**
 * Limites de um plano, na ordem em que fazem sentido para quem compara.
 *
 * A lista é declarativa para que acrescentar um limite novo seja acrescentar uma
 * linha. Os nomes espelham `planLimitsSchema` do contrato: armazenamento é em
 * **bytes**, e retenção é em dias.
 */
const LIMIT_ROWS: {
  key: keyof PlanLimits;
  labelKey: MessageKey;
  format: 'count' | 'bytes' | 'days';
}[] = [
  { key: 'maxMembers', labelKey: 'admin.plans.limit.members', format: 'count' },
  { key: 'maxProjects', labelKey: 'admin.plans.limit.projects', format: 'count' },
  { key: 'maxKnowledgeItems', labelKey: 'admin.plans.limit.knowledge', format: 'count' },
  { key: 'maxAgentRunsPerMonth', labelKey: 'admin.plans.limit.agentRuns', format: 'count' },
  { key: 'maxStorageBytes', labelKey: 'admin.plans.limit.storage', format: 'bytes' },
  { key: 'retentionDays', labelKey: 'admin.plans.limit.retention', format: 'days' },
];

function limitLabel(
  value: number | null,
  format: 'count' | 'bytes' | 'days',
  t: Translate,
  locale: Locale,
): string {
  if (value === null) {
    return t('admin.plans.unlimited');
  }
  if (format === 'bytes') {
    return formatBytes(value, locale);
  }
  if (format === 'days') {
    return plural(t, 'admin.plans.days', value, { count: formatNumber(value, locale) });
  }
  return formatNumber(value, locale);
}

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [query, t, locale] = await Promise.all([searchParams, getTranslate(), getLocale()]);
  const forced = devForcedState(query);
  const plans = await applyForcedState(forced, await listPlans(), []);

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />

      <PageHeader title={t('admin.plans.title')} description={t('admin.plans.subtitle')} />

      <CreatePlanForm />

      <DataView
        result={plans}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="admin.plans.empty"
        retryHref="/admin/plans"
        backHref="/app"
      >
        {(items) => (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((plan) => (
              <li key={plan.id}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="text-base">{plan.name}</CardTitle>
                    <p className="text-2xl font-semibold tracking-tight text-foreground">
                      {plan.price.amount === 0
                        ? t('admin.plans.priceFree')
                        : plan.billingPeriod === 'yearly'
                          ? t('admin.plans.pricePerYear', {
                              price: formatMoney(plan.price.amount, plan.price.currency, locale),
                            })
                          : t('admin.plans.pricePerMonth', {
                              price: formatMoney(plan.price.amount, plan.price.currency, locale),
                            })}
                    </p>
                    {plan.description ? (
                      <p className="mt-1 text-sm text-muted">{plan.description}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {plan.isDefault ? (
                        <StatusBadge tone="accent">{t('admin.plans.default')}</StatusBadge>
                      ) : null}
                      <StatusBadge tone={plan.isActive ? 'success' : 'neutral'}>
                        {plan.isActive
                          ? t('admin.plans.statusActive')
                          : t('admin.plans.statusHidden')}
                      </StatusBadge>
                      <Badge>{plan.code}</Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    <div>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        {t('admin.plans.limits')}
                      </h3>
                      <dl className="divide-y divide-line text-sm">
                        {LIMIT_ROWS.map((row) => (
                          <div
                            key={row.key}
                            className="flex items-center justify-between gap-2 py-1.5"
                          >
                            <dt className="text-muted">{t(row.labelKey)}</dt>
                            <dd className="font-medium text-foreground">
                              {limitLabel(plan.limits[row.key], row.format, t, locale)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>

                    <div>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        {t('admin.plans.features')}
                      </h3>
                      {plan.features.length === 0 ? (
                        <p className="text-sm text-muted">{t('admin.plans.noFeatures')}</p>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {plan.features.map((feature) => (
                            <li key={feature}>
                              <Badge>{feature}</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <AdminDisclosure label={t('admin.plans.edit')}>
                      <UpdatePlanForm plan={plan} />
                    </AdminDisclosure>
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
