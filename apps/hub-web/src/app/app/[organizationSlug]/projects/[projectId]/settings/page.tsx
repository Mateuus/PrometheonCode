import type { Metadata } from 'next';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { UpdateProjectForm } from '@/components/forms/project-settings-form';
import { getOrganizationBySlug, getProject } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { absoluteDateTime } from '@/lib/format';
import { viewerCan } from '@/lib/roles';

export const metadata: Metadata = { title: 'Project settings' };

export default async function ProjectSettingsPage({
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
  const [projectResult, organization] = await Promise.all([
    getProject(projectId),
    getOrganizationBySlug(organizationSlug),
  ]);
  const project = await applyForcedState(forced, projectResult);

  const canConfigure =
    organization.ok &&
    viewerCan(
      { role: organization.data.role, permissions: organization.data.permissions },
      'project.configure',
    );

  return (
    <div className="space-y-5">
      <ForcedStateNotice forced={forced} />

      <PageHeader title={t('projectSettings.title')} />

      <DataView result={project} retryHref={`${base}/settings`} backHref={base}>
        {(data) => (
          <div className="max-w-2xl space-y-5">
            {canConfigure ? (
              <UpdateProjectForm
                projectId={data.id}
                name={data.name}
                description={data.description ?? ''}
                version={data.version}
                returnTo={`${base}/settings`}
              />
            ) : (
              <Alert title={t('projectSettings.readOnly')} />
            )}

            <Card>
              <CardHeader>
                <CardTitle>{t('projects.repository')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {data.repositories.length === 0 ? (
                  // A API não tem rota para conectar repositório; dizer isso é
                  // melhor que oferecer um campo que não salva em lugar nenhum.
                  <p className="text-muted">{t('projectSettings.repositoryUnavailable')}</p>
                ) : (
                  data.repositories.map((repository) => (
                    <p key={repository.id} className="break-all font-mono text-xs text-link">
                      {repository.remoteUrl}
                    </p>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('projectSettings.metadata')}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-line text-sm">
                  <div className="flex items-center justify-between gap-2 py-1.5">
                    <dt className="text-muted">{t('projectSettings.slug')}</dt>
                    <dd>
                      <Badge>{data.slug}</Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 py-1.5">
                    <dt className="text-muted">{t('projects.createdAt')}</dt>
                    <dd className="font-medium text-foreground">
                      {absoluteDateTime(data.createdAt, locale)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 py-1.5">
                    <dt className="text-muted">{t('projectSettings.version')}</dt>
                    <dd className="font-medium text-foreground">{data.version}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>
        )}
      </DataView>
    </div>
  );
}
