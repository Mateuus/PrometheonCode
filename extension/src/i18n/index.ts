import * as vscode from 'vscode';
import { WEBVIEW_STRINGS, type WebviewStringKey, type WebviewStrings } from './catalog';

export { WEBVIEW_STRINGS, type WebviewStringKey, type WebviewStrings };

/**
 * Traduz uma mensagem do lado da extensão.
 *
 * A chave é o próprio texto em inglês, como manda `vscode.l10n`: os bundles em
 * `l10n/bundle.l10n.<locale>.json` mapeiam esse texto para o idioma do VS Code.
 * Sem bundle para o idioma ativo, o inglês volta intacto — nunca uma chave crua
 * na tela.
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
  if (args.length === 1 && typeof first === 'object' && first !== null) {
    return vscode.l10n.t(message, first);
  }
  return vscode.l10n.t(message, ...(args as Interpolation[]));
}

/**
 * Resolve o catálogo inteiro no idioma ativo. O resultado é injetado no HTML da
 * webview, que não tem como traduzir sozinha.
 */
export function webviewStrings(): WebviewStrings {
  const entries = Object.entries(WEBVIEW_STRINGS) as [WebviewStringKey, string][];
  return Object.fromEntries(entries.map(([key, english]) => [key, t(english)])) as WebviewStrings;
}

/** Idioma em uso pelo VS Code (`pt-br`, `es`, `en`…), normalizado. */
export function currentLanguage(): string {
  return vscode.env.language.toLowerCase();
}
