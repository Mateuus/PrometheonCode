import type { ReactNode } from 'react';
import { FolderGit2, LayoutDashboard, ScrollText, Users } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { AppShell, type NavItem } from '@/components/layout/app-shell';
import { RealtimeConnection } from '@/components/states/connection';
import { resolveOrganizationId } from '@/lib/api/queries';

/**
 * Casca de uma organização.
 *
 * A navegação lateral é montada aqui e vale para todas as telas de dentro. O
 * layout não carrega dado de tela nenhuma — quem busca é cada página, para que
 * uma tela lenta não segure as outras.
 *
 * A única leitura é a tradução do slug em id, porque é dela que sai a inscrição
 * do canal ao vivo. Se falhar, o canal simplesmente não abre e as páginas de
 * dentro explicam o motivo com o estado certo.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ organizationSlug: string }>;
}) {
  const [{ organizationSlug }, t] = await Promise.all([params, getTranslate()]);
  const base = `/app/${organizationSlug}`;
  const organizationId = await resolveOrganizationId(organizationSlug);

  const navItems: NavItem[] = [
    { href: base, label: t('nav.dashboard'), icon: <LayoutDashboard />, exact: true },
    { href: `${base}/projects`, label: t('nav.projects'), icon: <FolderGit2 /> },
    { href: `${base}/members`, label: t('nav.members'), icon: <Users /> },
    { href: `${base}/audit`, label: t('nav.audit'), icon: <ScrollText /> },
  ];

  return (
    <AppShell navItems={navItems}>
      {organizationId.ok ? <RealtimeConnection organizationId={organizationId.data} /> : null}
      {children}
    </AppShell>
  );
}
