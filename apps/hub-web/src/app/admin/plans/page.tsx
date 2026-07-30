import type { Metadata } from 'next';
import { Plus } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { listPlans } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { formatMegabytes, formatMoney, formatNumber } from '@/lib/format';
import { plural } from '@/i18n/plural';
import type { Locale } from '@/i18n/config';
import type { Plan } from '@/lib/api/types';
import type { MessageKey } from '@/i18n/catalog';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Plans' };

/**
 * Limites de um plano, na ordem em que fazem sentido para quem compara.
 *
 * A lista é declarativa para que acrescentar um limite novo seja acrescentar uma
 * linha — e para que um plano pago futuro reuse a mesma tabela sem tocar na
 * tela. Hoje existe um único plano gratuito; a tela nunca assumiu isso.
 */
const LIMIT_ROWS: {
  key: keyof Plan['limits'];
  labelKey: MessageKey;
  format: 'count' | 'megabytes' | 'days';
}[] = [
  { key: 'membersPerOrganization', labelKey: 'admin.plans.limit.members', format: 'count' },
  { key: 'projectsPerOrganization', labelKey: 'admin.plans.limit.projects', format: 'count' },
  { key: 'concurrentAgents', labelKey: 'admin.plans.limit.agents', format: 'count' },
  { key: 'messagesPerMonth', labelKey: 'admin.plans.limit.messages', format: 'count' },
  { key: 'knowledgeStorageMb', labelKey: 'admin.plans.limit.storage', format: 'megabytes' },
  { key: 'auditRetentionDays', labelKey: 'admin.plans.limit.retention', format: 'days' },
];

function limitLabel(
  value: number | null,
  format: 'count' | 'megabytes' | 'days',
  t: Translate,
  locale: Locale,
): string {
  if (value === null) {
    return t('admin.plans.unlimited');
  }
  if (format === 'megabytes') {
    return formatMegabytes(value, locale);
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
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const plans = await applyForcedState(forced, await listPlans(), []);

  return (
    <div className="space-y-5">
      <SampleDataNotice />

      <PageHeader
        title={t('admin.plans.title')}
        description={t('admin.plans.subtitle')}
        actions={
          <Button size="sm">
            <Plus aria-hidden />
            {t('admin.plans.create')}
          </Button>
        }
      />

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
                      {plan.priceCents === 0
                        ? t('admin.plans.priceFree')
                        : t('admin.plans.pricePerMonth', {
                            price: formatMoney(plan.priceCents, plan.currency, locale),
                          })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {plan.isDefault ? (
                        <StatusBadge tone="accent">{t('admin.plans.default')}</StatusBadge>
                      ) : null}
                      <StatusBadge tone={plan.visible ? 'success' : 'neutral'}>
                        {plan.visible
                          ? t('admin.plans.statusActive')
                          : t('admin.plans.statusHidden')}
                      </StatusBadge>
                      <Badge>
                        {plural(t, 'admin.plans.organizationsOnPlan', plan.organizationCount, {
                          count: formatNumber(plan.organizationCount, locale),
                        })}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                      {t('admin.plans.limits')}
                    </h3>
                    <dl className="divide-y divide-line text-sm">
                      {LIMIT_ROWS.map((row) => (
                        <div key={row.key} className="flex items-center justify-between gap-2 py-1.5">
                          <dt className="text-muted">{t(row.labelKey)}</dt>
                          <dd className="font-medium text-foreground">
                            {limitLabel(plan.limits[row.key], row.format, t, locale)}
                          </dd>
                        </div>
                      ))}
                    </dl>
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
