import type { ChatMessage, ConversationSummary } from '../chat/types';
import type {
  AccountSummary,
  ActiveAgentSummary,
  ActivityStatus,
  AgentSummary,
  Autonomy,
  BypassGrant,
  ChatType,
  HubConnectionStatus,
  SpeechStatus,
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
  readonly speech: SpeechStatus;
  /** Contas de provedor conhecidas nesta máquina, com uso local de tokens. */
  readonly accounts: readonly AccountSummary[];
  readonly activity: ActivityStatus;
  readonly workspace: WorkspaceStatus;
  readonly conversationId: string | null;
  /** Título da conversa aberta, exibido no cabeçalho. */
  readonly conversationTitle: string;
  readonly messages: readonly ChatMessage[];
  /** Sessões do tipo de chat selecionado, da mais recente para a mais antiga. */
  readonly sessions: readonly ConversationSummary[];
  /** Há um run em andamento; a UI mostra o botão de interromper. */
  readonly busy: boolean;
}
