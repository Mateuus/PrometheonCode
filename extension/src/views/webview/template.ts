import * as vscode from 'vscode';

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
 * HTML da view. Nenhum dado dinâmico é interpolado aqui além das URIs de
 * recursos e do nonce — todo conteúdo de mensagem é inserido pelo cliente com
 * `textContent`, nunca como HTML.
 */
export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const asset = (...segments: string[]): vscode.Uri =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));

  const scriptUri = asset('dist', 'webview', 'main.js');
  const styleUri = asset('dist', 'webview', 'styles.css');
  const logoUri = asset('media', 'prometheon-view.svg');

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
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
      <img class="logo" src="${logoUri.toString()}" alt="" width="16" height="16" />
      <span class="brand">Prometheon</span>
      <div class="tabs" role="tablist" aria-label="Chat type">
        <button class="tab" role="tab" type="button" data-chat-type="local">Local Chat</button>
        <button class="tab" role="tab" type="button" data-chat-type="web">Web Chat</button>
      </div>
      <span class="grow"></span>
      <span class="hub-badge" id="hub-badge" title="Prometheon Hub status"></span>
      <button class="icon-button" type="button" id="open-settings" title="Open settings" aria-label="Open settings">&#9881;</button>
    </header>

    <div class="banner" id="bypass-banner" hidden></div>

    <section class="panel" id="setup-panel" hidden>
      <h2>Set up Prometheon for this workspace</h2>
      <p id="setup-description"></p>
      <div class="panel-actions">
        <button class="primary" type="button" data-setup="current">Initialize in current workspace</button>
        <button type="button" data-setup="external">Choose Prometheon workspace folder</button>
        <button class="link" type="button" data-setup="skip">Continue without shared workspace</button>
      </div>
    </section>

    <section class="panel" id="web-panel" hidden>
      <h2>Web Chat</h2>
      <p>Web Chat keeps conversations and approved context synchronized through Prometheon Hub. Connect a Hub to continue.</p>
      <div class="panel-actions">
        <button class="primary" type="button" id="connect-hub">Connect to Prometheon Hub</button>
      </div>
    </section>

    <main class="messages" id="messages" aria-live="polite" aria-busy="false"></main>

    <div class="empty-state" id="empty-state" hidden>
      <p>No messages yet. Ask something to see the mesh respond.</p>
    </div>

    <details class="agents" id="agents-section">
      <summary>Active Agents <span class="count" id="agents-count">0</span></summary>
      <ul class="agents-list" id="agents-list"></ul>
    </details>

    <footer class="composer">
      <div class="thinking" id="thinking" hidden>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="thinking-label">Working…</span>
      </div>
      <textarea
        id="composer-input"
        rows="1"
        placeholder="Ask Prometheon…  (Enter to send, Shift+Enter for a new line)"
        aria-label="Message"
      ></textarea>
      <div class="composer-bar">
        <label class="field">
          <span class="field-label">Mode</span>
          <select id="work-mode" aria-label="Work mode"></select>
        </label>
        <label class="field">
          <span class="field-label">Autonomy</span>
          <select id="autonomy" aria-label="Autonomy"></select>
        </label>
        <label class="field">
          <span class="field-label">Main</span>
          <select id="main-agent" aria-label="Main agent"></select>
        </label>
        <span class="grow"></span>
        <button type="button" id="clear-chat" title="Clear this local conversation">Clear</button>
        <button type="button" id="stop-run" class="danger" hidden>Stop</button>
        <button type="button" id="send-message" class="primary">Send</button>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
