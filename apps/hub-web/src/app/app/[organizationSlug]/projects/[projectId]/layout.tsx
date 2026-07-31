import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslate } from '@/i18n/server';
import { TabLink } from '@/components/layout/nav-link';
import { getProject } from '@/lib/api/queries';

/**
 * Casca de um projeto: trilha, título e as seções do `Docs/05`.
 *
 * Se o projeto não carrega, o layout não trava a página — ele mostra o
 * identificador e deixa a tela de dentro explicar o que houve, com o estado
 * certo. Layout que decide sozinho mostrar erro esconde o motivo real.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ organizationSlug: string; projectId: string }>;
}) {
  const [{ organizationSlug, projectId }, t] = await Promise.all([params, getTranslate()]);
  const base = `/app/${organizationSlug}/projects/${projectId}`;
  const project = await getProject(projectId);

  const tabs = [
    { href: base, label: t('project.tab.overview') },
    { href: `${base}/chat`, label: t('project.tab.chat') },
    { href: `${base}/tasks`, label: t('project.tab.tasks') },
    { href: `${base}/agents`, label: t('project.tab.agents') },
    { href: `${base}/brain`, label: t('project.tab.brain') },
    { href: `${base}/settings`, label: t('project.tab.settings') },
  ];

  return (
    <div className="space-y-5">
      <nav aria-label={t('nav.breadcrumb')} className="text-xs text-muted">
        <ol className="flex items-center gap-1.5">
          <li>
            <Link href={`/app/${organizationSlug}`} className="hover:text-foreground">
              {t('nav.dashboard')}
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href={`/app/${organizationSlug}/projects`} className="hover:text-foreground">
              {t('nav.projects')}
            </Link>
          </li>
        </ol>
      </nav>

      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {project.ok ? project.data.name : projectId}
      </h1>

      <nav aria-label={t('project.tabs')} className="overflow-x-auto border-b border-line">
        <div className="flex">
          {tabs.map((tab) => (
            <TabLink key={tab.href} href={tab.href}>
              {tab.label}
            </TabLink>
          ))}
        </div>
      </nav>

      {children}
    </div>
  );
}
