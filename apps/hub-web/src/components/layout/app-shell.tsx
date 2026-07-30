import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslate } from '@/i18n/server';
import { readSession, THEME_COOKIE } from '@/lib/auth/session';
import { getViewer } from '@/lib/api/queries';
import { Wordmark } from '@/components/brand/logo';
import { ConnectionBanner, ConnectionIndicator } from '@/components/states/connection';
import { ThemeToggle } from './theme-toggle';
import { LocaleSelect } from './locale-select';
import { OrganizationSwitcher } from './organization-switcher';
import { UserMenu } from './user-menu';
import { NavLink } from './nav-link';
import type { ThemePreference } from '@/lib/actions/preference-actions';

export interface NavItem {
  href: string;
  label: string;
  icon?: ReactNode;
  exact?: boolean;
}

/**
 * Casca das telas autenticadas.
 *
 * Cabeçalho fixo, navegação lateral e uma região `main` com id, para o "pular
 * para o conteúdo" ter onde chegar. A faixa de conexão fica acima de tudo: se o
 * canal ao vivo cair, o aviso não some ao rolar a página.
 */
export async function AppShell({
  navItems,
  children,
}: {
  navItems?: NavItem[];
  children: ReactNode;
}) {
  const [t, locale, session, cookieStore, viewer] = await Promise.all([
    getTranslate(),
    getLocale(),
    readSession(),
    cookies(),
    getViewer(),
  ]);

  // O seletor precisa da lista de organizações e de qual está ancorada na
  // sessão — as duas vêm de `GET /v1/me`. Se a chamada falhar, o cabeçalho sai
  // sem o seletor: uma casca que não desenha é melhor que uma casca que quebra.
  const organizations = viewer.ok ? viewer.data.organizations : [];
  const activeOrganizationId = viewer.ok ? viewer.data.activeOrganizationId : null;

  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const theme: ThemePreference =
    themeCookie === 'dark' ? 'dark' : themeCookie === 'light' ? 'light' : 'system';

  const links = (navItems ?? []).map((item) => (
    <NavLink
      key={item.href}
      href={item.href}
      {...(item.icon ? { icon: item.icon } : {})}
      {...(item.exact ? { exact: true } : {})}
    >
      {item.label}
    </NavLink>
  ));

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        {t('nav.skipToContent')}
      </a>

      <ConnectionBanner />

      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
        <Link href="/app" className="shrink-0">
          <Wordmark />
        </Link>

        <div className="flex-1" />

        <OrganizationSwitcher
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
        />
        <ConnectionIndicator />
        <ThemeToggle current={theme} />
        <LocaleSelect current={locale} />
        {session ? <UserMenu name={session.user.name} email={session.user.email} /> : null}
      </header>

      {/* Abaixo de `lg` a navegação vira uma faixa rolável — nada de menu que
          precisa de JavaScript para abrir. */}
      {links.length > 0 ? (
        <nav
          aria-label={t('nav.primary')}
          className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2 lg:hidden [&>a]:whitespace-nowrap"
        >
          {links}
        </nav>
      ) : null}

      <div className="mx-auto flex w-full max-w-[1400px] flex-1">
        {links.length > 0 ? (
          <nav
            aria-label={t('nav.primary')}
            className="hidden w-60 shrink-0 space-y-1 border-r border-line px-3 py-4 lg:block"
          >
            {links}
          </nav>
        ) : null}

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
