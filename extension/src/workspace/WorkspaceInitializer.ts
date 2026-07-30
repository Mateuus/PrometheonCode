import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import type { PermissionService } from '../permissions/PermissionService';
import type { SettingsStore } from '../storage/SettingsStore';
import { sanitizeUnknown } from '../utils/sanitize';
import {
  PROMETHEON_DIR,
  CONFIG_FILE_NAME,
  DIRECTORIES_NEEDING_GITKEEP,
  GITIGNORE_ENTRIES,
  GITIGNORE_HEADER,
  HOME_MARKDOWN,
  WORKSPACE_DIRECTORIES,
} from './types';

const execFileAsync = promisify(execFile);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type GitOutcome = 'already-present' | 'initialized' | 'declined' | 'unavailable' | 'failed';

export type InitializeOutcome =
  | {
      readonly kind: 'done';
      readonly createdConfig: boolean;
      readonly gitignoreAdded: readonly string[];
      readonly git: GitOutcome;
    }
  /** Usuário escolheu "Cancel setup" no diálogo do Git. */
  | { readonly kind: 'cancelled' }
  /** Escrita negada pelas políticas de permissão. */
  | { readonly kind: 'denied'; readonly reason: string }
  | { readonly kind: 'no-folder' };

/**
 * Junta as entradas do Prometheon ao `.gitignore` existente.
 *
 * Função pura para poder ser testada sem tocar no disco. Nunca remove nem
 * reordena linhas do usuário: só acrescenta o que falta, sob um cabeçalho.
 */
export function mergeGitignore(
  existing: string,
  entries: readonly string[] = GITIGNORE_ENTRIES,
): { content: string; added: string[] } {
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  const added = entries.filter((entry) => !present.has(entry));

  if (added.length === 0) {
    return { content: existing, added };
  }
  if (existing.trim() === '') {
    return { content: [GITIGNORE_HEADER, ...added, ''].join('\n'), added };
  }

  const separator = existing.endsWith('\n') ? '' : '\n';
  const header = present.has(GITIGNORE_HEADER) ? [] : [GITIGNORE_HEADER];
  return { content: `${existing}${separator}\n${[...header, ...added, ''].join('\n')}`, added };
}

export class WorkspaceInitializer {
  constructor(
    private readonly settings: SettingsStore,
    private readonly permissions: PermissionService,
    private readonly logger: Logger,
  ) {}

  /**
   * Cria `.prometheon/` na pasta aberta. Pergunta sobre o Git antes de escrever
   * qualquer arquivo, para que "Cancel setup" realmente não deixe rastro.
   */
  async initializeCurrentWorkspace(): Promise<InitializeOutcome> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      return { kind: 'no-folder' };
    }

    const prometheonDir = vscode.Uri.joinPath(folder.uri, PROMETHEON_DIR);
    const write = this.permissions.evaluate({
      action: 'file.write',
      target: prometheonDir.fsPath,
    });
    if (write.decision === 'deny') {
      return { kind: 'denied', reason: write.reason };
    }
    if (write.decision === 'ask') {
      const approved = await this.permissions.requestApproval(
        { action: 'file.write', target: prometheonDir.fsPath },
        `Create the Prometheon workspace in ${folder.name}?`,
      );
      if (!approved) {
        return { kind: 'cancelled' };
      }
    }

    const git = await this.ensureGit(folder);
    if (git === 'cancel-setup') {
      return { kind: 'cancelled' };
    }

    await vscode.workspace.fs.createDirectory(prometheonDir);
    for (const relative of WORKSPACE_DIRECTORIES) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(prometheonDir, ...relative.split('/')));
    }
    for (const relative of DIRECTORIES_NEEDING_GITKEEP) {
      await this.writeIfMissing(
        vscode.Uri.joinPath(prometheonDir, ...relative.split('/'), '.gitkeep'),
        '',
      );
    }
    await this.writeIfMissing(
      vscode.Uri.joinPath(prometheonDir, 'knowledge', 'Home.md'),
      HOME_MARKDOWN,
    );

    const createdConfig = await this.settings.createIfMissing(
      vscode.Uri.joinPath(prometheonDir, CONFIG_FILE_NAME),
      folder.name,
    );
    const gitignoreAdded = await this.updateGitignore(folder);

    this.logger.info(
      `Workspace Prometheon preparado em ${folder.name} (config ${createdConfig ? 'criada' : 'preservada'}, git: ${git}).`,
    );
    return { kind: 'done', createdConfig, gitignoreAdded, git };
  }

  /** Acrescenta as entradas do Prometheon ao `.gitignore`, preservando o conteúdo. */
  async updateGitignore(folder: vscode.WorkspaceFolder): Promise<string[]> {
    const uri = vscode.Uri.joinPath(folder.uri, '.gitignore');
    let existing = '';
    try {
      existing = decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      existing = '';
    }

    const { content, added } = mergeGitignore(existing);
    if (added.length > 0) {
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    }
    return added;
  }

  /**
   * Garante o repositório Git, se o usuário quiser. Nunca roda `git init` sem
   * confirmação explícita.
   */
  private async ensureGit(
    folder: vscode.WorkspaceFolder,
  ): Promise<GitOutcome | 'cancel-setup'> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.git'));
      return 'already-present';
    } catch {
      // Sem repositório: segue para a pergunta.
    }

    if (folder.uri.scheme !== 'file') {
      return 'unavailable';
    }

    const initialize = 'Initialize Git';
    const notNow = 'Not now';
    const cancel = 'Cancel setup';
    const choice = await vscode.window.showInformationMessage(
      'This folder is not a Git repository. Initialize Git to version Prometheon configuration and shared knowledge?',
      { modal: true },
      initialize,
      notNow,
      cancel,
    );

    if (choice === cancel || choice === undefined) {
      return 'cancel-setup';
    }
    if (choice === notNow) {
      return 'declined';
    }

    const approved = await this.permissions.requestApproval(
      { action: 'git.init', target: folder.uri.fsPath },
      `Run "git init" in ${folder.name}?`,
    );
    if (!approved) {
      return 'declined';
    }

    try {
      await execFileAsync('git', ['init'], { cwd: folder.uri.fsPath });
      this.logger.info(`Repositório Git inicializado em ${folder.name}.`);
      return 'initialized';
    } catch (error) {
      this.logger.error(`git init falhou: ${sanitizeUnknown(error)}`);
      void vscode.window.showErrorMessage('Could not initialize Git. See the Prometheon logs.');
      return 'failed';
    }
  }

  private async writeIfMissing(uri: vscode.Uri, content: string): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
    }
  }
}
