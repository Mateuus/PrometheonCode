import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AlertOctagon,
  Bot,
  BrainCircuit,
  ClipboardCheck,
  FolderGit2,
  ListTodo,
  MonitorSmartphone,
  ScrollText,
  Users,
} from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader, SectionTitle } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Stat, UsageBar } from '@/components/ui/stat';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert } from '@/components/ui/alert';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { LiveRegion } from '@/components/realtime/live-region';
import { getDashboard, resolveOrganizationId } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { absoluteDateTime, formatBytes, formatNumber, relativeTime } from '@/lib/format';
import { taskStatusBadge } from '@/lib/status-badges';
import { roleLabel } from '@/lib/roles';
import type { PlanLimits, SubscriptionOverview, Usage } from '@/lib/api/types';
import type { Locale } from '@/i18n/config';
import type { Translate } from '@/i18n/dictionary';
import type { MessageKey } from '@/i18n/catalog';

export const metadata: Metadata = { title: 'Dashboard' };

/** Só as medidas numéricas de `Usage`; `measuredAt` não vira barra. */
type UsageMetric = {
  [K in keyof Usage]: Usage[K] extends number ? K : never;
}[keyof Usage];

/** Linhas da barra de uso: o que a assinatura mede e o que o plano limita. */
const USAGE_ROWS: {
  used: UsageMetric;
  limit: keyof PlanLimits;
  labelKey: MessageKey;
}[] = [
  { used: 'members', limit: 'maxMembers', labelKey: 'dashboard.usage.members' },
  { used: 'projects', limit: 'maxProjects', labelKey: 'dashboard.usage.projects' },
  { used: 'knowledgeItems', limit: 'maxKnowledgeItems', labelKey: 'dashboard.usage.knowledge' },
  { used: 'agentRunsThisMonth', limit: 'maxAgentRunsPerMonth', labelKey: 'dashboard.usage.agentRuns' },
];

/**
 * Consumo do plano.
 *
 * Vem de `GET /v1/organizations/:id/subscription`, que é o mais perto de um
 * resumo que a API oferece: mede membros, projetos, conhecimento e execuções de
 * agente no mês, e traz os limites do plano junto. Sem ele o painel não inventa
 * números — diz que não conseguiu ler.
 */
function UsagePanel({
  subscription,
  locale,
  t,
}: {
  subscription: SubscriptionOverview | null;
  locale: Locale;
  t: Translate;
}) {
  if (subscription === null) {
    return <p className="text-sm text-muted">{t('dashboard.usage.unavailable')}</p>;
  }

  const storage = subscription.plan.limits.maxStorageBytes;
  return (
    <>
      {USAGE_ROWS.map((row) => {
        const used = subscription.usage[row.used];
        const limit = subscription.plan.limits[row.limit];
        return (
          <UsageBar
            key={row.used}
            label={t(row.labelKey)}
            valueLabel={
              limit === null
                ? formatNumber(used, locale)
                : t('dashboard.usage.ofLimit', {
                    used: formatNumber(used, locale),
                    limit: formatNumber(limit, locale),
                  })
            }
            ratio={limit === null || limit === 0 ? null : used / limit}
          />
        );
      })}
      <p className="pt-1 text-xs text-muted">
        {t('dashboard.usage.plan', { plan: subscription.plan.name })}
        {storage === null
          ? ''
          : ` · ${t('admin.plans.limit.storage')}: ${formatBytes(storage, locale)}`}
      </p>
    </>
  );
}

