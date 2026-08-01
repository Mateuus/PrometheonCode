import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { GitStatus } from '../core/types';
import type { Logger } from '../logger';
import { PrometheonError } from '../utils/errors';
import type { GitConfig, GraphifyConfig } from './types';
import type { WorkspaceService } from './WorkspaceService';

const run = promisify(execFile);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Pasta de hooks do projeto. É versionada: a política viaja com o repositório. */
export const HOOKS_DIR = '.githooks';

/**
 * Primeira linha de todo hook que escrevemos.
 *
 * Serve para distinguir o que é nosso do que é do time. Um hook sem esta marca
 * nunca é sobrescrito sem confirmação: alguém o escreveu à mão, e apagar isso
 * em silêncio seria destruir trabalho que a interface não mostra.
 */
const MARKER = '# prometheon:generated';

export class GitWorkspaceRequiredError extends PrometheonError {
  constructor() {
    super('Git hooks live inside the open folder. Open a folder first.', 'git.workspace-required');
  }
}

export class NotAGitRepositoryError extends PrometheonError {
  constructor() {
    super('This folder is not a Git repository, so there is nowhere to install hooks.', 'git.not-a-repository');
  }
}

/** Já existe um hook escrito à mão no caminho onde o nosso iria. */
export class HookConflictError extends PrometheonError {
  constructor(readonly hooks: readonly string[]) {
    super(
      `These hooks already exist and were not written by Prometheon: ${hooks.join(', ')}`,
      'git.hook-conflict',
    );
  }
}

export interface InstallHooksOptions {
  /** Substituir hooks que não têm a marca do Prometheon. */
  readonly overwrite?: boolean;
}

/**
 * Política de commit do projeto — e os hooks que a tornam verdade.
 *
 * A distinção importa: pedir no prompt que o agente não credite uma IA como
 * coautora reduz o ruído, mas não garante nada, porque depende do modelo
 * lembrar. O hook roda sempre, para qualquer commit, feito por qualquer
 * ferramenta. Política que precisa valer vira hook; o resto é instrução.
 */
