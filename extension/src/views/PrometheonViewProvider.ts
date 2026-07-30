import * as vscode from 'vscode';
import { CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID } from '../constants';
import type { PrometheonCore } from '../core/PrometheonCore';
import type { Logger } from '../logger';
import { parseWebviewMessage, type ExtensionToWebviewMessage } from './messages';
import { renderWebviewHtml } from './webview/template';

/**
 * Ponte entre a webview e o núcleo. Não contém regra de negócio: valida a
 * mensagem recebida e delega. A webview nunca executa terminal, Git, CLI,
 * leitura de arquivo ou rede por conta própria.
 *
 * O mesmo provider atende duas views — a da Activity Bar e a da Secondary Side
 * Bar — porque no VS Code uma view pertence a um único container. As duas podem
 * estar resolvidas ao mesmo tempo, então todo `post` vai para ambas e elas
 * refletem exatamente o mesmo estado.
 */
export class PrometheonViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = CHAT_VIEW_ID;
  static readonly secondaryViewType = CHAT_VIEW_SECONDARY_ID;

  private readonly views = new Set<vscode.WebviewView>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly core: PrometheonCore,
    private readonly logger: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.add(view);

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
        this.views.delete(view);
      }),
    );

    // Uma view recém-aberta precisa do estado atual; ela também pede via
    // `ui.ready`, mas isso evita um quadro vazio enquanto a mensagem chega.
    this.post({ type: 'state.snapshot', payload: this.core.snapshot });
  }

  post(message: ExtensionToWebviewMessage): void {
    for (const view of this.views) {
      void view.webview.postMessage(message);
    }
  }

  /** Foca a view visível; se nenhuma estiver aberta, revela a da Activity Bar. */
  async reveal(): Promise<void> {
    const visible = [...this.views].find((view) => view.visible) ?? [...this.views][0];
    if (visible === undefined) {
      await vscode.commands.executeCommand(`${PrometheonViewProvider.viewType}.focus`);
      return;
    }
    visible.show(true);
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
    this.views.clear();
  }
}
