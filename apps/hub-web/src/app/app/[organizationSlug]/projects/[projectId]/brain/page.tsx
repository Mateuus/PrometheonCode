import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PageHeader, SectionTitle } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { listKnowledge } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { knowledgeStatusBadge } from '@/lib/status-badges';
import type { KnowledgeEntry } from '@/lib/api/types';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Brain' };

function KnowledgeList({ entries, t }: { entries: KnowledgeEntry[]; t: Translate }) {
  return (
    <ul className="space-y-2">
      {entries.map((entry) => {
        const badge = knowledgeStatusBadge(entry.status, t);
        return (
          <li
            key={entry.id}
            className="rounded-[var(--radius-prom)] border border-line bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-medium text-foreground">{entry.title}</h3>
              <StatusBadge tone={badge.tone} icon={badge.icon}>
                {badge.label}
              </StatusBadge>
            </div>
            <p className="mt-1 text-sm text-muted">{entry.summary}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-xs text-muted">{t('brain.proposedBy', { author: entry.authorName })}</p>
              {entry.status === 'proposed' ? (
                <Button size="sm" variant="secondary">
                  {t('brain.review')}
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default async function ProjectBrainPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationSlug, projectId }, query, t] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
  ]);

  const base = `/app/${organizationSlug}/projects/${projectId}`;
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const knowledge = await applyForcedState(forced, await listKnowledge(projectId), []);

  return (
    <div className="space-y-5">
      <SampleDataNotice />

      <PageHeader title={t('brain.title')} description={t('brain.subtitle')} />

      <DataView
        result={knowledge}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="brain.empty"
        retryHref={`${base}/brain`}
        backHref={base}
      >
        {(items) => {
          const proposed = items.filter((entry) => entry.status === 'proposed');
          const settled = items.filter((entry) => entry.status !== 'proposed');
          return (
            <div className="space-y-6">
              <section>
                <SectionTitle>{t('brain.proposals')}</SectionTitle>
                {proposed.length === 0 ? (
                  <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                    {t('dashboard.empty.proposals')}
                  </p>
                ) : (
                  <KnowledgeList entries={proposed} t={t} />
                )}
              </section>

              <section>
                <SectionTitle>{t('brain.approved')}</SectionTitle>
                <KnowledgeList entries={settled} t={t} />
              </section>
            </div>
          );
        }}
      </DataView>
    </div>
  );
}
