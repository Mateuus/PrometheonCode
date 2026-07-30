import * as vscode from 'vscode';
import { activeLanguage, t, webviewStrings } from '../../i18n';

/**
 * JSON embutido no HTML. `<` é o único caractere capaz de encerrar a tag antes
 * da hora, e escapá-lo mantém o conteúdo válido para o `JSON.parse` do cliente.
 */
function escapeJson(json: string): string {
  return json.replace(/</g, '\\u003c');
}

/** Nonce de uso único para liberar exatamente um script na CSP. */
export function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/**
 * Ícones desenhados em SVG inline, herdando a cor do tema por `currentColor`.
 * Ficam aqui, e não em arquivos, para não abrir mais nada na CSP.
 */
const ICONS = {
  history: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 8a5.8 5.8 0 1 0 1.7-4.1"/><path d="M2 2.6v3h3"/><path d="M8 4.9V8l2.1 1.6"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.9"/><path d="M8 5.4v5.2M5.4 8h5.2"/></svg>`,
  gear: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M6.9 1.7h2.2l.3 1.7 1.3.8 1.6-.7 1.1 1.9-1.3 1.1v1.5l1.3 1.1-1.1 1.9-1.6-.7-1.3.8-.3 1.7H6.9l-.3-1.7-1.3-.8-1.6.7L2.6 9.1l1.3-1.1V6.5L2.6 5.4l1.1-1.9 1.6.7 1.3-.8Z"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="7.1" cy="7.1" r="4.4"/><path d="M10.4 10.4 13.6 13.6"/></svg>`,
  local: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.6" width="12.4" height="8.2" rx="1.2"/><path d="M5.6 13.4h4.8"/></svg>`,
  web: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.9"/><path d="M2.1 8h11.8"/><path d="M8 2.1c1.6 1.7 2.4 3.7 2.4 5.9S9.6 12.2 8 13.9C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.1Z"/></svg>`,
  attach: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>`,
  close: `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  send: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.8V3.6"/><path d="M4.2 7.4 8 3.6l3.8 3.8"/></svg>`,
  account: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5.6" r="2.8"/><path d="M2.8 13.6a5.2 5.2 0 0 1 10.4 0"/></svg>`,
  mic: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0"/><path d="M8 11.8v2.4"/></svg>`,
  /** Asterisco do indicador de trabalho. Três traços pelo centro, a 60°. */
  spark: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 2.4v11.2"/><path d="M3.2 5.2l9.6 5.6"/><path d="M3.2 10.8l9.6-5.6"/></svg>`,
} as const;

/**
 * Ícones dos menus, entregues como `<template>` no HTML. O cliente clona o nó
 * em vez de montar markup: nada de `innerHTML` no código da webview.
 */