export class GitPolicyService {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly logger: Logger,
  ) {}

  async status(config: GitConfig): Promise<GitStatus> {
    const shared = {
      coAuthoredBy: config.coAuthoredBy,
      commitStyle: config.commitStyle,
      commitLanguage: config.commitLanguage,
      scopes: config.scopes,
    };

    const folder = this.workspace.folder;
    if (folder === undefined || !(await this.workspace.hasGit())) {
      return {
        ...shared,
        available: false,
        hooksInstalled: false,
        hooksPath: null,
        message:
          folder === undefined
            ? 'Commit policy belongs to a project. Open a folder to configure it.'
            : 'This folder is not a Git repository yet, so hooks cannot be installed.',
      };
    }

    const hooksPath = await this.readHooksPath(folder.uri);
    return {
      ...shared,
      available: true,
      hooksInstalled: hooksPath !== null && normalizePath(hooksPath) === HOOKS_DIR,
      hooksPath,
    };
  }

  /**
   * Escreve os hooks e aponta o Git para eles.
   *
   * `core.hooksPath` é configuração local da máquina, não do repositório: cada
   * pessoa que clona precisa apontar o seu. Por isso os arquivos são versionados
   * mas a ativação é por máquina — e é o que este botão faz.
   */
  async installHooks(
    git: GitConfig,
    graph: GraphifyConfig,
    options: InstallHooksOptions = {},
  ): Promise<void> {
    const folder = this.workspace.folder;
    if (folder === undefined) {
      throw new GitWorkspaceRequiredError();
    }
    if (!(await this.workspace.hasGit())) {
      throw new NotAGitRepositoryError();
    }

    const dir = vscode.Uri.joinPath(folder.uri, HOOKS_DIR);
    const files = [
      { name: 'pre-commit', body: preCommitHook(graph) },
      { name: 'prepare-commit-msg', body: prepareCommitMsgHook(git) },
    ];

    if (options.overwrite !== true) {
      const foreign: string[] = [];
      for (const file of files) {
        if (await this.isForeignHook(vscode.Uri.joinPath(dir, file.name))) {
          foreign.push(file.name);
        }
      }
      if (foreign.length > 0) {
        throw new HookConflictError(foreign);
      }
    }

    await vscode.workspace.fs.createDirectory(dir);
    for (const file of files) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, file.name),
        encoder.encode(file.body),
      );
    }
    await run('git', ['config', 'core.hooksPath', HOOKS_DIR], {
      cwd: folder.uri.fsPath,
      windowsHide: true,
    });
    this.logger.info(`Hooks do Prometheon instalados em ${HOOKS_DIR}/.`);
  }

  /**
   * Desliga os hooks sem apagar os arquivos.
   *
   * Apagar seria pior: os hooks são versionados, então removê-los aqui viraria
   * uma mudança no repositório que outra pessoa teria de revisar — quando tudo
   * o que se pediu foi parar de rodá-los nesta máquina.
   */
  async uninstallHooks(): Promise<void> {
    const folder = this.workspace.folder;
    if (folder === undefined) {
      throw new GitWorkspaceRequiredError();
    }
    try {
      await run('git', ['config', '--unset', 'core.hooksPath'], {
        cwd: folder.uri.fsPath,
        windowsHide: true,
      });
    } catch (error) {
      // `--unset` sai com 5 quando a chave já não existe: nada a desfazer.
      this.logger.debug(`core.hooksPath já estava limpo. ${String(error)}`);
    }
    this.logger.info('Hooks do Prometheon desativados nesta máquina.');
  }

  private async readHooksPath(root: vscode.Uri): Promise<string | null> {
    try {
      const { stdout } = await run('git', ['config', '--get', 'core.hooksPath'], {
        cwd: root.fsPath,
        windowsHide: true,
      });
      const value = stdout.trim();
      return value === '' ? null : value;
    } catch {
      // Sem a chave, o `git config --get` sai com 1. Não é erro: é o padrão.
      return null;
    }
  }

  private async isForeignHook(uri: vscode.Uri): Promise<boolean> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return !decoder.decode(bytes).includes(MARKER);
    } catch {
      return false;
    }
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
}

/** Aspas simples de shell em volta de um valor arbitrário do usuário. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Hook de pre-commit: mantém o grafo em dia com o código que está sendo
 * commitado, e barra o commit quando o portão do projeto reprova.
 */
