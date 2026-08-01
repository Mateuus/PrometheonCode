import type * as vscode from 'vscode';
import { applyLanguage, initializeLanguage, isLanguageChoice } from '../src/i18n';
import type { PrometheonViewState } from '../src/core/state';
import { renderWebviewHtml } from '../src/views/webview/template';
import { PREVIEW_STATE } from './fixture';

/**
 * Variantes do estado, escolhidas por `?state=` na URL: cada uma é um cenário
 * que o design precisa cobrir sem depender de reproduzi-lo de verdade.
 */
function applyVariant(state: PrometheonViewState, variant: string | null): PrometheonViewState {
  switch (variant) {
    case 'no-agents':
      return { ...state, agentProfiles: [], customRoles: [] };
    case 'fresh':
      // Primeira abertura da vida: nada configurado, nada conectado.
      return {
        ...state,
        accounts: [],
        agentProfiles: [],
        customRoles: [],
        hub: { state: 'local-only' },
        conversationId: null,
        conversationTitle: '',
        messages: [],
        sessions: [],
      };
    default:
      return state;
  }
}

/**
 * Renderiza o HTML real da webview fora do VS Code.
 *
 * É o mesmo `renderWebviewHtml` do produto — template, ícones e traduções —
 * com dois substitutos: as URIs viram caminhos HTTP servidos pelo
 * `preview/server.mjs`, e o import `vscode` resolve para `vscode-shim.ts` no
 * bundle. O que o navegador mostra é o que o painel mostraria.
 */
export function renderPreviewHtml(
  extensionRoot: string,
  language: string,
  variant: string | null = null,
): string {
  const choice = isLanguageChoice(language) && language !== 'auto' ? language : 'pt-br';
  initializeLanguage(extensionRoot, choice);
  applyLanguage(choice);
  const previewState = applyVariant(PREVIEW_STATE, variant);

  const rootUri = { fsPath: extensionRoot } as unknown as vscode.Uri;
  const webview = {
    cspSource: "'self'",
    asWebviewUri(uri: { fsPath: string }) {
      const relative = uri.fsPath
        .slice(extensionRoot.length)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      return { toString: () => `/${relative}` };
    },
  } as unknown as vscode.Webview;

  const html = renderWebviewHtml(webview, rootUri);

  // Sem CSP no preview: o shim do cliente e o livereload são scripts nossos, e
  // o navegador comum não tem o esquema `vscode-webview:` que a política cita.
  const withoutCsp = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>\s*/, '');

  // O que o editor daria de graça, o preview repõe: as variáveis de tema
  // (`--vscode-*`) e a classe de tema escuro no body, que o styles.css usa
  // para escolher as superfícies.
  const themed = withoutCsp
    .replace('<link href=', '<link href="/preview/dist/theme.css" rel="stylesheet" />\n  <link href=')
    .replace('<body data-strings=', '<body class="vscode-dark" data-strings=');

  // O estado e o shim entram ANTES do main.js: `acquireVsCodeApi` precisa
  // existir quando o script do painel rodar a primeira linha.
  const bootstrap = [
    `<script>window.__PROMETHEON_PREVIEW_STATE__ = ${JSON.stringify(previewState)};</script>`,
    `<script src="/preview/dist/client.js"></script>`,
  ].join('\n  ');

  return themed.replace('<script nonce=', `${bootstrap}\n  <script nonce=`);
}
