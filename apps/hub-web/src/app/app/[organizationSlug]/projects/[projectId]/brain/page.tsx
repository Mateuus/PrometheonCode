import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PageHeader, SectionTitle } from '@/components/ui/page';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { LiveRegion } from '@/components/realtime/live-region';
import { listKnowledge } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { knowledgeStatusBadge } from '@/lib/status-badges';
import type { KnowledgeItemSummary } from '@/lib/api/types';
import type { Translate } from '@/i18n/dictionary';

export const metadata: Metadata = { title: 'Brain' };

/** Estados que ainda esperam uma decisão humana. */
const PENDING: KnowledgeItemSummary['status'][] = ['draft', 'proposed'];

function KnowledgeList({ entries, t }: { entries: KnowledgeItemSummary[]; t: Translate }) {
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
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge>{entry.category}</Badge>
              <Badge>{t('brain.confidence', { value: entry.confidence })}</Badge>
              {entry.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {entry.proposedBy
                ? t('brain.proposedBy', { author: entry.proposedBy.name })
                : t('brain.proposedByAgent')}
            </p>
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
  const forced = devForcedState(query);
  const knowledge = await applyForcedState(forced, await listKnowledge(projectId), []);

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />

      <LiveRegion eventTypes={['knowledge.proposed', 'knowledge.reviewed']} projectId={projectId} />

      <PageHeader title={t('brain.title')} description={t('brain.subtitle')} />

      <DataView
        result={knowledge}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="brain.empty"
        retryHref={`${base}/brain`}
        backHref={base}
      >
        {(items) => {
          const pending = items.filter((entry) => PENDING.includes(entry.status));
          const settled = items.filter((entry) => !PENDING.includes(entry.status));
          return (
            <div className="space-y-6">
              <section>
                <SectionTitle>{t('brain.proposals')}</SectionTitle>
                {pending.length === 0 ? (
                  <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                    {t('dashboard.empty.proposals')}
                  </p>
                ) : (
                  <KnowledgeList entries={pending} t={t} />
                )}
              </section>

              <section>
                <SectionTitle>{t('brain.approved')}</SectionTitle>
                {settled.length === 0 ? (
                  <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                    {t('brain.empty')}
                  </p>
                ) : (
                  <KnowledgeList entries={settled} t={t} />
                )}
              </section>
            </div>
          );
        }}
      </DataView>
    </div>
  );
}
