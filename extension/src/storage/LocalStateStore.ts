import type * as vscode from 'vscode';
import type { Conversation } from '../chat/types';
import type { UsageEntry } from '../providers/UsageTracker';
import {
  AUTONOMY_LEVELS,
  CHAT_TYPES,
  WORK_MODES,
  type Autonomy,
  type ChatType,
  type WorkMode,
} from '../core/types';

/**
 * Preferências e histórico locais, nunca compartilhados e nunca secretos.
 *
 * - `globalState`: preferências de orquestração e interface, que valem como
 *   padrão em qualquer projeto.
 * - `workspaceState`: conversas locais e decisões tomadas para este workspace.
 *
 * `Autonomy` é gravada aqui somente quando diferente de `bypass` — bypass é
 * concessão de sessão e não pode sobreviver a um reinício.
 */
export class LocalStateStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get global(): vscode.Memento {
    return this.context.globalState;
  }

  private get workspace(): vscode.Memento {
    return this.context.workspaceState;
  }

  /**
   * Apaga tudo que esta extensão gravou, nos dois escopos.
   *
   * Cada chave é removida pelo nome, e não por uma varredura: `globalState` e
   * `workspaceState` são compartilhados com as outras extensões, e limpar em
   * bloco levaria junto o que não é nosso.
   *
   * As duas listas são percorridas mesmo quando a chave só existe num dos
   * escopos — remover o que não está lá não custa nada, e depender de lembrar
   * qual chave mora onde é como uma delas sobreviveria ao reset.
   */
  async clearAll(): Promise<void> {
    for (const key of LOCAL_STATE_KEYS) {
      await this.global.update(key, undefined);
      await this.workspace.update(key, undefined);
    }
  }

  getChatType(): ChatType {
    return pick(this.global.get<string>(KEYS.chatType), CHAT_TYPES, 'local');
  }

  setChatType(value: ChatType): Thenable<void> {
    return this.global.update(KEYS.chatType, value);
  }

  getWorkMode(): WorkMode {
    return pick(this.global.get<string>(KEYS.workMode), WORK_MODES, 'plan');
  }

  setWorkMode(value: WorkMode): Thenable<void> {
    return this.global.update(KEYS.workMode, value);
  }

  getAutonomy(): Autonomy {
    const stored = pick(this.global.get<string>(KEYS.autonomy), AUTONOMY_LEVELS, 'manual');
    // Cinto de segurança: se um valor "bypass" tiver sido gravado por uma versão
    // anterior, ele é ignorado na leitura.
    return stored === 'bypass' ? 'manual' : stored;
  }

  setAutonomy(value: Autonomy): Thenable<void> {
    if (value === 'bypass') {
      return Promise.resolve();
    }
    return this.global.update(KEYS.autonomy, value);
  }

  getMainAgentId(fallback: string): string {
    return this.global.get<string>(KEYS.mainAgent) ?? fallback;
  }

  setMainAgentId(value: string): Thenable<void> {
    return this.global.update(KEYS.mainAgent, value);
  }

  getConversations(): Conversation[] {
    return this.workspace.get<Conversation[]>(KEYS.conversations) ?? [];
  }

  setConversations(value: readonly Conversation[]): Thenable<void> {
    return this.workspace.update(KEYS.conversations, value);
  }

  getActiveConversationId(): string | null {
    return this.workspace.get<string>(KEYS.activeConversation) ?? null;
  }

  setActiveConversationId(value: string | null): Thenable<void> {
    return this.workspace.update(KEYS.activeConversation, value ?? undefined);
  }

  /** Usuário escolheu seguir sem workspace compartilhado neste projeto. */
  isWorkspaceSetupSkipped(): boolean {
    return this.workspace.get<boolean>(KEYS.workspaceSkipped) ?? false;
  }

  setWorkspaceSetupSkipped(value: boolean): Thenable<void> {
    return this.workspace.update(KEYS.workspaceSkipped, value);
  }

  /**
   * Contagem de tokens por perfil e dia. Fica no estado global porque as contas
   * são da máquina, não do projeto aberto.
   */
  getUsageEntries(): UsageEntry[] {
    return this.global.get<UsageEntry[]>(KEYS.usage) ?? [];
  }

  setUsageEntries(value: readonly UsageEntry[]): Thenable<void> {
    return this.global.update(KEYS.usage, value);
  }

  /**
   * Projeto do Hub escolhido para o Web Chat.
   *
   * Fica no estado do workspace: cada pasta aberta costuma corresponder a um
   * projeto diferente no Hub, e uma escolha global obrigaria a trocar de projeto
   * toda vez que se troca de repositório.
   */
  getWebProjectId(): string | null {
    return this.workspace.get<string>(KEYS.webProject) ?? null;
  }

  setWebProjectId(value: string | null): Thenable<void> {
    return this.workspace.update(KEYS.webProject, value ?? undefined);
  }

  /**
   * Compactar sozinho ao encher a janela. Global: a preferência é de quem usa,
   * e não do projeto aberto.
   */
  getAutoCompact(): boolean {
    return this.global.get<boolean>(KEYS.autoCompact) ?? true;
  }

  setAutoCompact(value: boolean): Thenable<void> {
    return this.global.update(KEYS.autoCompact, value);
  }

  getExternalWorkspaceFolder(): string | null {
    return this.workspace.get<string>(KEYS.externalWorkspace) ?? null;
  }

  setExternalWorkspaceFolder(value: string | null): Thenable<void> {
    return this.workspace.update(KEYS.externalWorkspace, value ?? undefined);
  }
}

const KEYS = {
  chatType: 'prometheon.chatType',
  workMode: 'prometheon.workMode',
  autonomy: 'prometheon.autonomy',
  mainAgent: 'prometheon.mainAgent',
  conversations: 'prometheon.local.conversations',
  activeConversation: 'prometheon.local.activeConversation',
  workspaceSkipped: 'prometheon.workspace.skipped',
  externalWorkspace: 'prometheon.workspace.externalFolder',
  usage: 'prometheon.usage.entries',
  autoCompact: 'prometheon.context.autoCompact',
  webProject: 'prometheon.web.projectId',
} as const;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

/**
 * Todas as chaves gravadas por esta extensão.
 *
 * Exportada para o reset conseguir apagar exatamente o que o Prometheon
 * escreveu — nem mais, nem menos. O `globalState` e o `workspaceState` do VS
 * Code são compartilhados, e varrer tudo levaria junto o que é de outra
 * extensão. Chave nova precisa entrar aqui, senão sobrevive a um reset e
 * ressuscita como configuração fantasma na instalação seguinte.
 */
export const LOCAL_STATE_KEYS = Object.values(KEYS);
