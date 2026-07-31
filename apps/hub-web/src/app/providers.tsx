'use client';

import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n/provider';
import type { Dictionary } from '@/i18n/dictionary';
import type { Locale } from '@/i18n/config';
import { ConnectionProvider, type ConnectionStatus } from '@/components/states/connection';

/**
 * Fronteira entre servidor e cliente.
 *
 * Tudo que o cliente precisa saber chega pronto do servidor: o dicionário já
 * resolvido no idioma da requisição e o estado inicial da conexão. É o único
 * Client Component da raiz.
 */
export function Providers({
  locale,
  dictionary,
  forcedConnection,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  forcedConnection?: ConnectionStatus | undefined;
  children: ReactNode;
}) {
  return (
    <I18nProvider locale={locale} dictionary={dictionary}>
      <ConnectionProvider forced={forcedConnection}>{children}</ConnectionProvider>
    </I18nProvider>
  );
}
