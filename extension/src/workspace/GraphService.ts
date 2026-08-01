import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { GraphStatus } from '../core/types';
import { t } from '../i18n';
import type { Logger } from '../logger';
import { PrometheonError } from '../utils/errors';
import type { GraphifyConfig } from './types';
import type { WorkspaceService } from './WorkspaceService';

const run = promisify(execFile);

/** O painel pediu um rebuild sem que houvesse comando configurado. */
export class GraphCommandMissingError extends PrometheonError {
  constructor() {
    super(
      t('Set the rebuild command first: each project has its own, and there is no safe default.'),
      'graph.command-missing',
    );
  }
}

export class GraphWorkspaceRequiredError extends PrometheonError {
  constructor() {
    super(
      t('The project graph lives inside the open folder. Open a folder first.'),
      'graph.workspace-required',
    );
  }
}

/** Nome do terminal reaproveitado entre rebuilds, para não acumular abas. */
const TERMINAL_NAME = 'Prometheon · graph';

/** Onde os scripts gerados moram, relativo à raiz do projeto. */
const SCRIPTS_DIR = ['scripts'] as const;

/**
 * Conteúdo dos scripts de rebuild gerados. Ambos são criados — o time pode ser
 * misto — e ambos dizem a mesma coisa: o comando dentro deles é um ponto de
 * partida, não uma verdade. O corpus certo é decisão do projeto.
 */
function powershellScript(outputDir: string): string {
  return `# Reconstrói o grafo de conhecimento do projeto (graphify).
# Gerado pelo Prometheon. Ajuste o comando ao corpus deste projeto: o comando
# errado reconstrói o grafo a partir de um corpus diferente do que vocês curam.
# A saída esperada fica em "${outputDir}/" (knowledge.graphify.outputDir).
$ErrorActionPreference = 'Stop'

graphify update .
`;
}

function shellScript(outputDir: string): string {
  return `#!/usr/bin/env bash
# Reconstrói o grafo de conhecimento do projeto (graphify).
# Gerado pelo Prometheon. Ajuste o comando ao corpus deste projeto: o comando
# errado reconstrói o grafo a partir de um corpus diferente do que vocês curam.
# A saída esperada fica em "${outputDir}/" (knowledge.graphify.outputDir).
set -euo pipefail

graphify update .
`;
}

/**
 * Estado do grafo de conhecimento do projeto e execução do rebuild.
 *
 * O grafo não pertence ao Prometheon: ele mora na raiz do projeto, é gerado por
 * uma ferramenta externa e vai para o Git junto do código. Aqui só se lê o que
 * há em disco e se dispara o comando que o time configurou — a extensão nunca
 * decide sozinha como reconstruir, porque o comando errado corrompe o corpus.
 */
export class GraphService {
  /**
   * Gera os scripts de rebuild em `.prometheon/scripts/` — PowerShell e Bash,
   * porque o time pode ser misto — e devolve o comando da plataforma atual,
   * relativo à raiz do projeto. Script existente nunca é sobrescrito: ajuste
   * feito pelo time vale mais que o template.
   */
  async createRebuildScript(config: GraphifyConfig): Promise<{
    readonly command: string;
    readonly open: vscode.Uri;
  }> {
    const prometheonDir = this.workspace.prometheonDir;
    if (prometheonDir === null) {
      throw new GraphWorkspaceRequiredError();
    }
    const dir = vscode.Uri.joinPath(prometheonDir, ...SCRIPTS_DIR);
    await vscode.workspace.fs.createDirectory(dir);

    const powershell = vscode.Uri.joinPath(dir, 'rebuild-graphify.ps1');
    const shell = vscode.Uri.joinPath(dir, 'rebuild-graphify.sh');
    await this.writeIfMissing(powershell, powershellScript(config.outputDir));
    await this.writeIfMissing(shell, shellScript(config.outputDir));

    const windows = process.platform === 'win32';
    return {
      command: windows
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -File .prometheon/scripts/rebuild-graphify.ps1'
        : 'bash .prometheon/scripts/rebuild-graphify.sh',
      open: windows ? powershell : shell,
    };
  }

  private async writeIfMissing(file: vscode.Uri, content: string): Promise<void> {
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(content));
    }
  }

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
