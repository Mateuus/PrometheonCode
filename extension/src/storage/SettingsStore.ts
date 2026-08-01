import * as vscode from 'vscode';
import { parse, parseDocument } from 'yaml';
import type { Logger } from '../logger';
import {
  initialConfigText,
  normalizeConfig,
  type GitConfig,
  type GraphifyConfig,
  type PersistableAutonomy,
  type WorkspaceConfig,
} from '../workspace/types';
import type { ChatType, WorkMode } from '../core/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface OrchestrationPatch {
  readonly workMode?: WorkMode;
  /** `bypass` é descartado: nunca vira configuração persistida. */
  readonly autonomy?: PersistableAutonomy;
  readonly mainAgent?: string;
  readonly maxWorkers?: number;
}

export type GraphPatch = Partial<GraphifyConfig>;
export type GitPatch = Partial<GitConfig>;

/** Campos editáveis do bloco de chat e orquestração do `prometheon.yaml`. */
export type WorkspacePatch = Partial<
  Pick<WorkspaceConfig['orchestration'], 'workMode' | 'autonomy' | 'mainAgent' | 'maxWorkers'>
> & { readonly defaultType?: WorkspaceConfig['chat']['defaultType'] };

/**
 * Leitura e escrita de `.prometheon/prometheon.yaml` — a configuração
 * compartilhável do workspace. Atualizações usam o documento YAML original, para
 * não apagar comentários nem reordenar o que a equipe escreveu.
 */
export class SettingsStore {
  constructor(private readonly logger: Logger) {}

  async exists(configUri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(configUri);
      return true;
    } catch {
      return false;
    }
  }

  async read(configUri: vscode.Uri, workspaceName: string): Promise<WorkspaceConfig> {
    try {
      const bytes = await vscode.workspace.fs.readFile(configUri);
      return normalizeConfig(parse(decoder.decode(bytes)), workspaceName);
    } catch (error) {
      this.logger.warn(
        `Não foi possível ler ${configUri.fsPath}; usando os padrões. ${String(error)}`,
      );
      return normalizeConfig(undefined, workspaceName);
    }
  }

  /** Cria o arquivo apenas se ainda não existir. Retorna true quando criou. */
  async createIfMissing(configUri: vscode.Uri, workspaceName: string): Promise<boolean> {
    if (await this.exists(configUri)) {
      return false;
    }
    await vscode.workspace.fs.writeFile(configUri, encoder.encode(initialConfigText(workspaceName)));
    return true;
  }

  async updateOrchestration(configUri: vscode.Uri, patch: OrchestrationPatch): Promise<void> {
    const entries: [string[], unknown][] = [];
    if (patch.workMode !== undefined) {
      entries.push([['orchestration', 'workMode'], patch.workMode]);
    }
    if (patch.autonomy !== undefined) {
      entries.push([['orchestration', 'autonomy'], patch.autonomy]);
    }
    if (patch.mainAgent !== undefined) {
      entries.push([['orchestration', 'mainAgent'], patch.mainAgent]);
    }
    if (patch.maxWorkers !== undefined) {
      entries.push([['orchestration', 'maxWorkers'], patch.maxWorkers]);
    }
    await this.applyEntries(configUri, entries);
  }

  async updateDefaultChatType(configUri: vscode.Uri, chatType: ChatType): Promise<void> {
    await this.applyEntries(configUri, [[['chat', 'defaultType'], chatType]]);
  }

  /**
   * Grava um ou mais campos do grafo. Só o que veio no patch é tocado: o painel
   * edita um controle por vez e reescrever o bloco inteiro apagaria o que outra
   * pessoa acabou de mudar no arquivo.
   */
  async updateGraph(configUri: vscode.Uri, patch: GraphPatch): Promise<void> {
    const entries: [string[], unknown][] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        entries.push([['knowledge', 'graphify', key], value]);
      }
    }
    await this.applyEntries(configUri, entries);
  }

  /**
   * Grava chat padrão e orquestração do workspace, campo a campo — mesma regra
   * do grafo: só o que veio no patch é tocado, comentários preservados.
   */
  async updateWorkspace(configUri: vscode.Uri, patch: WorkspacePatch): Promise<void> {
    const entries: [string[], unknown][] = [];
    if (patch.defaultType !== undefined) {
      entries.push([['chat', 'defaultType'], patch.defaultType]);
    }
    for (const key of ['workMode', 'autonomy', 'mainAgent', 'maxWorkers'] as const) {
      const value = patch[key];
      if (value !== undefined) {
        entries.push([['orchestration', key], value]);
      }
    }
    await this.applyEntries(configUri, entries);
  }

  async updateGit(configUri: vscode.Uri, patch: GitPatch): Promise<void> {
    const entries: [string[], unknown][] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        entries.push([['git', key], value]);
      }
    }
    await this.applyEntries(configUri, entries);
  }

  async updateHub(configUri: vscode.Uri, enabled: boolean, url?: string): Promise<void> {
    const entries: [string[], unknown][] = [[['hub', 'enabled'], enabled]];
    if (url !== undefined) {
      entries.push([['hub', 'url'], url]);
    }
    await this.applyEntries(configUri, entries);
  }

  private async applyEntries(
    configUri: vscode.Uri,
    entries: readonly [string[], unknown][],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    if (!(await this.exists(configUri))) {
      this.logger.debug('Sem prometheon.yaml: preferências ficaram apenas no estado local.');
      return;
    }

    const bytes = await vscode.workspace.fs.readFile(configUri);
    const document = parseDocument(decoder.decode(bytes));
    for (const [path, value] of entries) {
      document.setIn(path, value);
    }
    await vscode.workspace.fs.writeFile(configUri, encoder.encode(document.toString()));
  }
}
