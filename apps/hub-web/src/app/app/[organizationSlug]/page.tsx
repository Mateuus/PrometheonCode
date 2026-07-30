import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AlertOctagon,
  Bot,
  BrainCircuit,
  CircleUser,
  ClipboardCheck,
  FolderGit2,
  Radio,
} from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader, SectionTitle } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Stat, UsageBar } from '@/components/ui/stat';
import { StatusBadge } from '@/components/ui/status-badge';
import { Alert } from '@/components/ui/alert';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getDashboard, getOrganizationBySlug } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { formatMegabytes, formatNumber, relativeTime } from '@/lib/format';
import { taskStatusBadge } from '@/lib/status-badges';
import { plural } from '@/i18n/plural';

export const metadata: Metadata = { title: 'Dashboard' };

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
  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);

  const organization = await getOrganizationBySlug(organizationSlug);
  const summary = await applyForcedState(
    forced,
    organization.ok ? await getDashboard(organization.data.id) : { ok: false, kind: 'not-found' },
  );

  return (
    <div className="space-y-6">
      <SampleDataNotice />

      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle')}
      />

      <DataView result={summary} retryHref={base} backHref="/app">
        {(data) => (
          <div className="space-y-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label={t('dashboard.membersOnline')}
                value={formatNumber(data.membersOnline.length, locale)}
                icon={<CircleUser />}
                tone="activity"
              />
              <Stat
                label={t('dashboard.agentsWorking')}
                value={formatNumber(data.agentsWorking.length, locale)}
                icon={<Bot />}
                tone="running"
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
                tone="accent"
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
                                relativeTime: relativeTime(project.lastActivityAt, locale),
                              })}
                            </span>
                          </span>
                          {project.activeAgentCount > 0 ? (
                            <StatusBadge tone="running">
                              {plural(t, 'projects.activeAgents', project.activeAgentCount)}
                            </StatusBadge>
                          ) : null}
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
                    <UsageBar
                      label={t('dashboard.usage.messages')}
                      valueLabel={
                        data.usage.messages.limit === null
                          ? formatNumber(data.usage.messages.used, locale)
                          : t('dashboard.usage.ofLimit', {
                              used: formatNumber(data.usage.messages.used, locale),
                              limit: formatNumber(data.usage.messages.limit, locale),
                            })
                      }
                      ratio={
                        data.usage.messages.limit === null
                          ? null
                          : data.usage.messages.used / data.usage.messages.limit
                      }
                    />
                    <UsageBar
                      label={t('dashboard.usage.tasks')}
                      valueLabel={formatNumber(data.usage.tasks.used, locale)}
                      ratio={null}
                    />
                    <UsageBar
                      label={t('dashboard.usage.storage')}
                      valueLabel={
                        data.usage.storage.limit === null
                          ? formatMegabytes(data.usage.storage.used, locale)
                          : t('dashboard.usage.ofLimit', {
                              used: formatMegabytes(data.usage.storage.used, locale),
                              limit: formatMegabytes(data.usage.storage.limit, locale),
                            })
                      }
                      ratio={
                        data.usage.storage.limit === null
                          ? null
                          : data.usage.storage.used / data.usage.storage.limit
                      }
                    />
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
                        {data.knowledgeProposals.map((proposal) => (
                          <li key={proposal.id} className="flex items-start gap-2">
                            <BrainCircuit aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-foreground">
                                {proposal.title}
                              </span>
                              <span className="block text-xs text-muted">
                                {t('brain.proposedBy', { author: proposal.authorName })}
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
                            <p className="text-sm text-foreground">{task.title}</p>
                            <StatusBadge tone={badge.tone} icon={badge.icon}>
                              {badge.label}
                            </StatusBadge>
                          </div>
                          {task.blockedReason ? (
                            <p className="mt-1 text-xs text-muted">
                              {t('tasks.blockedReason', { reason: task.blockedReason })}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section>
                <SectionTitle>{t('dashboard.syncIncidents')}</SectionTitle>
                {data.syncIncidents.length === 0 ? (
                  <Alert title={t('dashboard.noIncidents')} />
                ) : (
                  <ul className="space-y-2">
                    {data.syncIncidents.map((incident) => (
                      <li key={incident.id}>
                        <Alert
                          tone={incident.severity === 'error' ? 'danger' : 'alert'}
                          title={incident.projectName}
                        >
                          <span className="block">{incident.summary}</span>
                          <span className="mt-1 block text-xs">
                            {relativeTime(incident.occurredAt, locale)}
                          </span>
                        </Alert>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section>
              <SectionTitle>{t('dashboard.agentsWorking')}</SectionTitle>
              {data.agentsWorking.length === 0 ? (
                <p className="rounded-[var(--radius-prom)] border border-dashed border-line p-6 text-center text-sm text-muted">
                  {t('dashboard.empty.agents')}
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {data.agentsWorking.map((agent) => (
                    <li
                      key={agent.id}
                      className="rounded-[var(--radius-prom)] border border-line bg-surface p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Radio aria-hidden className="size-4 text-running" />
                        <span className="text-sm font-medium text-foreground">{agent.name}</span>
                        <StatusBadge tone="accent" className="ml-auto">
                          {agent.role === 'main' ? t('agents.role.main') : t('agents.role.worker')}
                        </StatusBadge>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted">
                        {agent.currentTaskTitle ?? agent.deviceLabel}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DataView>
    </div>
  );
}