export default async function DashboardPage({
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

  const organizationId = await resolveOrganizationId(organizationSlug);
  const summary = await applyForcedState(
    forced,
    organizationId.ok ? await getDashboard(organizationId.data) : organizationId,
  );

  return (
    <div className="space-y-6">
      <ForcedStateNotice forced={forced} />

      {/* O painel agrega tarefas, conhecimento e agentes: qualquer um dos três
          eventos o deixa velho. */}
      <LiveRegion
        eventTypes={[
          'task.created',
          'task.updated',
          'task.claimed',
          'task.released',
          'knowledge.proposed',
          'knowledge.reviewed',
          'device.changed',
          'agent.started',
          'agent.stopped',
        ]}
      />

      <PageHeader title={t('dashboard.title')} description={t('dashboard.subtitle')} />

      <DataView result={summary} retryHref={base} backHref="/app">
        {(data) => (
          <div className="space-y-6">
            {data.partial ? <Alert tone="alert" title={t('dashboard.partial')} /> : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={t('nav.projects')}
                value={formatNumber(data.projectCount, locale)}
                icon={<FolderGit2 />}
                tone="accent"
              />
              <Stat
                label={t('dashboard.activeTasks')}
                value={formatNumber(data.activeTasks.length, locale)}
                icon={<ListTodo />}
                tone="running"
                {...(data.partial ? { hint: t('dashboard.partialHint') } : {})}
              />
              <Stat
                label={t('dashboard.blockedTasks')}
                value={formatNumber(data.blockedTasks.length, locale)}
                icon={<AlertOctagon />}
                tone="alert"
              />
              <Stat
                label={t('dashboard.pendingReviews')}
                value={formatNumber(data.pendingReviews.length, locale)}
                icon={<ClipboardCheck />}
                tone="activity"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="lg:col-span-2">
                <SectionTitle
                  action={
                    <Link href={`${base}/projects`} className="text-xs text-link hover:underline">
                      {t('action.viewAll')}
                    </Link>
                  }
                >
                  {t('dashboard.recentProjects')}
                </SectionTitle>

                {data.recentProjects.length === 0 ? (
                  <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                    {t('dashboard.empty.projects')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {data.recentProjects.map((project) => (
                      <li key={project.id}>
                        <Link
                          href={`${base}/projects/${project.id}`}
                          className="flex items-center gap-3 rounded-[var(--radius-prom)] border border-line bg-surface p-3 hover:border-line-strong"
                        >
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-accent-soft text-accent">
                            <FolderGit2 aria-hidden className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {project.name}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {t('projects.lastActivity', {
                                relativeTime: relativeTime(project.updatedAt, locale),
                              })}
                            </span>
                          </span>
                          {project.status === 'active' ? null : (
                            <StatusBadge tone="neutral">
                              {project.status === 'paused'
                                ? t('projects.status.paused')
                                : t('projects.status.archived')}
                            </StatusBadge>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>{t('dashboard.hubUsage')}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <UsagePanel subscription={data.subscription} locale={locale} t={t} />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>{t('dashboard.knowledgeProposals')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {data.knowledgeProposals.length === 0 ? (
                      <p className="text-sm text-muted">{t('dashboard.empty.proposals')}</p>
                    ) : (
                      <ul className="space-y-2">
                        {data.knowledgeProposals.slice(0, 6).map((proposal) => (
                          <li key={proposal.id} className="flex items-start gap-2">
                            <BrainCircuit aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-foreground">
                                {proposal.title}
                              </span>
                              <span className="block text-xs text-muted">
                                {proposal.proposedBy
                                  ? t('brain.proposedBy', { author: proposal.proposedBy.name })
                                  : t('brain.proposedByAgent')}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section>
                <SectionTitle>{t('dashboard.blockedTasks')}</SectionTitle>
                {data.blockedTasks.length === 0 ? (
                  <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                    {t('dashboard.empty.blocked')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {data.blockedTasks.map((task) => {
                      const badge = taskStatusBadge(task.status, t);
                      return (
                        <li
                          key={task.id}
                          className="rounded-[var(--radius-prom)] border border-line bg-surface p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <Link
                              href={`${base}/projects/${task.projectId}/tasks`}
                              className="text-sm text-foreground hover:text-accent"
                            >
                              {task.title}
                            </Link>
                            <StatusBadge tone={badge.tone} icon={badge.icon}>
                              {badge.label}
                            </StatusBadge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section>
                <SectionTitle>{t('dashboard.recentActivity')}</SectionTitle>
                {data.recentActivity.length === 0 ? (
                  <Alert title={t('dashboard.empty.activity')} />
                ) : (
                  <ul className="space-y-1.5">
                    {data.recentActivity.map((event) => (
                      <li
                        key={event.id}
                        className="flex items-center gap-2 rounded-[var(--radius-prom)] border border-line bg-surface px-3 py-2 text-sm"
                      >
                        <ScrollText aria-hidden className="size-3.5 shrink-0 text-muted" />
                        <code className="font-mono text-xs text-accent">{event.action}</code>
                        <span className="min-w-0 flex-1 truncate text-muted">
                          {event.actorUser?.name ?? t('audit.actor.system')}
                        </span>
                        <span className="shrink-0 text-xs text-muted">
                          {absoluteDateTime(event.createdAt, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section>
              <SectionTitle>{t('dashboard.activeDevices')}</SectionTitle>
              {data.activeAgents.length === 0 ? (
                <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                  {t('dashboard.empty.agents')}
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {data.activeAgents.map((agent) => (
                    <li
                      key={agent.deviceId}
                      className="rounded-[var(--radius-prom)] border border-line bg-surface p-3"
                    >
                      <div className="flex items-center gap-2">
                        <MonitorSmartphone aria-hidden className="size-4 text-running" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {agent.deviceName}
                        </span>
                        <StatusBadge tone="accent">{agent.kind}</StatusBadge>
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted">
                        <Bot aria-hidden className="size-3" />
                        {agent.activeAgentRunIds.length > 0
                          ? t('agents.runningCount', { count: agent.activeAgentRunIds.length })
                          : agent.owner.name}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <SectionTitle>{t('members.title')}</SectionTitle>
              <Card>
                <CardContent className="flex items-center gap-3 py-4">
                  <Users aria-hidden className="size-4 text-muted" />
                  <p className="text-sm text-muted">
                    {t('dashboard.membersHint', { role: roleLabel(data.organization.role, t) })}
                  </p>
                  <Link
                    href={`${base}/members`}
                    className="ml-auto text-xs text-link hover:underline"
                  >
                    {t('action.viewAll')}
                  </Link>
                </CardContent>
              </Card>
            </section>
          </div>
        )}
      </DataView>
    </div>
  );
}
