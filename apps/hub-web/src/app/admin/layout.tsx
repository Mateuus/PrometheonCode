import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Building2, CreditCard } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { AppShell, type NavItem } from '@/components/layout/app-shell';
import { getViewer } from '@/lib/api/queries';

/**
 * Área administrativa do Hub.
 *
 * É a operação do serviço, não de uma organização: aqui moram o catálogo de
 * planos e o teto de cada tenant.
 *
 * A leitura de `GET /v1/me` decide se a área abre. Isso **não** é a
 * autorização — quem nega é a Hub API, em toda rota `/admin`, a cada chamada.
 * O que o desvio evita é entregar uma casca cujos quadros responderiam 403 um
 * por um. Quando a leitura falha, a casca abre: as telas de dentro explicam o
 * motivo com o estado certo, em vez de mandar todo mundo embora por um erro de
 * rede.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [t, viewer] = await Promise.all([getTranslate(), getViewer()]);

  if (viewer.ok && !viewer.data.user.isPlatformAdmin) {
    redirect('/app');
  }

  const navItems: NavItem[] = [
    { href: '/admin/plans', label: t('nav.plans'), icon: <CreditCard /> },
    { href: '/admin/organizations', label: t('nav.organizations'), icon: <Building2 /> },
  ];

  return <AppShell navItems={navItems}>{children}</AppShell>;
}
