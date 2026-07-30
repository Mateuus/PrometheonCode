import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import type { PrometheonCore } from '../core/PrometheonCore';
import type { Logger } from '../logger';
import type { PrometheonViewProvider } from '../views/PrometheonViewProvider';

export interface CommandDeps {
  readonly core: PrometheonCore;
  readonly provider: PrometheonViewProvider;
  readonly logger: Logger;
}

/** Registra os comandos da Command Palette. Toda a lógica vive no núcleo. */
export function registerCommands({ core, provider, logger }: CommandDeps): vscode.Disposable[] {
  const register = (
    command: string,
    handler: (...args: unknown[]) => Promise<void> | void,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (error) {
        logger.error(`Comando ${command} falhou: ${String(error)}`);
        void vscode.window.showErrorMessage(
          `Prometheon: the command failed. See the Prometheon output channel.`,
        );
      }
    });

  return [
    register('prometheon.openChat', () => provider.reveal()),

    register('prometheon.newLocalChat', async () => {
      await core.newLocalChat();
      await provider.reveal();
    }),

    register('prometheon.configureWorkspace', () => core.configureWorkspace()),
    register('prometheon.initializeWorkspace', () => core.initializeWorkspace()),
    register('prometheon.selectMainAgent', () => core.pickMainAgent()),
    register('prometheon.selectWorkMode', () => core.pickWorkMode()),
    register('prometheon.selectAutonomy', () => core.pickAutonomy()),

    register('prometheon.disableBypassPermissions', async () => {
      if (!core.isBypassActive) {
        void vscode.window.showInformationMessage('Prometheon: bypass is not active.');
        return;
      }
      await core.disableBypass();
    }),

    register('prometheon.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
    }),

    register('prometheon.showDiagnostics', async () => {
      const document = await vscode.workspace.openTextDocument({
        content: await core.buildDiagnostics(),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  ];
}
