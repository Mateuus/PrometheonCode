import type { AgentQuestionRequest } from '../agents/questions';
import type { ChatMessage, ConversationSummary } from '../chat/types';
import type { LanguageChoice } from '../i18n/language';
import type {
  AccountSummary,
  ActiveAgentSummary,
  ActivityStatus,
  AgentProfileSummary,
  AgentSummary,
  Autonomy,
  BypassGrant,
  ChatType,
  EffortLevel,
  ContextWindowStatus,
  CustomAgentRole,
  GitStatus,
  GraphStatus,
  HubConnectionStatus,
  McpStatus,
  SkillCatalogStatus,
  ProjectOption,
  ProviderModels,
  ProviderOption,
  SpeechStatus,
  WorkMode,
  WorkspaceStatus,
} from './types';

/** Snapshot completo enviado à webview. É a única fonte de verdade da UI. */
export interface PrometheonViewState {
  readonly extensionVersion: string;
  /** Idioma escolhido para o painel; `auto` segue o VS Code. */
  readonly language: LanguageChoice;
  readonly chatType: ChatType;
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  /**
   * Esforço de raciocínio que vale no próximo run — do composer ou do agente.
   * Ausente quer dizer que a decisão fica com o CLI do provedor.
   */
  readonly effort?: EffortLevel;
  readonly bypass: BypassGrant | null;
  readonly mainAgentId: string;
  readonly agents: readonly AgentSummary[];
  readonly activeAgents: readonly ActiveAgentSummary[];
  readonly hub: HubConnectionStatus;
  /** Projetos do Hub disponíveis para o Web Chat; vazio sem conexão. */
  readonly webProjects: readonly ProjectOption[];
  /** Projeto escolhido para o Web Chat; sem ele não há conversa remota. */
  readonly webProjectId: string | null;
  readonly speech: SpeechStatus;
  /** Contas de provedor conhecidas nesta máquina, com uso local de tokens. */
  readonly accounts: readonly AccountSummary[];
  /** Provedores com adaptador registrado, para criar uma conta pelo painel. */
  readonly providers: readonly ProviderOption[];
  /** Modelos conhecidos por provedor. Sugestão da interface, nunca um gate. */
  readonly models: readonly ProviderModels[];
  /** Agent Profiles com o binding `Agent → Provider → Account` já resolvido. */
  readonly agentProfiles: readonly AgentProfileSummary[];
  /** Papéis nomeados visíveis aqui: do projeto, do Hub e desta máquina. */
  readonly customRoles: readonly CustomAgentRole[];
  /** Catálogo de skills encontradas, para o formulário e a seção de skills. */
  readonly skills: SkillCatalogStatus;
  /** Servidores MCP do projeto e por que a seção pode estar indisponível. */
  readonly mcp: McpStatus;
  /** Grafo de conhecimento do projeto: o que há em disco e como reconstruí-lo. */
  readonly graph: GraphStatus;
  /** Política de commit do projeto e o estado dos hooks que a garantem. */
  readonly git: GitStatus;
  readonly activity: ActivityStatus;
  /** Ocupação estimada da janela de contexto do agente principal. */
  readonly context: ContextWindowStatus;
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