const MENU_ICONS: Readonly<Record<string, string>> = {
  // Work modes
  plan: `<path d="M4.4 2.6h7.2a1 1 0 0 1 1 1v8.8a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1Z"/><path d="M5.8 6h4.4M5.8 8.4h4.4M5.8 10.8h2.6"/>`,
  edit: `<path d="M6.1 5 3.4 8l2.7 3"/><path d="M9.9 5 12.6 8l-2.7 3"/>`,
  'agent-team': `<circle cx="8" cy="3.6" r="1.7"/><circle cx="3.6" cy="11.6" r="1.7"/><circle cx="12.4" cy="11.6" r="1.7"/><path d="M6.9 5.1 4.7 10M9.1 5.1l2.2 4.9M5.3 11.6h5.4"/>`,
  // Autonomy
  manual: `<path d="M5.5 7.6V5.3a.9.9 0 0 1 1.8 0v2.1"/><path d="M7.3 7.1V3.5a.9.9 0 0 1 1.8 0v3.6"/><path d="M9.1 7.5V4.6a.9.9 0 0 1 1.8 0v4"/><path d="M5.5 7.6v2.2c0 2.1 1.4 3.6 3.3 3.6s2.9-1.3 3.1-3.4"/>`,
  auto: `<path d="M8.9 1.9 3.7 9h3.5l-.7 5 5.2-7.2H8.2Z"/>`,
  bypass: `<path d="M2.4 4.8h2.8l5.6 6.4h2.8"/><path d="M2.4 11.2h2.8l1.9-2.2"/><path d="M11.6 3.4 13.6 4.8l-2 1.4"/><path d="M11.6 9.8l2 1.4-2 1.4"/>`,
  // Agentes
  agent: `<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2.2"/><path d="M6.6 1.7v1.7M9.4 1.7v1.7M6.6 12.6v1.7M9.4 12.6v1.7M1.7 6.6h1.7M1.7 9.4h1.7M12.6 6.6h1.7M12.6 9.4h1.7"/>`,
  check: `<path d="M3.4 8.4 6.5 11.4 12.6 4.9"/>`,
  // Seções do modal de configuração e campos dos formulários
  person: `<circle cx="8" cy="5.4" r="2.7"/><path d="M2.9 13.4a5.1 5.1 0 0 1 10.2 0"/>`,
  folder: `<path d="M2.2 4.4a1 1 0 0 1 1-1h2.9l1.4 1.6h5.3a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z"/>`,
  plug: `<path d="M6.1 1.9v3.2M9.9 1.9v3.2"/><path d="M4.3 5.1h7.4v2.3a3.7 3.7 0 0 1-7.4 0Z"/><path d="M8 11.1v3"/>`,
  magnifier: `<circle cx="7.2" cy="7.2" r="4.3"/><path d="M10.4 10.4 13.4 13.4"/>`,
  beaker: `<path d="M6.3 2.2v4L3.1 11.6a1 1 0 0 0 .9 1.6h8a1 1 0 0 0 .9-1.6L9.7 6.2v-4"/><path d="M5.4 2.2h5.2"/><path d="M4.6 9.5h6.8"/>`,
  sliders: `<path d="M3 4.6h10M3 8h10M3 11.4h10"/><circle cx="6" cy="4.6" r="1.4"/><circle cx="10" cy="8" r="1.4"/><circle cx="5.2" cy="11.4" r="1.4"/>`,
  box: `<path d="M8 2.2 13.4 5v6L8 13.8 2.6 11V5Z"/><path d="M2.6 5 8 7.8 13.4 5M8 7.8v6"/>`,
  cloud: `<path d="M4.7 12.1a2.9 2.9 0 0 1-.3-5.8 3.7 3.7 0 0 1 7.1-.7 2.9 2.9 0 0 1 .2 5.7 2.9 2.9 0 0 1-.4 0Z"/>`,
  chevron: `<path d="M4.6 6.4 8 9.8l3.4-3.4"/>`,
  // Marcador dos blocos de ferramenta; gira ao expandir.
  chevronRight: `<path d="M6.2 3.8 10.6 8l-4.4 4.2"/>`,
};

function iconTemplates(): string {
  return Object.entries(MENU_ICONS)
    .map(
      ([name, body]) =>
        `<svg data-icon="${name}" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`,
    )
    .join('\n      ');
}

/**
 * HTML da view. Nenhum dado dinâmico é interpolado aqui além das URIs de
 * recursos e do nonce — todo conteúdo de mensagem é inserido pelo cliente com
 * `textContent`, nunca como HTML.
 */
