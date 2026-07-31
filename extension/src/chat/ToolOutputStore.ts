import * as vscode from 'vscode';
import type { Logger } from '../logger';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Esquema das abas de saída. Read-only por construção: nada aqui é gravável. */
export const TOOL_OUTPUT_SCHEME = 'prometheon-output';

/**
 * Teto por arquivo. Um comando pode despejar centenas de megabytes; guardar
 * tudo encheria o disco do usuário por causa de um `find /` mal pensado.
 */
export const MAX_FULL_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Arquivos mais velhos que isto são apagados na abertura da extensão. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DIRECTORY = 'tool-output';

/**
 * Saída integral das ferramentas, em disco.
 *
 * O histórico da conversa mora no `workspaceState` e guarda no máximo alguns
 * quilobytes por passo — o suficiente para ler no chat, longe do bastante para
 * um `npm test` inteiro. A cópia integral fica aqui, fora do projeto do usuário
 * e fora do Git, e é o que a aba do editor abre.
 */
export class ToolOutputStore {
  private readonly root: vscode.Uri | null;

  constructor(
    storageUri: vscode.Uri | undefined,
    private readonly logger: Logger,
  ) {
    // Sem `storageUri` não há pasta da extensão para este workspace. Acontece
    // quando nenhuma pasta está aberta: o chat continua funcionando, só não há
    // onde guardar a cópia integral.
    this.root = storageUri === undefined ? null : vscode.Uri.joinPath(storageUri, DIRECTORY);
  }

  /**
   * Guarda a saída inteira de um passo. Retorna `true` quando gravou — é o que
   * autoriza a interface a oferecer o botão de abrir.
   */
  async save(stepId: string, output: string): Promise<boolean> {
    const uri = this.uriFor(stepId);
    if (uri === null) {
      return false;
    }

    const bytes = encoder.encode(
      output.length > MAX_FULL_OUTPUT_BYTES
        ? `${output.slice(0, MAX_FULL_OUTPUT_BYTES)}\n\n[Prometheon] Output cut at ${
            MAX_FULL_OUTPUT_BYTES / (1024 * 1024)
          } MB.\n`
        : output,
    );

    try {
      await vscode.workspace.fs.createDirectory(uri.with({ path: dirname(uri.path) }));
      await vscode.workspace.fs.writeFile(uri, bytes);
      return true;
    } catch (error) {
      // Falhar aqui não pode derrubar o run: a saída curta já está no histórico.
      this.logger.warn(`Não foi possível guardar a saída de ${stepId}. ${String(error)}`);
      return false;
    }
  }

  async read(stepId: string): Promise<string | null> {
    const uri = this.uriFor(stepId);
    if (uri === null) {
      return null;
    }
    try {
      return decoder.decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return null;
    }
  }

  /** Apaga o que passou da retenção. Chamado na ativação, sem bloquear nada. */
  async prune(): Promise<void> {
    if (this.root === null) {
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.root);
    } catch {
      return;
    }

    const cutoff = Date.now() - RETENTION_MS;
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) {
        continue;
      }
      const uri = vscode.Uri.joinPath(this.root, name);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.mtime < cutoff) {
          await vscode.workspace.fs.delete(uri);
        }
      } catch {
        // Some entre o stat e o delete: nada a fazer, era o que queríamos.
      }
    }
  }

  /**
   * URI que a aba do editor abre. O esquema é nosso e o provider é read-only:
   * ninguém edita por engano a saída de um comando que já aconteceu.
   */
  documentUri(stepId: string, label: string): vscode.Uri | null {
    if (this.uriFor(stepId) === null) {
      return null;
    }
    return vscode.Uri.from({
      scheme: TOOL_OUTPUT_SCHEME,
      // O caminho é só o rótulo bonito da aba; quem identifica é a query.
      path: `/${safeName(label === '' ? 'output' : label)}.log`,
      query: stepId,
    });
  }

  private uriFor(stepId: string): vscode.Uri | null {
    const name = safeName(stepId);
    if (this.root === null || name === '') {
      return null;
    }
    return vscode.Uri.joinPath(this.root, `${name}.log`);
  }
}

/** Só o que é seguro como nome de arquivo; o resto vira `-`. */
function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

/**
 * Conteúdo das abas de saída.
 *
 * Não implementa escrita, então o editor abre o documento como somente leitura
 * sem que seja preciso pedir: a garantia vem do esquema, não de um flag que
 * alguém pode esquecer de passar.
 */
export class ToolOutputContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: ToolOutputStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const content = await this.store.read(uri.query);
    return content ?? '[Prometheon] This output is no longer available.';
  }
}
