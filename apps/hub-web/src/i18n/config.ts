/**
 * Idiomas que o Hub Web promete hoje. O inglês é a fonte: o texto das telas
 * nasce em inglês no catálogo e os demais idiomas são bundles de tradução.
 */
export const SOURCE_LOCALE = 'en' as const;

/** Idiomas traduzidos, na ordem em que aparecem no seletor. */
export const TRANSLATED_LOCALES = ['pt-br', 'es'] as const;

export const SUPPORTED_LOCALES = [SOURCE_LOCALE, ...TRANSLATED_LOCALES] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];

/** Cookie que guarda a escolha explícita do usuário. Não é credencial. */
export const LOCALE_COOKIE = 'prometheon_locale';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'pt-br': 'Português (Brasil)',
  es: 'Español',
};

/** Tag BCP 47 usada em `<html lang>` e nas APIs de formatação. */
export const LOCALE_BCP47: Record<Locale, string> = {
  en: 'en',
  'pt-br': 'pt-BR',
  es: 'es',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Escolhe o melhor idioma a partir de um cabeçalho `Accept-Language`.
 * Ignora peso (`;q=`) porque a lista já vem ordenada por preferência.
 */
export function matchLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) {
    return SOURCE_LOCALE;
  }

  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    if (!tag) {
      continue;
    }
    if (isLocale(tag)) {
      return tag;
    }
    // `pt`, `pt-pt` e `pt-BR` caem no único catálogo português que existe.
    if (tag === 'pt' || tag.startsWith('pt-')) {
      return 'pt-br';
    }
    if (tag === 'es' || tag.startsWith('es-')) {
      return 'es';
    }
    if (tag === 'en' || tag.startsWith('en-')) {
      return 'en';
    }
  }

  return SOURCE_LOCALE;
}
