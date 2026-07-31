import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { GraphStatus } from '../core/types';
import type { Logger } from '../logger';
import { PrometheonError } from '../utils/errors';
import type { GraphifyConfig } from './types';
import type { WorkspaceService } from './WorkspaceService';

const run = promisify(execFile);

/** O painel pediu um rebuild sem que houvesse comando configurado. */
export class GraphCommandMissingError extends PrometheonError {
  constructor() {
    super(
      'Set the rebuild command first: each project has its own, and there is no safe default.',
      'graph.command-missing',
    );
  }
}

export class GraphWorkspaceRequiredError extends PrometheonError {
  constructor() {
    super('The project graph lives inside the open folder. Open a folder first.', 'graph.workspace-required');
  }
}

/** Nome do terminal reaproveitado entre rebuilds, para não acumular abas. */
const TERMINAL_NAME = 'Prometheon · graph';

/**
 * Estado do grafo de conhecimento do projeto e execução do rebuild.
 *
 * O grafo não pertence ao Prometheon: ele mora na raiz do projeto, é gerado por
 * uma ferramenta externa e vai para o Git junto do código. Aqui só se lê o que
 * há em disco e se dispara o comando que o time configurou — a extensão nunca
 * decide sozinha como reconstruir, porque o comando errado corrompe o corpus.
 */
export class GraphService {
  /** Resultado da sondagem do CLI. Detectar a cada render seria caro. */
  private cliDetected: boolean | null = null;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly logger: Logger,
  ) {}

  async status(config: GraphifyConfig): Promise<GraphStatus> {
    const folder = this.workspace.folder;
    const shared = {
      enabled: config.enabled,
      outputDir: config.outputDir,
      rebuildCommand: config.rebuildCommand,
      rebuildOn: config.rebuildOn,
      gate: config.gate,
      blockOnHygieneFailure: config.blockOnHygieneFailure,
      cliDetected: await this.hasCli(),
    };

    if (folder === undefined) {
      return {
        ...shared,
        available: false,
        exists: false,
        ageMs: null,
        message: 'The project graph lives inside the open folder. Open a folder to configure it.',
      };
    }

    const stat = await this.statGraph(folder.uri, config.outputDir);
    return {
      ...shared,
      available: true,
      exists: stat !== null,
      // `mtime` da pasta muda quando o rebuild reescreve os arquivos dentro
      // dela, que é exatamente o evento que interessa datar aqui.
      ageMs: stat === null ? null : Math.max(0, Date.now() - stat.mtime),
    };
  }

  /**
   * Roda o rebuild num terminal do editor.
   *
   * Terminal, e não processo em segundo plano: o rebuild demora, escreve muito,
   * e às vezes falha no check de higiene — esconder isso atrás de uma barrinha
   * transformaria um erro que precisa ser lido num aviso que ninguém lê.
   */
  async rebuild(config: GraphifyConfig): Promise<void> {
    const folder = this.workspace.folder;
    if (folder === undefined) {
      throw new GraphWorkspaceRequiredError();
    }
    if (config.rebuildCommand.trim() === '') {
      throw new GraphCommandMissingError();
    }

    const existing = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME);
    const terminal = existing ?? vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: folder.uri });
    terminal.show(true);
    terminal.sendText(config.rebuildCommand);
    this.logger.info(`Rebuild do grafo disparado: ${config.rebuildCommand}`);
  }

  /** Esquece a sondagem do CLI, para o próximo status detectar de novo. */
  invalidate(): void {
    this.cliDetected = null;
  }

  private async statGraph(
    root: vscode.Uri,
    outputDir: string,
  ): Promise<{ readonly mtime: number } | null> {
    // Um caminho relativo que suba de pasta apontaria para fora do projeto, e
    // o status passaria a falar de um diretório que não é deste repositório.
    const relative = outputDir.trim();
    if (relative === '' || relative.startsWith('..') || relative.includes(':')) {
      return null;
    }
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, ...relative.split(/[\\/]+/)));
      return { mtime: stat.mtime };
    } catch {
      return null;
    }
  }

  private async hasCli(): Promise<boolean> {
    if (this.cliDetected !== null) {
      return this.cliDetected;
    }
    try {
      await run('graphify', ['--version'], { timeout: 5_000, windowsHide: true });
      this.cliDetected = true;
    } catch {
      this.cliDetected = false;
    }
    return this.cliDetected;
  }
}
