import * as vscode from 'vscode';
import { EXTENSION_ID } from '../constants';
import type { PrometheonCore } from '../core/PrometheonCore';
import type { Logger } from '../logger';
import type { PrometheonViewProvider } from '../views/PrometheonViewProvider';
import type { SecretKey, SecretStore } from '../storage/SecretStore';
import type { LocalStateStore } from '../storage/LocalStateStore';
import type { ProviderProfileService } from '../providers/ProviderProfileService';
import type { AgentProfileService } from '../agents/AgentProfileService';
import { t } from '../i18n';

export interface CommandDeps {
  readonly core: PrometheonCore;
  readonly provider: PrometheonViewProvider;
  readonly logger: Logger;
  /** Só o reset precisa destes: ele é o único comando que apaga em vez de mudar. */
  readonly secrets: SecretStore;
  readonly local: LocalStateStore;
  readonly profiles: ProviderProfileService;
  readonly agentProfiles: AgentProfileService;
}

/** Chaves de segredo que o reset apaga. Uma nova aqui, uma nova lá. */
const SECRET_KEYS: readonly SecretKey[] = ['hub.token', 'hub.refreshToken'];

/** Registra os comandos da Command Palette. Toda a lógica vive no núcleo. */
export function registerCommands({
  core,
  provider,
  logger,
  secrets,
  local,
  profiles,
  agentProfiles,
}: CommandDeps): vscode.Disposable[] {
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

    // Criar conta e configurar tudo o mais acontece dentro do painel: estes
    // comandos só revelam a view e abrem o modal na seção certa.
    register('prometheon.addAccount', async () => {
      await core.refreshAccounts();
      await provider.reveal();
      provider.post({ type: 'settings.open', payload: { section: 'accounts', focus: 'new' } });
    }),

    register('prometheon.openConfiguration', async () => {
      await core.refreshAccounts();
      await provider.reveal();
      provider.post({ type: 'settings.open', payload: { section: 'accounts' } });
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

    /**
     * Devolve a extensão ao estado de recém-instalada.
     *
     * A confirmação é modal e lista o que sai, porque não há como desfazer:
     * conversas locais não vão para lugar nenhum além do `workspaceState`.
     *
     * As credenciais dos CLIs são uma **segunda** pergunta, e não parte da
     * primeira. Elas não pertencem ao Prometheon — quem as escreveu foi o
     * `claude auth login`, dentro do diretório isolado do perfil. Apagá-las
     * junto obrigaria a refazer um login que talvez estivesse ótimo, e o
     * usuário só descobriria isso na próxima vez que tentasse trabalhar.
     */
    register('prometheon.resetLocalState', async () => {
      const confirmation = await vscode.window.showWarningMessage(
        t('Reset Prometheon to a clean state?'),
        {
          modal: true,
          detail: t(
            'This deletes local conversations, provider and agent profiles, workspace preferences and the Hub credentials stored on this machine. It cannot be undone.',
          ),
        },
        t('Reset'),
      );

      if (confirmation !== t('Reset')) {
        return;
      }

      const profiles_ = await profiles.list();
      const directories = profiles_.map((profile) => profile.configDirectory);

      let alsoCredentials = false;

      if (directories.length > 0) {
        const answer = await vscode.window.showWarningMessage(
          t('Also delete the CLI sign-ins?'),
          {
            modal: true,
            detail: t(
              'Each profile keeps its own CLI credentials in an isolated folder. Deleting them means signing in again in every provider. Keeping them is safe: without the profiles, Prometheon no longer points to those folders.',
            ),
          },
          t('Delete sign-ins'),
          t('Keep them'),
        );

        // Fechar a caixa não é o mesmo que escolher: só o botão explícito apaga.
        alsoCredentials = answer === t('Delete sign-ins');
      }

      for (const profile of profiles_) {
        await profiles.remove(profile.id);
      }

      for (const profile of await agentProfiles.list()) {
        await agentProfiles.remove(profile.id);
      }

      if (alsoCredentials) {
        for (const directory of directories) {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(directory), {
              recursive: true,
              useTrash: false,
            });
          } catch (error) {
            // Diretório já ausente é o resultado desejado, não um problema.
            logger.debug(`Diretório de credenciais não removido (${directory}): ${String(error)}`);
          }
        }
      }

      for (const key of SECRET_KEYS) {
        await secrets.delete(key);
      }

      await local.clearAll();

      logger.info(
        `Estado local apagado (credenciais dos CLIs ${alsoCredentials ? 'incluídas' : 'preservadas'}).`,
      );

      // A janela recarrega porque o estado já foi lido na ativação: sem isso a
      // interface continuaria mostrando o que acabou de ser apagado, e a
      // primeira escrita gravaria tudo de volta.
      const reload = await vscode.window.showInformationMessage(
        t('Prometheon was reset. Reload the window to finish.'),
        t('Reload window'),
      );

      if (reload === t('Reload window')) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),
  ];
}
