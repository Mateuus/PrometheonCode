import type { Metadata } from 'next';
import { Bot, MonitorSmartphone } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { listAgents } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { agentStatusBadge } from '@/lib/status-badges';

export const metadata: Metadata = { title: 'Agents' };

export default async function ProjectAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ organizationSlug, projectId }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslate(),
    getLocale(),
  ]);

  const base = `/app/${organizationSlug}/projects/${projectId}`;
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const agents = await applyForcedState(forced, await listAgents(projectId), []);

  return (
    <div className="space-y-4">
      <SampleDataNotice />

      <h2 className="text-sm font-semibold text-foreground">{t('agents.title')}</h2>

      <DataView
        result={agents}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="agents.empty"
        retryHref={`${base}/agents`}
        backHref={base}
      >
        {(items) => (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((agent) => {
              const badge = agentStatusBadge(agent.status, t);
              return (
                <li
                  key={agent.id}
                  className="rounded-[var(--radius-prom)] border border-line bg-surface p-4"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        agent.role === 'main'
                          ? 'flex size-8 items-center justify-center rounded-[6px] bg-running/10 text-running'
                          : 'flex size-8 items-center justify-center rounded-[6px] bg-surface-raised text-muted'
                      }
                    >
                      <Bot aria-hidden className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
                      <p className="text-xs text-muted">
                        {agent.role === 'main' ? t('agents.role.main') : t('agents.role.worker')}
                      </p>
                    </div>
                    <StatusBadge tone={badge.tone} icon={badge.icon} className="ml-auto">
                      {badge.label}
                    </StatusBadge>
                  </div>

                  <dl className="mt-3 space-y-1.5 text-xs">
                    <div className="flex items-center gap-1.5">
                      <dt className="sr-only">{t('agents.device')}</dt>
                      <MonitorSmartphone aria-hidden className="size-3.5 text-muted" />
                      <dd className="text-muted">{agent.deviceLabel}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">{t('agents.currentTask')}</dt>
                      <dd className="text-foreground">
                        {agent.currentTaskTitle ?? t('tasks.unassigned')}
                      </dd>
                    </div>
                    <div>
                      <dt className="sr-only">{t('agents.lastHeartbeat', { relativeTime: '' })}</dt>
                      <dd className="text-muted">
                        {agent.lastHeartbeatAt
                          ? t('agents.lastHeartbeat', {
                              relativeTime: relativeTime(agent.lastHeartbeatAt, locale),
                            })
                          : t('agents.noHeartbeat')}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </DataView>
    </div>
  );
}
