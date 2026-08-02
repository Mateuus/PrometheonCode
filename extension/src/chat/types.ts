import type { StartAgentInput } from '../agents/AgentAdapter';
import type { AgentQuestionRequest } from '../agents/questions';
import type {
  ActiveAgentSummary,
  Autonomy,
  EffortLevel,
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
  /**
   * Sessão de agente que produziu o passo.
   *
   * É o que permite separar por agente o que hoje chega numa timeline só. Com
   * um agente executando, todos os passos têm o mesmo valor; com delegação, é a
   * diferença entre um console por agente e um amontoado.
   */
  readonly sessionId?: string;
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
  /** Linhas da saída **inteira**, contadas antes do corte. */
  readonly outputLines?: number;
  /** Há cópia integral em disco, que o editor consegue abrir. */
  readonly fullOutput?: boolean;
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

/**
 * Corta a saída de um passo no limite de persistência.
 *
 * A contagem de linhas é do texto **inteiro**, medida antes do corte: é ela que
 * responde "quanto isto tinha?" no rótulo do bloco, e medir depois responderia
 * apenas o tamanho do limite.
 */
export function truncateStepOutput(output: string): {
  readonly output: string;
  readonly truncated: boolean;
  readonly lines: number;
} {
  const lines = countLines(output);
  return output.length <= MAX_STEP_OUTPUT_CHARS
    ? { output, truncated: false, lines }
    : { output: output.slice(0, MAX_STEP_OUTPUT_CHARS), truncated: true, lines };
}

/** Linhas de um texto; a quebra final não conta como linha vazia a mais. */
export function countLines(text: string): number {
  if (text === '') {
    return 0;
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.split('\n').length;
}

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly author: MessageAuthor;
  /** Preenchido quando a mensagem vem de um agente. */
  readonly agentId?: string;
  readonly agentName?: string;
  /** Modelo que respondeu, para o cabeçalho da mensagem dizer com o que foi. */
  readonly agentModel?: string;
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
  /** Nome do agente do Prometheon (o perfil), quando há um. */
  readonly agentLabel?: string;
  /** Modelo do Agent Profile principal; a conta não escolhe modelo. */
  readonly model?: string;
  /**
   * Papel e índice de skills do agente principal, já montados. O chat repassa
   * ao adaptador sem interpretar: quem conhece papéis e catálogo é o núcleo.
   */
  readonly systemPrompt?: string;
  /** Esforço de raciocínio desta mensagem, na escala canônica. */
  readonly effort?: EffortLevel;
  /**
   * Ferramenta de delegação para o agente principal desta mensagem. O chat
   * repassa ao adaptador sem interpretar — quem decide se há a quem delegar é
   * o núcleo.
   */
  readonly delegation?: StartAgentInput['delegation'];
  /**
   * Quem está falando. Ausente é o usuário; `system` é o Prometheon
   * retomando a conversa por conta própria — quando o relatório de um worker
   * chega depois que o turno acabou, por exemplo.
   */
  readonly author?: MessageAuthor;
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
  /**
   * Tokens acumulados no run até agora. É estimativa em andamento: o número
   * que fica na mensagem é o do `message.completed`.
   */
  /**
   * Modelo que o agente está usando de fato, como o CLI o reporta — a marca de
   * janela no nome (`[1m]`) é o que dá o tamanho real do contexto.
   */
  | { readonly type: 'run.model'; readonly runId: string; readonly model: string }
  | {
      readonly type: 'run.usage';
      readonly runId: string;
      readonly usage: TokenUsage;
      /**
       * Maior entrada de um único turno neste run.
       *
       * Não é `usage.input`: aquele soma os turnos, porque é conta a pagar. Aqui
       * a pergunta é outra — quanto do contexto está ocupado — e a resposta é o
       * turno mais pesado, já que cada turno reenvia o histórico inteiro.
       */
      readonly contextTokens?: number;
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
  /** Apaga a conversa inteira. Apagar o que não existe é um sucesso silencioso. */
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(input: SendMessageInput): AsyncIterable<ChatEvent>;
  cancel(runId: string): Promise<void>;
}
