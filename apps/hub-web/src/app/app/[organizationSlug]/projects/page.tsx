import Link from 'next/link';
import type { Metadata } from 'next';
import { FolderGit2, GitBranch, Lock } from 'lucide-react';
import { getLocale, getTranslate } from '@/i18n/server';
import { PageHeader } from '@/components/ui/page';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { DataView } from '@/components/states/data-view';
import { ForcedStateNotice } from '@/components/states/forced-state-notice';
import { CreateProjectForm } from '@/components/forms/project-forms';
import { getOrganizationBySlug, listProjects } from '@/lib/api/queries';
import { applyForcedState, devForcedState } from '@/lib/api/state-override';
import { relativeTime } from '@/lib/format';
import { viewerCan } from '@/lib/roles';

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
  const forced = devForcedState(query);

  const organization = await getOrganizationBySlug(organizationSlug);
  const projects = await applyForcedState(
    forced,
    organization.ok ? await listProjects(organization.data.id) : organization,
    [],
  );

  // A API é quem autoriza de fato; aqui só evitamos oferecer um botão que ela
  // negaria. A lista de permissões vem do próprio servidor, junto da organização.
  const canCreate =
    organization.ok &&
    viewerCan({ role: organization.data.role, permissions: organization.data.permissions }, 'project.create');

  return (
    <div className="space-y-6">
      <ForcedStateNotice forced={forced} />

      <PageHeader
        title={t('projects.title')}
        description={t('projects.subtitle')}
        {...(canCreate ? { actions: <CreateProjectForm organizationSlug={organizationSlug} /> } : {})}
      />

      <DataView
        result={projects}
        isEmpty={(items) => items.length === 0}
        emptyDescriptionKey="projects.empty"
        retryHref={`${base}/projects`}
        backHref="/app"
        {...(canCreate
          ? { emptyAction: <CreateProjectForm organizationSlug={organizationSlug} /> }
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
                      <Link href={`${base}/projects/${project.id}`} className="hover:text-accent">
                        {project.name}
                      </Link>
                    </h2>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted">
                      {project.description ?? t('projects.noDescription')}
                    </p>
                  </div>
                  {project.status === 'active' ? null : (
                    <StatusBadge tone="neutral">
                      {project.status === 'paused'
                        ? t('projects.status.paused')
                        : t('projects.status.archived')}
                    </StatusBadge>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {project.visibility === 'private' ? (
                    <Badge>
                      <Lock aria-hidden className="mr-1 inline size-3" />
                      {t('projects.visibility.private')}
                    </Badge>
                  ) : null}
                  {project.repositories.length === 0 ? (
                    <Badge>{t('projects.noRepository')}</Badge>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <GitBranch aria-hidden className="size-3.5" />
                      {project.repositories[0]?.defaultBranch}
                    </span>
                  )}
                  {project.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                  <span>
                    {t('projects.lastActivity', {
                      relativeTime: relativeTime(project.updatedAt, locale),
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
