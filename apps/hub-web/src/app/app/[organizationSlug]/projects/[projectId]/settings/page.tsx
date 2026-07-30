import type { Metadata } from 'next';
import { getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getProject } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';

export const metadata: Metadata = { title: 'Project settings' };

export default async function ProjectSettingsPage({
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
  const project = await applyForcedState(forced, await getProject(projectId));

  return (
    <div className="space-y-5">
      <SampleDataNotice />

      <PageHeader title={t('projectSettings.title')} />

      <DataView result={project} retryHref={`${base}/settings`} backHref={base}>
        {(data) => (
          <div className="max-w-2xl space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>{t('projectSettings.general')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="project-name">{t('projectSettings.name')}</Label>
                  <Input id="project-name" name="name" defaultValue={data.name} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="project-description">{t('projectSettings.description')}</Label>
                  <Textarea
                    id="project-description"
                    name="description"
                    defaultValue={data.description}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="project-repository">{t('projectSettings.repositoryUrl')}</Label>
                    <Input
                      id="project-repository"
                      name="repositoryUrl"
                      defaultValue={data.repositoryUrl}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="project-branch">{t('projectSettings.defaultBranch')}</Label>
                    <Input
                      id="project-branch"
                      name="defaultBranch"
                      defaultValue={data.defaultBranch}
                    />
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button size="sm">{t('action.save')}</Button>
              </CardFooter>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-danger">{t('projectSettings.dangerZone')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Alert tone="alert" title={t('projectSettings.archive')}>
                  {t('projectSettings.archiveHint')}
                </Alert>
              </CardContent>
              <CardFooter>
                <Button size="sm" variant="danger">
                  {t('projectSettings.archive')}
                </Button>
              </CardFooter>
            </Card>
          </div>
        )}
      </DataView>
    </div>
  );
}
