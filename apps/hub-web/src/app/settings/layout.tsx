import type { ReactNode } from 'react';
import { KeyRound, UserRound } from 'lucide-react';
import { getTranslate } from '@/i18n/server';
import { AppShell, type NavItem } from '@/components/layout/app-shell';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslate();

  const navItems: NavItem[] = [
    { href: '/settings/account', label: t('nav.account'), icon: <UserRound /> },
    { href: '/settings/sessions', label: t('nav.sessions'), icon: <KeyRound /> },
  ];

  return <AppShell navItems={navItems}>{children}</AppShell>;
}
