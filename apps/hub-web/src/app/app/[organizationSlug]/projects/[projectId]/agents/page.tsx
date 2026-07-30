import type { Metadata } from 'next';
import { Bot, MonitorSmartphone, UserRound } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { SectionTitle } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert } from '@/components/ui/alert';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { LiveRegion } from '@/components/realtime/live-region';
import { listActiveAgents, listPresence } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { relativeTime } from '@/lib/format';
import { agentStatusBadge, presenceBadge } from '@/lib/status-badges';

export const metadata: Metadata = { title: 'Agents' };

/**
 * Quem está rodando o quê, e de qual máquina.
 *
 * O que a API expõe hoje é o **dispositivo**: `GET /v1/projects/:id/agents/active`
 * devolve as máquinas com agentes ativos, com o dono e os ids das execuções em
 * curso. Não há rota de execução de agente (`agent runs`) — o contrato tem o
 * schema, mas nenhuma rota o serve. Por isso a tela mostra dispositivos e
 * quantas execuções há em cada um, e não finge saber o título da tarefa.
 */
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
  const forced = devForcedState(query);
  const [agentsResult, presence] = await Promise.all([
    listActiveAgents(projectId),
    listPresence(projectId),
  ]);
  const agents = await applyForcedState(forced, agentsResult, []);

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />

      <LiveRegion
        eventTypes={['device.changed', 'presence.changed', 'agent.started', 'agent.updated', 'agent.stopped']}
        projectId={projectId}
      />

      <section>
        <SectionTitle>{t('agents.title')}</SectionTitle>

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
                    key={agent.deviceId}
                    className="rounded-[var(--radius-prom)] border border-line bg-surface p-4"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex size-8 items-center justify-center rounded-[6px] bg-running/10 text-running">
                        <MonitorSmartphone aria-hidden className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {agent.deviceName}
                        </p>
                        <p className="text-xs text-muted">
                          {agent.kind}
                          {agent.platform ? ` · ${agent.platform}` : ''}
                        </p>
                      </div>
                      <StatusBadge tone={badge.tone} icon={badge.icon} className="ml-auto">
                        {badge.label}
                      </StatusBadge>
                    </div>

                    <dl className="mt-3 space-y-1.5 text-xs">
                      <div className="flex items-center gap-1.5">
                        <dt className="sr-only">{t('agents.owner')}</dt>
                        <UserRound aria-hidden className="size-3.5 text-muted" />
                        <dd className="text-muted">{agent.owner.name}</dd>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <dt className="sr-only">{t('agents.runningTitle')}</dt>
                        <Bot aria-hidden className="size-3.5 text-muted" />
                        <dd className="text-foreground">
                          {agent.activeAgentRunIds.length === 0
                            ? t('agents.noRuns')
                            : t('agents.runningCount', { count: agent.activeAgentRunIds.length })}
                        </dd>
                      </div>
                      <div>
                        <dd className="text-muted">
                          {t('agents.lastHeartbeat', {
                            relativeTime: relativeTime(agent.lastSeenAt, locale),
                          })}
                        </dd>
                      </div>
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
        </DataView>
      </section>

      <section>
        <SectionTitle>{t('chat.presence')}</SectionTitle>
        {!presence.ok || presence.data.length === 0 ? (
          <Alert title={t('chat.noPresence')} />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {presence.data.map((entry) => {
              const badge = presenceBadge(entry.status, t);
              return (
                <li
                  key={entry.user.id}
                  className="flex items-center gap-2 rounded-[var(--radius-prom)] border border-line bg-surface p-3 text-sm"
                >
                  <UserRound aria-hidden className="size-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{entry.user.name}</span>
                  <StatusBadge tone={badge.tone} icon={badge.icon}>
                    {badge.label}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
