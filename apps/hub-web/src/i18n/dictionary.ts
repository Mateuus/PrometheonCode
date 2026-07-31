import { CATALOG, type MessageKey } from './catalog';
import { SOURCE_LOCALE, type Locale, type TranslatedLocale } from './config';
import ptBr from './messages/pt-br.json';
import es from './messages/es.json';

/** Bundles de tradução, indexados pelo texto em inglês. */
const BUNDLES: Record<TranslatedLocale, Record<string, string>> = {
  'pt-br': ptBr,
  es,
};

/** Dicionário já resolvido: chave estruturada → texto no idioma pedido. */
export type Dictionary = Record<MessageKey, string>;

export type TranslationValues = Record<string, string | number>;

/** Substitui `{marcador}` pelos valores informados. */
export function interpolate(template: string, values?: TranslationValues): string {
  if (!values) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Monta o dicionário de um idioma. Chave sem tradução cai no inglês — a tela
 * nunca mostra a chave crua, e o teste de i18n é quem cobra a tradução faltante.
 */
export function buildDictionary(locale: Locale): Dictionary {
  const entries = Object.entries(CATALOG) as [MessageKey, string][];
  if (locale === SOURCE_LOCALE) {
    return Object.fromEntries(entries) as Dictionary;
  }

  const bundle = BUNDLES[locale];
  return Object.fromEntries(
    entries.map(([key, english]) => [key, bundle[english] ?? english]),
  ) as Dictionary;
}

export type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function createTranslate(dictionary: Dictionary): Translate {
  return (key, values) => interpolate(dictionary[key] ?? CATALOG[key], values);
}
