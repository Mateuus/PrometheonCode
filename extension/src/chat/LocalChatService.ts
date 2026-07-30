import type { AgentRegistry } from '../agents/AgentRegistry';
import type { Logger } from '../logger';
import type { LocalStateStore } from '../storage/LocalStateStore';
import { PrometheonError, serializeError } from '../utils/errors';
import { newId } from '../utils/ids';
import type {
  ChatEvent,
  ChatMessage,
  ChatService,
  Conversation,
  ConversationSummary,
  CreateConversationInput,
  SendMessageInput,
} from './types';

export class ConversationNotFoundError extends PrometheonError {
  constructor(conversationId: string) {
    super(`Conversa não encontrada: ${conversationId}`, 'chat.conversation-not-found');
  }
}

interface RunState {
  readonly sessionId: string;
  readonly agentId: string;
  readonly messageId: string;
}

/**
 * Chat que funciona sem conta e sem servidor. O histórico fica em
 * `workspaceState` e nunca sai da máquina — nada aqui fala com o Hub.
 */
export class LocalChatService implements ChatService {
  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly store: LocalStateStore,
    private readonly registry: AgentRegistry,
    private readonly logger: Logger,
  ) {}

  listConversations(): Promise<ConversationSummary[]> {
    return Promise.resolve(
      this.store.getConversations().map(({ messages: _messages, ...summary }) => summary),
    );
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      id: newId('conv'),
      title: input.title ?? 'Local chat',
      chatType: input.chatType,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
    };
    await this.store.setConversations([...this.store.getConversations(), conversation]);
    await this.store.setActiveConversationId(conversation.id);
    return conversation;
  }

  getMessages(conversationId: string): Promise<ChatMessage[]> {
    const conversation = this.find(conversationId);
    if (conversation === undefined) {
      return Promise.reject(new ConversationNotFoundError(conversationId));
    }
    return Promise.resolve([...conversation.messages]);
  }

  /** Apaga as mensagens de uma conversa local, mantendo a conversa. */
  async clearConversation(conversationId: string): Promise<void> {
    const conversation = this.find(conversationId);
    if (conversation === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    await this.replace({ ...conversation, messages: [], messageCount: 0, updatedAt: Date.now() });
  }

  async *sendMessage(input: SendMessageInput): AsyncIterable<ChatEvent> {
    const conversation = this.find(input.conversationId);
    if (conversation === undefined) {
      throw new ConversationNotFoundError(input.conversationId);
    }

    const runId = newId('run');
    const userMessage = await this.append(conversation.id, {
      id: newId('msg'),
      conversationId: conversation.id,
      author: 'user',
      content: input.content,
      status: 'sent',
      timestamp: Date.now(),
    });
    yield { type: 'run.started', runId, message: userMessage };

    const adapter = this.registry.require(input.mainAgentId);
    const task = firstLine(input.content);
    const session = await adapter.start({
      workMode: input.workMode,
      autonomy: input.autonomy,
      role: 'main',
      task,
    });

    const agentMessage = await this.append(conversation.id, {
      id: newId('msg'),
      conversationId: conversation.id,
      author: 'agent',
      agentId: adapter.id,
      agentName: adapter.displayName,
      content: '',
      status: 'streaming',
      timestamp: Date.now(),
    });
    this.runs.set(runId, {
      sessionId: session.id,
      agentId: adapter.id,
      messageId: agentMessage.id,
    });
    yield { type: 'message.created', runId, message: agentMessage };
    yield {
      type: 'agent.status',
      runId,
      agent: {
        sessionId: session.id,
        agentId: adapter.id,
        displayName: adapter.displayName,
        role: 'main',
        status: 'starting',
        task,
      },
    };

    let content = '';
    try {
      for await (const event of adapter.send(session.id, {
        content: input.content,
        workMode: input.workMode,
        autonomy: input.autonomy,
      })) {
        switch (event.type) {
          case 'status':
            yield {
              type: 'agent.status',
              runId,
              agent: {
                sessionId: session.id,
                agentId: adapter.id,
                displayName: adapter.displayName,
                role: 'main',
                status: event.status,
                task,
              },
            };
            break;

          case 'delta':
            content += event.text;
            yield { type: 'message.delta', runId, messageId: agentMessage.id, delta: event.text };
            break;

          case 'completed':
            content = event.text;
            await this.patchMessage(conversation.id, agentMessage.id, {
              content,
              status: 'sent',
            });
            yield { type: 'message.completed', runId, messageId: agentMessage.id, content };
            break;

          case 'cancelled':
            await this.patchMessage(conversation.id, agentMessage.id, {
              content,
              status: 'sent',
            });
            yield { type: 'run.cancelled', runId, messageId: agentMessage.id };
            break;

          case 'failed':
            await this.patchMessage(conversation.id, agentMessage.id, {
              content,
              status: 'failed',
            });
            yield { type: 'run.failed', runId, error: event.error };
            break;
        }
      }
    } catch (error) {
      this.logger.error(`Run ${runId} falhou: ${String(error)}`);
      await this.patchMessage(conversation.id, agentMessage.id, { content, status: 'failed' });
      yield { type: 'run.failed', runId, error: serializeError(error) };
    } finally {
      this.runs.delete(runId);
      await adapter.dispose(session.id);
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return;
    }
    await this.registry.require(run.agentId).interrupt(run.sessionId);
  }

  private find(conversationId: string): Conversation | undefined {
    return this.store.getConversations().find((item) => item.id === conversationId);
  }

  private async append(conversationId: string, message: ChatMessage): Promise<ChatMessage> {
    const conversation = this.find(conversationId);
    if (conversation === undefined) {
      throw new ConversationNotFoundError(conversationId);
    }
    const messages = [...conversation.messages, message];
    await this.replace({
      ...conversation,
      messages,
      messageCount: messages.length,
      updatedAt: message.timestamp,
    });
    return message;
  }

  private async patchMessage(
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
  ): Promise<void> {
    const conversation = this.find(conversationId);
    if (conversation === undefined) {
      return;
    }
    const messages = conversation.messages.map((message) =>
      message.id === messageId ? { ...message, ...patch } : message,
    );
    await this.replace({ ...conversation, messages, updatedAt: Date.now() });
  }

  private async replace(conversation: Conversation): Promise<void> {
    const conversations = this.store
      .getConversations()
      .map((item) => (item.id === conversation.id ? conversation : item));
    await this.store.setConversations(conversations);
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}
