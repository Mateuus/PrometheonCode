import type { ChatMessage } from '../chat/types';
import type {
  ActiveAgentSummary,
  AgentSummary,
  Autonomy,
  BypassGrant,
  ChatType,
  HubConnectionStatus,
  WorkMode,
  WorkspaceStatus,
} from './types';

/** Snapshot completo enviado à webview. É a única fonte de verdade da UI. */
export interface PrometheonViewState {
  readonly extensionVersion: string;
  readonly chatType: ChatType;
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  readonly bypass: BypassGrant | null;
  readonly mainAgentId: string;
  readonly agents: readonly AgentSummary[];
  readonly activeAgents: readonly ActiveAgentSummary[];
  readonly hub: HubConnectionStatus;
  readonly workspace: WorkspaceStatus;
  readonly conversationId: string | null;
  readonly messages: readonly ChatMessage[];
  /** Há um run em andamento; a UI mostra o botão de interromper. */
  readonly busy: boolean;
}
