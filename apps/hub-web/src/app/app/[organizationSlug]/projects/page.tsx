import Link from 'next/link';
import type { Metadata } from 'next';
import { FolderGit2, GitBranch, Plus } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { SampleDataNotice } from '@/components/layout/sample-data-notice';
import { getOrganizationBySlug, listProjects } from '@/lib/api/queries';
import { applyForcedState, readForcedState } from '@/lib/api/state-override';
import { env } from '@/lib/env';
import { relativeTime } from '@/lib/format';
import { viewerCan } from '@/lib/roles';
import { plural } from '@/i18n/plural';

export const metadata: Metadata = { title: 'Projects' };

export default async function ProjectsPage({
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
  const projects = await applyForcedState(
    forced,
    organization.ok ? await listProjects(organization.data.id) : { ok: false, kind: 'not-found' },
    [],
  );

  // A API é quem autoriza de fato; aqui só evitamos oferecer um botão que ela
  // negaria.
  const canCreate = organization.ok && viewerCan(organization.data.viewerRole, 'project.create');

  return (
    <div className="space-y-6">
      <SampleDataNotice />

      <PageHeader
        title={t('projects.title')}
        description={t('projects.subtitle')}
        {...(canCreate
          ? {
              actions: (
                <Button size="sm">
                  <Plus aria-hidden />
                  {t('projects.create')}
                </Button>
              ),
            }
          : {})}
      />

      <DataView
        result={projects}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="projects.empty"
        retryHref={`${base}/projects`}
        backHref="/app"
        {...(canCreate
          ? {
              emptyAction: (
                <Button size="sm">
                  <Plus aria-hidden />
                  {t('projects.create')}
                </Button>
              ),
            }
          : {})}
      >
        {(items) => (
          <ul className="grid gap-3 md:grid-cols-2">
            {items.map((project) => (
              <li
                key={project.id}
                className="rounded-[var(--radius-prom)] border border-line bg-surface p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-accent-soft text-accent">
                    <FolderGit2 aria-hidden className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      <Link
                        href={`${base}/projects/${project.id}`}
                        className="hover:text-accent"
                      >
                        {project.name}
                      </Link>
                    </h2>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted">{project.description}</p>
                  </div>
                  {project.activeAgentCount > 0 ? (
                    <StatusBadge tone="running">
                      {plural(t, 'projects.activeAgents', project.activeAgentCount)}
                    </StatusBadge>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge>{plural(t, 'projects.openTasks', project.openTaskCount)}</Badge>
                  <span className="inline-flex items-center gap-1">
                    <GitBranch aria-hidden className="size-3.5" />
                    {project.defaultBranch}
                  </span>
                  <span>
                    {t('projects.lastActivity', {
                      relativeTime: relativeTime(project.lastActivityAt, locale),
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataView>
    </div>
  );
}
