import * as vscode from 'vscode';
import type { WorkspaceStatus } from '../core/types';
import type { LocalStateStore } from '../storage/LocalStateStore';
import type { SettingsStore } from '../storage/SettingsStore';
import { PROMETHEON_DIR, CONFIG_FILE_NAME, type WorkspaceConfig } from './types';

/**
 * Responde onde está o workspace do Prometheon e se ele já foi configurado.
 * Observa `.prometheon/prometheon.yaml` para refletir mudanças feitas fora da UI.
 */
export class WorkspaceService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  /** Dispara quando um `SKILL.md` ou o `roles.yaml` do projeto muda. */
  private readonly contentEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeContent = this.contentEmitter.event;

  constructor(
    private readonly settings: SettingsStore,
    private readonly local: LocalStateStore,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/${PROMETHEON_DIR}/${CONFIG_FILE_NAME}`,
    );
    const notify = (): void => this.changeEmitter.fire();
    this.disposables.push(
      watcher,
      watcher.onDidCreate(notify),
      watcher.onDidChange(notify),
      watcher.onDidDelete(notify),
      vscode.workspace.onDidChangeWorkspaceFolders(notify),
    );

    // Skills e papéis são arquivos que a pessoa edita no próprio editor. Sem
    // observá-los, salvar um `SKILL.md` só teria efeito depois de reiniciar a
    // extensão — e a skill pareceria não existir.
    const content = vscode.workspace.createFileSystemWatcher(
      `**/${PROMETHEON_DIR}/{skills/**/SKILL.md,agents/roles.yaml}`,
    );
    const notifyContent = (): void => this.contentEmitter.fire();
    this.disposables.push(
      content,
      content.onDidCreate(notifyContent),
      content.onDidChange(notifyContent),
      content.onDidDelete(notifyContent),
    );
  }

  get folder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  /** Identidade do workspace atual, usada para invalidar o bypass na troca. */
  get workspaceKey(): string | null {
    return this.folder?.uri.toString() ?? null;
  }

  get prometheonDir(): vscode.Uri | null {
    const folder = this.folder;
    return folder === undefined ? null : vscode.Uri.joinPath(folder.uri, PROMETHEON_DIR);
  }

  get configUri(): vscode.Uri | null {
    const dir = this.prometheonDir;
    return dir === null ? null : vscode.Uri.joinPath(dir, CONFIG_FILE_NAME);
  }

  async isConfigured(): Promise<boolean> {
    const configUri = this.configUri;
    return configUri !== null && (await this.settings.exists(configUri));
  }

  async hasGit(): Promise<boolean> {
    const folder = this.folder;
    if (folder === undefined) {
      return false;
    }
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async readConfig(): Promise<WorkspaceConfig | null> {
    const configUri = this.configUri;
    if (configUri === null || !(await this.settings.exists(configUri))) {
      return null;
    }
    return this.settings.read(configUri, this.folder?.name ?? 'Prometheon');
  }

  async status(): Promise<WorkspaceStatus> {
    return {
      configured: await this.isConfigured(),
      folderName: this.folder?.name ?? null,
      hasGit: await this.hasGit(),
      externalFolder: this.local.getExternalWorkspaceFolder(),
      skipped: this.local.isWorkspaceSetupSkipped(),
    };
  }

  notifyChanged(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
    this.contentEmitter.dispose();
  }
}