export function preCommitHook(graph: GraphifyConfig): string {
  const lines: string[] = [
    '#!/bin/sh',
    MARKER,
    '# Gerado pelo Prometheon a partir de .prometheon/prometheon.yaml.',
    '# Editar aqui funciona, mas a próxima instalação pelo painel sobrescreve:',
    '# mude no painel (Settings > Graph) para a alteração durar.',
    'set -e',
    '',
  ];

  if (graph.gate !== '') {
    lines.push(
      '# Portão do projeto. Só um comando decide se o commit pode seguir --',
      '# nunca a opinião de um agente sobre o próprio trabalho.',
      `if ! ${graph.gate}; then`,
      '  echo "Prometheon: o portão do projeto reprovou. Commit abortado." >&2',
      '  echo "Para commitar assim mesmo: git commit --no-verify" >&2',
      '  exit 1',
      'fi',
      '',
    );
  }

  if (graph.rebuildOn === 'commit' && graph.rebuildCommand !== '') {
    lines.push(
      '# Nada a fazer se o commit não toca código: doc, configuração e o próprio',
      '# grafo não mudam o corpus, e reconstruir ali só gastaria o tempo de quem',
      '# está commitando.',
      'CHANGED=$(git diff --cached --name-only --diff-filter=ACMR \\',
      `  | grep -v ${shellQuote(`^${normalizePath(graph.outputDir)}/`)} \\`,
      "  | grep -Ei '\\.(c|cc|cpp|h|hpp|inl|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|swift|ts|tsx|uproject|uplugin|vue)$' \\",
      '  || true)',
      '',
      'if [ -n "$CHANGED" ]; then',
      '  echo "Prometheon: reconstruindo o grafo (o código mudou)."',
      '  LOG=$(mktemp)',
      `  if ! ${graph.rebuildCommand} > "$LOG" 2>&1; then`,
      '    echo "Prometheon: o rebuild do grafo falhou. Commit abortado." >&2',
      '    tail -20 "$LOG" >&2',
      '    echo "Para commitar sem reconstruir: git commit --no-verify" >&2',
      '    exit 1',
      '  fi',
    );

    if (graph.blockOnHygieneFailure) {
      lines.push(
        '',
        '  # O check de higiene do projeto sozinho só imprime um aviso, e aviso',
        '  # ninguém lê. Aqui ele barra: um grafo com caminho de máquina ou com',
        '  # arquivo sensível dentro já vazou para repositório antes, e rastrear',
        '  # isso depois custa muito mais do que parar agora.',
        '  if grep -qiE "higiene falhou|hygiene check failed" "$LOG"; then',
        '    echo "Prometheon: o grafo falhou o check de higiene. Commit abortado." >&2',
        '    grep -iE "higiene|hygiene|AVISO|WARN" "$LOG" >&2 || true',
        '    exit 1',
        '  fi',
      );
    }

    lines.push(
      '',
      '  # O grafo recém-gerado entra no mesmo commit. Sem isto, o commit levaria',
      '  # o código novo com o grafo antigo -- a dessincronia que o hook evita.',
      '  # Se o diretório estiver no .gitignore, o add falharia e derrubaria o',
      '  # commit por um artefato que o time decidiu não versionar: aí o hook',
      '  # avisa e segue, em vez de abortar.',
      `  if ! git add ${shellQuote(normalizePath(graph.outputDir))} 2>/dev/null; then`,
      `    echo "Prometheon: ${normalizePath(graph.outputDir)} está no .gitignore; o grafo não entrou no commit." >&2`,
      '  fi',
      'fi',
      '',
    );
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}

/**
 * Hook de prepare-commit-msg: aplica a política de autoria.
 *
 * Roda antes de o editor abrir, sobre o arquivo da mensagem, para qualquer
 * commit — inclusive os feitos por uma ferramenta que nunca leu o prompt.
 */
export function prepareCommitMsgHook(git: GitConfig): string {
  const lines: string[] = [
    '#!/bin/sh',
    MARKER,
    '# Gerado pelo Prometheon a partir de .prometheon/prometheon.yaml.',
    '# Mude no painel (Settings > Git & Commits) para a alteração durar.',
    'set -e',
    '',
    'MSG_FILE="$1"',
    '[ -f "$MSG_FILE" ] || exit 0',
    '',
  ];

  if (!git.coAuthoredBy) {
    lines.push(
      '# Coautoria de IA está desligada neste projeto. O trailer é removido aqui,',
      '# e não pedido no prompt: prompt depende de o modelo lembrar; o hook roda',
      '# sempre, para todo commit, venha ele de onde vier.',
      'TMP=$(mktemp)',
      'grep -viE "^[[:space:]]*co-authored-by:.*(claude|anthropic|openai|chatgpt|gpt-|copilot|gemini|codex|cursor|devin|noreply@anthropic\\.com)" \\',
      '  "$MSG_FILE" > "$TMP" || true',
      '',
      '# Assinaturas de ferramenta no corpo da mensagem seguem a mesma regra.',
      'grep -viE "^[[:space:]]*(🤖[[:space:]]*)?(generated with|created by|co-created with)[[:space:]]*\\[?(claude|chatgpt|copilot|gemini|cursor)" \\',
      '  "$TMP" > "$MSG_FILE" || true',
      'rm -f "$TMP"',
      '',
    );
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}
