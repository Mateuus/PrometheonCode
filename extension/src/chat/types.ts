import type {
  ActiveAgentSummary,
  Autonomy,
  ChatType,
  SerializedError,
  WorkMode,
} from '../core/types';

export type MessageAuthor = 'user' | 'agent' | 'system';
export type MessageStatus = 'sending' | 'sent' | 'failed' | 'streaming';

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly author: MessageAuthor;
  /** Preenchido quando a mensagem vem de um agente. */
  readonly agentId?: string;
  readonly agentName?: string;
  readonly content: string;
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
    }
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
