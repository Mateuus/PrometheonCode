import type { ReactNode } from 'react';
import { CreditCard } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { AppShell, type NavItem } from '@/components/layout/app-shell';

/**
 * Área administrativa do Hub.
 *
 * É a operação do serviço, não de uma organização: aqui moram os planos e os
 * limites que valem para todo mundo. Quem pode entrar é decidido pela Hub API —
 * o middleware só exige sessão.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const t = await getTranslate();

  const navItems: NavItem[] = [
    { href: '/admin/plans', label: t('nav.plans'), icon: <CreditCard /> },
  ];

  return <AppShell navItems={navItems}>{children}</AppShell>;
}
