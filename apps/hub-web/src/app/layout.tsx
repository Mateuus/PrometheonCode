import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { getLocale } from '@/i18n/server';
import { buildDictionary } from '@/i18n/dictionary';
import { LOCALE_BCP47 } from '@/i18n/config';
import { THEME_COOKIE } from '@/lib/auth/session';
import type { ConnectionStatus } from '@/components/states/connection';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Prometheon Hub',
    template: '%s · Prometheon Hub',
  },
  description: 'Prometheon Hub — agent team coordination for your whole organization.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0b12' },
  ],
};

/**
 * O tema é decidido no servidor e sai como classe no `<html>`.
 *
 * Sem cookie, nenhuma classe é escrita e o CSS entrega a escolha ao sistema
 * operacional. Isso evita o script inline que a maioria dos sites usa para não
 * piscar — script que a nossa CSP recusaria, e com razão.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, cookieStore, headerStore] = await Promise.all([
    getLocale(),
    cookies(),
    headers(),
  ]);

  const dictionary = buildDictionary(locale);
  const theme = cookieStore.get(THEME_COOKIE)?.value;
  const themeClass = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : undefined;

  const forced = headerStore.get('x-forced-state');
  const forcedConnection: ConnectionStatus | undefined =
    forced === 'offline' || forced === 'reconnecting' ? forced : undefined;

  return (
    // `data-scroll-behavior` diz ao roteador que a rolagem suave é intencional,
    // para ele não desligá-la nas transições de rota.
    <html
      lang={LOCALE_BCP47[locale]}
      className={themeClass}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <Providers locale={locale} dictionary={dictionary} forcedConnection={forcedConnection}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