export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  // Dicionário do idioma ativo, indexado pelo texto em inglês. Vai como JSON
  // inerte: a webview lê o conteúdo, e nada aqui é executado como script.
  const strings = escapeJson(JSON.stringify(webviewStrings()));
  const asset = (...segments: string[]): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));

  const scriptUri = asset('dist', 'webview', 'main.js');
  const styleUri = asset('dist', 'webview', 'styles.css');
  const logoUri = asset('media', 'prometheon-view.svg');
  // Animação usada só enquanto há trabalho em andamento.
  const activityUri = asset('media', 'prometheon-icon-orbit-fire.gif');

  // `data:` em img-src é o que permite exibir as imagens anexadas sem gravá-las
  // em disco; nenhuma outra origem é liberada.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  // Texto do HTML já traduzido. Em atributo, aspas viram entidade: tradução é
  // conteúdo, não markup.
  const label = (text: string): string => t(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="${activeLanguage()}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri.toString()}" rel="stylesheet" />
  <title>Prometheon</title>
</head>
<body>
  <div class="app">
    <header class="header">
      <img class="logo" src="${logoUri.toString()}" alt="" width="18" height="18" />
      <span class="session-title" id="session-title">${t('Untitled')}</span>
      <span class="grow"></span>
      <span class="hub-badge" id="hub-badge" title="Prometheon Hub status"></span>
      <button class="icon-button" type="button" id="open-settings-modal" title="${label('Accounts and usage')}" aria-label="${label('Accounts and usage')}" aria-haspopup="dialog" aria-expanded="false">${ICONS.account}</button>
      <button class="icon-button" type="button" id="toggle-sessions" title="${label('Sessions')}" aria-label="${label('Sessions')}" aria-haspopup="dialog" aria-expanded="false">${ICONS.history}</button>
      <button class="icon-button" type="button" id="new-session" title="${label('New chat')}" aria-label="${label('New chat')}">${ICONS.plus}</button>
      <button class="icon-button" type="button" id="open-settings" title="${label('Open settings')}" aria-label="${label('Open settings')}">${ICONS.gear}</button>
    </header>

    <div class="popover" id="sessions-popover" role="dialog" aria-label="${label('Sessions')}" hidden>
      <div class="segmented" role="tablist" aria-label="Chat type">
        <button class="segment" role="tab" type="button" data-chat-type="local">${ICONS.local}<span>${t('Local')}</span></button>
        <button class="segment" role="tab" type="button" data-chat-type="web">${ICONS.web}<span>${t('Web')}</span></button>
      </div>
      <div class="search">
        ${ICONS.search}
        <input id="session-search" type="text" placeholder="${label('Search sessions…')}" aria-label="${label('Search sessions…')}" autocomplete="off" spellcheck="false" />
      </div>
      <ul class="session-list" id="session-list" role="listbox" aria-label="${label('Sessions')}"></ul>
      <p class="session-empty" id="session-empty" hidden>${t('No sessions yet.')}</p>
    </div>

    <div class="banner" id="bypass-banner" hidden></div>

    <section class="panel" id="setup-panel" hidden>
      <h2>${t('Set up Prometheon for this workspace')}</h2>
      <p id="setup-description"></p>
      <div class="panel-actions">
        <button class="primary" type="button" data-setup="current">${t('Initialize in current workspace')}</button>
        <button type="button" data-setup="external">${t('Choose Prometheon workspace folder')}</button>
        <button class="link" type="button" data-setup="skip">${t('Continue without shared workspace')}</button>
      </div>
    </section>

    <section class="panel" id="web-panel" hidden>
      <h2>${t('Web Chat')}</h2>
      <p>${t('Web Chat keeps conversations and approved context synchronized through Prometheon Hub. Connect a Hub to continue.')}</p>
      <div class="panel-actions">
        <button class="primary" type="button" id="connect-hub">${t('Connect to Prometheon Hub')}</button>
      </div>
    </section>

    <div class="working" id="working" role="status" hidden>
      <span class="working-glyph">${ICONS.spark}</span>
      <span class="working-word" id="working-word"></span>
      <span class="working-elapsed" id="working-elapsed"></span>
    </div>

    <main class="messages" id="messages" aria-live="polite" aria-busy="false"></main>

    <div class="empty-state" id="empty-state" hidden>
      <p>${t('No messages yet. Ask something to see the mesh respond.')}</p>
    </div>

    <details class="agents" id="agents-section">
      <summary>${t('Active Agents')} <span class="count" id="agents-count">0</span></summary>
      <ul class="agents-list" id="agents-list"></ul>
    </details>

    <footer class="composer">
      <div class="activity" id="activity" hidden>
        <img class="activity-icon" src="${activityUri.toString()}" alt="" width="20" height="20" />
        <span class="activity-label" id="activity-label"></span>
        <span class="activity-detail" id="activity-detail"></span>
        <span class="activity-elapsed" id="activity-elapsed"></span>
      </div>

      <div class="composer-card" id="composer-card">
        <div class="attachments" id="attachments" hidden></div>
        <textarea
          id="composer-input"
          rows="1"
          placeholder="${label('Ask Prometheon…  (Enter to send · paste to attach an image)')}"
          aria-label="Message"
        ></textarea>
        <div class="composer-bar">
          <button class="icon-button" type="button" id="attach-image" title="${label('Attach image')}" aria-label="${label('Attach image')}">${ICONS.attach}</button>

          <div class="menu-anchor">
            <button class="pill" type="button" id="work-mode-button" aria-haspopup="menu" aria-expanded="false">
              <span class="pill-icon" data-slot="icon"></span><span data-slot="label"></span>
            </button>
            <div class="menu" id="work-mode-menu" role="menu" aria-label="${label('Work mode')}" hidden>
              <div class="menu-title">${t('Work mode')}</div>
              <div class="menu-items" data-slot="items"></div>
            </div>
          </div>

          <div class="menu-anchor">
            <button class="pill" type="button" id="autonomy-button" aria-haspopup="menu" aria-expanded="false">
              <span class="pill-icon" data-slot="icon"></span><span data-slot="label"></span>
            </button>
            <div class="menu" id="autonomy-menu" role="menu" aria-label="${label('Autonomy')}" hidden>
              <div class="menu-title">${t('Autonomy')}</div>
              <div class="menu-items" data-slot="items"></div>
            </div>
          </div>

          <div class="menu-anchor">
            <button class="pill" type="button" id="main-agent-button" aria-haspopup="menu" aria-expanded="false">
              <span class="pill-icon" data-slot="icon"></span><span data-slot="label"></span>
            </button>
            <div class="menu" id="main-agent-menu" role="menu" aria-label="${label('Main agent')}" hidden>
              <div class="menu-title">${t('Main agent')}</div>
              <div class="menu-items" data-slot="items"></div>
            </div>
          </div>

          <span class="grow"></span>
          <button class="ghost" type="button" id="clear-chat" title="${label('Clear this local conversation')}">${t('Clear')}</button>
          <button class="ghost danger" type="button" id="stop-run" hidden>${t('Stop')}</button>
          <button class="icon-button mic" type="button" id="dictate" aria-label="${label('Dictate — tap or hold Ctrl+D to record')}" aria-pressed="false">${ICONS.mic}</button>
          <button class="send" type="button" id="send-message" title="${label('Send')}" aria-label="${label('Send')}">${ICONS.send}</button>
        </div>
      </div>
    </footer>
  </div>

  <!-- Modal único de configuração: contas, agentes, workspace e MCP. O conteúdo
       de cada seção é montado pelo cliente com createElement/textContent. -->
  <div class="modal" id="settings-modal" role="dialog" aria-modal="true" aria-label="${label('Settings')}" hidden>
    <div class="modal-card settings-card">
      <header class="modal-header">
        <h2 id="settings-title">${t('Settings')}</h2>
        <button class="icon-button" type="button" id="close-settings" title="${label('Close')}" aria-label="${label('Close')}">${ICONS.close}</button>
      </header>
      <div class="settings-layout">
        <nav class="settings-nav" id="settings-nav" role="tablist" aria-label="${label('Settings')}"></nav>
        <div class="settings-pane" id="settings-pane" role="tabpanel" tabindex="-1"></div>
      </div>
    </div>
  </div>

  <!-- Pergunta do agente. Fica aberto enquanto o run espera a resposta; abas,
       enunciado e opções são montados pelo cliente com createElement. -->
  <div class="modal question-modal" id="question-modal" role="dialog" aria-modal="true" aria-label="${label('Question from the agent')}" hidden>
    <div class="modal-card question-card">
      <header class="modal-header question-header">
        <nav class="question-tabs" id="question-tabs" role="tablist" aria-label="${label('Question from the agent')}"></nav>
        <button class="icon-button" type="button" id="close-question" title="${label('Close')}" aria-label="${label('Close')}">${ICONS.close}</button>
      </header>
      <div class="question-body" id="question-body" role="tabpanel" tabindex="-1"></div>
      <footer class="question-footer">
        <button class="primary" type="button" id="submit-answers">${t('Submit answers')}</button>
        <span class="question-hint">${t('Esc to cancel')}</span>
      </footer>
    </div>
  </div>

  <script type="application/json" id="webview-strings">${strings}</script>

  <template id="icon-templates">
      ${iconTemplates()}
  </template>

  <div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="${label('Image preview')}" hidden>
    <button class="lightbox-close" type="button" id="lightbox-close" title="${label('Close')}" aria-label="${label('Close')}">${ICONS.close}</button>
    <img id="lightbox-image" alt="" />
    <span class="lightbox-caption" id="lightbox-caption"></span>
  </div>

  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
