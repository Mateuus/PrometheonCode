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
} as const;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}
