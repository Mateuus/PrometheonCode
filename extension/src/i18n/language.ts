/**
 * Idioma da interface.
 *
 * Por padrão o Prometheon segue o VS Code. Quem quiser fixar um idioma
 * escolhe aqui, e a escolha vale para o texto da extensão e para o da webview —
 * o manifest continua com o VS Code, porque ele é lido antes de a extensão
 * ativar e nenhuma configuração nossa alcança esse momento.
 */

/** `auto` segue o VS Code; os demais fixam o idioma. */
export type LanguageChoice = 'auto' | 'en' | 'pt-br' | 'es';

export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ['auto', 'en', 'pt-br', 'es'];

/** Idiomas com bundle em `l10n/`. O inglês é a fonte e não tem arquivo. */
export const TRANSLATED_LOCALES = ['pt-br', 'es'] as const;

export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];

export const LANGUAGE_LABELS: Record<LanguageChoice, string> = {
  auto: 'Follow VS Code',
  en: 'English',
  'pt-br': 'Português (Brasil)',
  es: 'Español',
};

export const LANGUAGE_DESCRIPTIONS: Record<LanguageChoice, string> = {
  auto: 'Use the display language of the editor.',
  en: 'Source language of the interface.',
  'pt-br': 'Interface in Brazilian Portuguese.',
  es: 'Interface in Spanish.',
};

export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return LANGUAGE_CHOICES.some((choice) => choice === value);
}

/**
 * Locale de bundle para um idioma do VS Code (`pt-br`, `pt-BR`, `es-ES`…).
 * Sem bundle correspondente, devolve `null` e o inglês da fonte permanece.
 */
export function toTranslatedLocale(language: string): TranslatedLocale | null {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('pt')) {
    return 'pt-br';
  }
  if (normalized.startsWith('es')) {
    return 'es';
  }
  return null;
}
