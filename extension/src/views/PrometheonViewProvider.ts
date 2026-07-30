import * as vscode from 'vscode';
import type { PrometheonCore } from '../core/PrometheonCore';
import type { Logger } from '../logger';
import { parseWebviewMessage, type ExtensionToWebviewMessage } from './messages';
import { renderWebviewHtml } from './webview/template';

/**
 * Ponte entre a webview e o núcleo. Não contém regra de negócio: valida a
 * mensagem recebida e delega. A webview nunca executa terminal, Git, CLI,
 * leitura de arquivo ou rede por conta própria.
 */
export class PrometheonViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'prometheon.chatView';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly core: PrometheonCore,
    private readonly logger: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri);

    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handle(raw);
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );
  }

  post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  async reveal(): Promise<void> {
    if (this.view === undefined) {
      await vscode.commands.executeCommand(`${PrometheonViewProvider.viewType}.focus`);
      return;
    }
    this.view.show(true);
  }

  private async handle(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (message === null) {
      // Descartar em silêncio para o usuário, mas registrar: mensagem inválida
      // aqui significa bug no cliente ou tentativa de burlar o contrato.
      const type =
        typeof raw === 'object' && raw !== null && 'type' in raw ? String(raw.type) : typeof raw;
      this.logger.warn(`Mensagem da webview descartada na validação (type=${type}).`);
      return;
    }
    await this.core.handleWebviewMessage(message);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
