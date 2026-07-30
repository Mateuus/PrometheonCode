import type { Metadata } from 'next';
import { Bot, GitBranch, ListTodo } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { SectionTitle } from '@/components/ui/page';
import { Stat } from '@/components/ui/stat';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getProject } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { formatNumber, relativeTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Overview' };

export default async function ProjectOverviewPage({
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

  const forced = readForcedState(query, env().HUB_WEB_SAMPLE_DATA);
  const project = await applyForcedState(forced, await getProject(projectId));
  const base = `/app/${organizationSlug}/projects/${projectId}`;

  return (
    <div className="space-y-5">
      <SampleDataNotice />

      <DataView result={project} retryHref={base} backHref={`/app/${organizationSlug}/projects`}>
        {(data) => (
          <div className="space-y-5">
            <p className="max-w-2xl text-sm text-muted">{data.description}</p>

            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label={t('tasks.title')}
                value={formatNumber(data.openTaskCount, locale)}
                icon={<ListTodo />}
                tone="accent"
              />
              <Stat
                label={t('dashboard.agentsWorking')}
                value={formatNumber(data.activeAgentCount, locale)}
                icon={<Bot />}
                tone="running"
              />
              <Stat
                label={t('projectSettings.defaultBranch')}
                value={data.defaultBranch}
                icon={<GitBranch />}
                tone="activity"
              />
            </div>

            <section>
              <SectionTitle>{t('project.overview.recentActivity')}</SectionTitle>
              <Card>
                <CardHeader>
                  <CardTitle>{t('projects.repository')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p className="break-all font-mono text-xs text-link">{data.repositoryUrl}</p>
                  <p className="text-muted">
                    {t('projects.lastActivity', {
                      relativeTime: relativeTime(data.lastActivityAt, locale),
                    })}
                  </p>
                </CardContent>
              </Card>
            </section>
          </div>
        )}
      </DataView>
    </div>
  );
}
