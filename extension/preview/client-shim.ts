/**
 * Host de mentira para a webview rodar num navegador comum.
 *
 * Carrega antes do `main.js` e entrega o `acquireVsCodeApi` que ele espera.
 * O contrato imitado é o mínimo do handshake real: a UI manda `ui.ready`, o
 * host responde `state.snapshot` — aqui, com a fixture embutida no HTML. Todo
 * o resto é registrado no console, para quem estiver desenhando ver o que a
 * interface tentaria fazer.
 */

interface AnyMessage {
  readonly type: string;
  readonly payload?: unknown;
}

const state = (window as unknown as { __PROMETHEON_PREVIEW_STATE__: unknown })
  .__PROMETHEON_PREVIEW_STATE__;

function sendToWebview(message: AnyMessage): void {
  setTimeout(() => {
    window.postMessage(message, '*');
  }, 0);
}

(window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(message: AnyMessage): void {
    // eslint-disable-next-line no-console
    console.log('[preview] webview →', message);
    if (message.type === 'ui.ready') {
      sendToWebview({ type: 'state.snapshot', payload: state });
    }
  },
  getState(): unknown {
    return null;
  },
  setState(): void {
    /* o rascunho do preview não sobrevive ao reload, de propósito */
  },
});

// Recarrega quando o esbuild termina um rebuild — é o "tempo real" do preview.
const events = new EventSource('/__events');
events.addEventListener('message', (event) => {
  if (event.data === 'reload') {
    location.reload();
  }
});

// Atalhos de navegação: `?view=settings` abre o modal já na carga, e
// `&section=agents` (ou outra) escolhe a aba — a mesma mensagem que a
// extensão usa para abrir a configuração num lugar específico.
window.addEventListener('load', () => {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'settings') {
    const section = params.get('section');
    setTimeout(() => {
      sendToWebview({
        type: 'settings.open',
        payload: { section: section ?? 'general' },
      });
    }, 150);
  }
});
