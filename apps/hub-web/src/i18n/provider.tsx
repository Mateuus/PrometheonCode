'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTranslate, type Dictionary, type Translate } from './dictionary';
import { SOURCE_LOCALE, type Locale } from './config';

type I18nContextValue = {
  locale: Locale;
  dictionary: Dictionary;
  t: Translate;
};

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * O dicionário é resolvido no servidor e entregue pronto ao cliente — mesma
 * ideia da webview da extensão: nada de string solta no cliente.
 */
export function I18nProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: ReactNode;
}) {
  const value = useMemo<I18nContextValue>(
    () => ({ locale, dictionary, t: createTranslate(dictionary) }),
    [locale, dictionary],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n precisa de um <I18nProvider> acima na árvore.');
  }
  return value;
}

export function useTranslate(): Translate {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? SOURCE_LOCALE;
}
