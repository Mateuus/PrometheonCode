import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { getLocale, getTranslate } from '@/i18n/server';
import { THEME_COOKIE } from '@/lib/auth/session';
import { Wordmark } from '@/components/brand/logo';
import { ThemeToggle } from './theme-toggle';
import { LocaleSelect } from './locale-select';
import type { ThemePreference } from '@/lib/actions/preference-actions';

/** Casca das telas abertas: marca, tema e idioma, sem navegação de produto. */
export async function PublicShell({
  children,
  centered = false,
}: {
  children: ReactNode;
  centered?: boolean;
}) {
  const [t, locale, cookieStore] = await Promise.all([getTranslate(), getLocale(), cookies()]);
  const themeCookie = cookieStore.get(THEME_COOKIE)?.value;
  const theme: ThemePreference =
    themeCookie === 'dark' ? 'dark' : themeCookie === 'light' ? 'light' : 'system';

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        {t('nav.skipToContent')}
      </a>

      <header className="flex h-14 items-center gap-3 border-b border-line px-4">
        <Link href="/">
          <Wordmark />
        </Link>
        <div className="flex-1" />
        <ThemeToggle current={theme} />
        <LocaleSelect current={locale} />
      </header>

      <main
        id="main"
        tabIndex={-1}
        className={
          centered
            ? 'flex flex-1 items-center justify-center px-4 py-10'
            : 'mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6'
        }
      >
        {children}
      </main>

      <footer className="border-t border-line px-4 py-4 text-center text-xs text-muted">
        {t('app.name')} · {t('common.beta')}
      </footer>
    </div>
  );
}
