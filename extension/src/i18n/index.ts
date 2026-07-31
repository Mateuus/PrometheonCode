import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { WEBVIEW_STRINGS, type WebviewStringKey, type WebviewStrings } from './catalog';
import {
  isLanguageChoice,
  toTranslatedLocale,
  type LanguageChoice,
  type TranslatedLocale,
} from './language';

export { WEBVIEW_STRINGS, type WebviewStringKey, type WebviewStrings };
export * from './language';

/**
 * Bundle escolhido à mão. Fica nulo quando o idioma é `auto` ou `en`: aí quem
 * traduz é o `vscode.l10n`, com o bundle que o próprio VS Code carregou.
 */
let override: Readonly<Record<string, string>> | null = null;
let choice: LanguageChoice = 'auto';
let bundleRoot: string | null = null;

/** Guarda de onde ler os bundles. Chamado uma vez, na ativação. */
export function initializeLanguage(extensionPath: string, preferred: unknown): void {
  bundleRoot = extensionPath;
  applyLanguage(isLanguageChoice(preferred) ? preferred : 'auto');
}

/** Idioma escolhido pelo usuário, do jeito que a configuração guarda. */
export function languageChoice(): LanguageChoice {
  return choice;
}

/**
 * Troca o idioma em uso. Devolve `true` quando algo mudou de fato — quem chama
 * usa isso para redesenhar a webview, que recebe o texto já traduzido.
 */
export function applyLanguage(preferred: LanguageChoice): boolean {
  if (preferred === choice) {
    return false;
  }
  choice = preferred;
  override = preferred === 'auto' ? null : loadBundle(toTranslatedLocale(preferred));
  return true;
}

function loadBundle(locale: TranslatedLocale | null): Readonly<Record<string, string>> | null {
  // Inglês é a fonte: um dicionário vazio já devolve a própria chave.
  if (locale === null) {
    return {};
  }
  if (bundleRoot === null) {
    return null;
  }
  try {
    const text = readFileSync(join(bundleRoot, 'l10n', `bundle.l10n.${locale}.json`), 'utf8');
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string>)
      : null;
  } catch {
    // Sem bundle legível, o inglês da fonte continua valendo.
    return null;
  }
}

/**
 * Traduz uma mensagem do lado da extensão.
 *
 * A chave é o próprio texto em inglês, como manda `vscode.l10n`: os bundles em
 * `l10n/bundle.l10n.<locale>.json` mapeiam esse texto para o idioma ativo. Sem
 * bundle para o idioma, o inglês volta intacto — nunca uma chave crua na tela.
 *
 * Interpolação usa `{0}`, `{1}`… ou nomes:
 * `t('Signed in as {account}', { account })`.
 */
type Interpolation = string | number | boolean;

export function t(message: string, ...args: Interpolation[]): string;
export function t(message: string, args: Record<string, Interpolation>): string;
export function t(
  message: string,
  ...args: Interpolation[] | [Record<string, Interpolation>]
): string {
  const [first] = args;
  const named = args.length === 1 && typeof first === 'object' && first !== null;

  if (override !== null) {
    const translated = override[message] ?? message;
    return named
      ? interpolate(translated, first as Record<string, Interpolation>)
      : interpolate(translated, args as Interpolation[]);
  }
  return named
    ? vscode.l10n.t(message, first as Record<string, Interpolation>)
    : vscode.l10n.t(message, ...(args as Interpolation[]));
}

/** Mesmos marcadores do `vscode.l10n`: `{0}` por posição, `{nome}` por chave. */
function interpolate(
  message: string,
  args: readonly Interpolation[] | Record<string, Interpolation>,
): string {
  return message.replace(/\{([^}]+)\}/g, (match, token: string) => {
    const value = Array.isArray(args)
      ? args[Number(token)]
      : (args as Record<string, Interpolation>)[token];
    return value === undefined ? match : String(value);
  });
}

/**
 * Catálogo da webview no idioma ativo, indexado pelo texto em inglês — que é a
 * chave que o cliente usa. A webview não alcança `vscode.l10n`, então o
 * dicionário viaja junto do HTML.
 */
export function webviewStrings(): Record<string, string> {
  const entries = Object.entries(WEBVIEW_STRINGS) as [WebviewStringKey, string][];
  return Object.fromEntries(entries.map(([, english]) => [english, t(english)]));
}

/** Idioma em uso pelo VS Code (`pt-br`, `es`, `en`…), normalizado. */
export function currentLanguage(): string {
  return vscode.env.language.toLowerCase();
}

/** Idioma que a interface está mostrando — a escolha do usuário vence. */
export function activeLanguage(): string {
  return choice === 'auto' ? currentLanguage() : choice;
}
