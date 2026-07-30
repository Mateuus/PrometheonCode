import type { Metadata } from 'next';
import { GitBranch, Settings2, ShieldCheck, Tag } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { SectionTitle } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { getProject } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { absoluteDateTime, formatNumber, relativeTime } from '@/lib/format';

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

  const forced = devForcedState(query);
  const project = await applyForcedState(forced, await getProject(projectId));
  const base = `/app/${organizationSlug}/projects/${projectId}`;

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />

      <DataView result={project} retryHref={base} backHref={`/app/${organizationSlug}/projects`}>
        {(data) => (
          <div className="space-y-5">
            <p className="max-w-2xl text-sm text-muted">
              {data.description ?? t('projects.noDescription')}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={data.status === 'active' ? 'success' : 'neutral'}>
                {data.status === 'active'
                  ? t('projects.status.active')
                  : data.status === 'paused'
                    ? t('projects.status.paused')
                    : t('projects.status.archived')}
              </StatusBadge>
              <StatusBadge tone="accent" icon={ShieldCheck}>
                {data.visibility === 'private'
                  ? t('projects.visibility.private')
                  : t('projects.visibility.organization')}
              </StatusBadge>
              {data.tags.map((tag) => (
                <Badge key={tag}>
                  <Tag aria-hidden className="mr-1 inline size-3" />
                  {tag}
                </Badge>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <section>
                <SectionTitle>{t('projects.repository')}</SectionTitle>
                <Card>
                  <CardContent className="space-y-2 py-4 text-sm">
                    {data.repositories.length === 0 ? (
                      <p className="text-muted">{t('projects.noRepository')}</p>
                    ) : (
                      data.repositories.map((repository) => (
                        <div key={repository.id} className="space-y-1">
                          <p className="break-all font-mono text-xs text-link">
                            {repository.remoteUrl}
                          </p>
                          <p className="flex items-center gap-1.5 text-xs text-muted">
                            <GitBranch aria-hidden className="size-3.5" />
                            {repository.defaultBranch}
                            <span>· {repository.provider}</span>
                          </p>
                        </div>
                      ))
                    )}
                    <p className="text-muted">
                      {t('projects.lastActivity', {
                        relativeTime: relativeTime(data.updatedAt, locale),
                      })}
                    </p>
                  </CardContent>
                </Card>
              </section>

              <section>
                <SectionTitle>{t('projectSettings.behaviour')}</SectionTitle>
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5 text-sm">
                      <Settings2 aria-hidden className="size-3.5 text-muted" />
                      {t('projectSettings.defaults')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="divide-y divide-line text-sm">
                      <div className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted">{t('projectSettings.workMode')}</dt>
                        <dd className="font-medium text-foreground">
                          {data.settings.defaultWorkMode === 'plan'
                            ? t('chat.mode.plan')
                            : data.settings.defaultWorkMode === 'edit'
                              ? t('chat.mode.edit')
                              : t('chat.mode.agentTeam')}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted">{t('projectSettings.autonomy')}</dt>
                        <dd className="font-medium text-foreground">
                          {data.settings.defaultAutonomy === 'auto'
                            ? t('projectSettings.autonomy.auto')
                            : t('projectSettings.autonomy.manual')}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted">{t('projectSettings.requireReview')}</dt>
                        <dd className="font-medium text-foreground">
                          {data.settings.requireReview ? t('common.yes') : t('common.no')}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted">{t('projectSettings.remoteAgents')}</dt>
                        <dd className="font-medium text-foreground">
                          {data.settings.allowRemoteAgents ? t('common.yes') : t('common.no')}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted">{t('projectSettings.contextBudget')}</dt>
                        <dd className="font-medium text-foreground">
                          {t('projectSettings.tokens', {
                            count: formatNumber(data.settings.contextBudgetTokens, locale),
                          })}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2 py-1.5">
                        <dt className="text-muted">{t('projects.createdAt')}</dt>
                        <dd className="font-medium text-foreground">
                          {absoluteDateTime(data.createdAt, locale)}
                        </dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>
              </section>
            </div>
          </div>
        )}
      </DataView>
    </div>
  );
}
