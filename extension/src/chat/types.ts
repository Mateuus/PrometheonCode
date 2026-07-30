import type { AgentQuestionRequest } from '../agents/questions';
import type {
  ActiveAgentSummary,
  Autonomy,
  ChatType,
  SerializedError,
  WorkMode,
} from '../core/types';
import type { TokenUsage } from '../providers/UsageTracker';

export type MessageAuthor = 'user' | 'agent' | 'system';
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'streaming';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const IMAGE_MIME_TYPES: readonly ImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/**
 * Imagem anexada a uma mensagem. Os bytes ficam em base64 junto da conversa,
 * no `workspaceState` — nunca são gravados no repositório nem enviados a
 * lugar nenhum sem o run correspondente.
 */
export interface ImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: ImageMimeType;
  /** Conteúdo em base64, sem o prefixo `data:`. */
  readonly data: string;
  readonly byteSize: number;
  /** Dimensões em pixels, medidas na webview. Ausentes se a imagem não decodificar. */
  readonly width?: number;
  readonly height?: number;
}

export type AgentStepKind = 'tool' | 'thought' | 'question';
export type AgentStepStatus = 'running' | 'done' | 'failed';

/**
 * Um passo do trabalho do agente, exibido como item de timeline no chat: uso de
 * ferramenta (Write, Edit, Bash, Read…), um bloco de raciocínio ou uma pergunta
 * feita ao usuário. Fica dentro da `ChatMessage` para sobreviver ao reload da
 * conversa — o evento sozinho é efêmero e se perderia ao reabrir a sessão.
 */
export interface AgentStep {
  /** Igual ao `toolId` do adaptador; liga início e fim do mesmo passo. */
  readonly id: string;
  readonly kind: AgentStepKind;
  /** Nome exibido em destaque: "Write", "Bash", "Read". */
  readonly tool: string;
  /** Alvo da ferramenta: caminho do arquivo, nome do comando. */
  readonly title: string;
  /** Linha de apoio: "147 lines", o comando executado. */
  readonly detail?: string;
  /** Conteúdo em bloco monoespaçado, já truncado para persistência. */
  readonly output?: string;
  /** A saída foi cortada em `MAX_STEP_OUTPUT_CHARS`; a interface avisa. */
  readonly truncated?: boolean;
  readonly status: AgentStepStatus;
  readonly startedAt: number;
  /** Duração do passo; para `thought`, o tempo que o agente ficou pensando. */
  readonly durationMs?: number;
}

/**
 * Teto da saída guardada por passo. O histórico vive no `workspaceState`, que
 * não é lugar para o dump inteiro de um comando — o que passa disso é cortado e
 * marcado como truncado.
 */
export const MAX_STEP_OUTPUT_CHARS = 4096;

/** Corta a saída de um passo no limite de persistência. */
export function truncateStepOutput(output: string): {
  readonly output: string;
  readonly truncated: boolean;
} {
  return output.length <= MAX_STEP_OUTPUT_CHARS
    ? { output, truncated: false }
    : { output: output.slice(0, MAX_STEP_OUTPUT_CHARS), truncated: true };
}

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly author: MessageAuthor;
  /** Preenchido quando a mensagem vem de um agente. */
  readonly agentId?: string;
  readonly agentName?: string;
  readonly content: string;
  readonly attachments?: readonly ImageAttachment[];
  /** Passos do agente até esta resposta, na ordem em que aconteceram. */
  readonly steps?: readonly AgentStep[];
  /** Tokens gastos nesta resposta, quando o agente reporta. */
  readonly usage?: TokenUsage;
  readonly status: MessageStatus;
  readonly timestamp: number;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly chatType: ChatType;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
}

export interface Conversation extends ConversationSummary {
  readonly messages: readonly ChatMessage[];
}

export interface CreateConversationInput {
  readonly chatType: ChatType;
  readonly title?: string;
}

export interface SendMessageInput {
  readonly conversationId: string;
  readonly content: string;
  readonly attachments?: readonly ImageAttachment[];
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  readonly mainAgentId: string;
}

export type ChatEvent =
  /** Mensagem do usuário aceita e persistida; o run começou. */
  | { readonly type: 'run.started'; readonly runId: string; readonly message: ChatMessage }
  /** Placeholder do agente criado, ainda sem conteúdo. */
  | { readonly type: 'message.created'; readonly runId: string; readonly message: ChatMessage }
  | {
      readonly type: 'message.delta';
      readonly runId: string;
      readonly messageId: string;
      readonly delta: string;
    }
  | {
      readonly type: 'message.completed';
      readonly runId: string;
      readonly messageId: string;
      readonly content: string;
      readonly usage?: TokenUsage;
    }
  /**
   * Passo iniciado. Chega com o passo inteiro para a webview só fazer upsert
   * por `step.id`, sem precisar remontar nada a partir de campos soltos.
   */
  | {
      readonly type: 'step.started';
      readonly runId: string;
      readonly messageId: string;
      readonly step: AgentStep;
    }
  /** Mesmo passo, agora concluído (ou falho). Substitui o anterior pelo `id`. */
  | {
      readonly type: 'step.completed';
      readonly runId: string;
      readonly messageId: string;
      readonly step: AgentStep;
    }
  /** O agente parou para perguntar; a interface abre o modal e o run espera. */
  | {
      readonly type: 'question.asked';
      readonly runId: string;
      readonly messageId: string;
      readonly request: AgentQuestionRequest;
    }
  /** O pedido saiu de cena — respondido, cancelado ou interrompido pelo run. */
  | { readonly type: 'question.closed'; readonly runId: string; readonly requestId: string }
  | { readonly type: 'run.failed'; readonly runId: string; readonly error: SerializedError }
  | { readonly type: 'run.cancelled'; readonly runId: string; readonly messageId: string }
  /** Progresso do agente, usado para alimentar o painel Active Agents. */
  | {
      readonly type: 'agent.status';
      readonly runId: string;
      readonly agent: ActiveAgentSummary;
    };

export interface ChatService {
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  sendMessage(input: SendMessageInput): AsyncIterable<ChatEvent>;
  cancel(runId: string): Promise<void>;
}
