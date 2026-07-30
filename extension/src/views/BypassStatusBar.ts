import * as vscode from 'vscode';
import { BYPASS_DURATION_LABELS, BYPASS_SCOPE_LABELS, type BypassGrant } from '../core/types';

/**
 * Indicador persistente de que o Bypass está ativo. Fica na barra de status para
 * continuar visível mesmo com o painel do Prometheon fechado.
 */
export class BypassStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      'prometheon.bypass',
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.item.name = 'Prometheon Bypass';
    this.item.command = 'prometheon.disableBypassPermissions';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  render(grant: BypassGrant | null): void {
    if (grant === null) {
      this.item.hide();
      return;
    }
    this.item.text = '$(unlock) Prometheon: Bypass';
    this.item.tooltip = [
      'Bypass permissions is active.',
      `Scope: ${BYPASS_SCOPE_LABELS[grant.scope]}`,
      `Duration: ${BYPASS_DURATION_LABELS[grant.duration]}`,
      'It expires when the extension restarts. Click to disable now.',
    ].join('\n');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
