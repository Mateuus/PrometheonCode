import type { AgentQuestionRequest } from '../agents/questions';
import type { ChatMessage, ConversationSummary } from '../chat/types';
import type {
  AccountSummary,
  ActiveAgentSummary,
  ActivityStatus,
  AgentProfileSummary,
  AgentSummary,
  Autonomy,
  BypassGrant,
  ChatType,
  HubConnectionStatus,
  McpStatus,
  ProviderOption,
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
  /** Provedores com adaptador registrado, para criar uma conta pelo painel. */
  readonly providers: readonly ProviderOption[];
  /** Agent Profiles com o binding `Agent → Provider → Account` já resolvido. */
  readonly agentProfiles: readonly AgentProfileSummary[];
  /** Servidores MCP do projeto e por que a seção pode estar indisponível. */
  readonly mcp: McpStatus;
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
  /**
   * Pergunta do agente esperando resposta. Fica no snapshot para uma view
   * reconstruída reabrir o modal — o run continua parado do outro lado.
   */
  readonly pendingQuestion: AgentQuestionRequest | null;
}
