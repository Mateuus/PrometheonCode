import type { AgentRegistry } from '../agents/AgentRegistry';
import type { Logger } from '../logger';
import type { LocalStateStore } from '../storage/LocalStateStore';
import { PrometheonError, serializeError } from '../utils/errors';
import { newId } from '../utils/ids';
import { truncateStepOutput } from './types';
import type {
  AgentStep,
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

/** Nome de uma sessão que ainda não recebeu a primeira mensagem. */
export const UNTITLED = 'Untitled';

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
      title: input.title ?? UNTITLED,
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
    await this.replace({
      ...conversation,
      messages: [],
      messageCount: 0,
      title: UNTITLED,
      updatedAt: Date.now(),
    });
  }

  async rename(conversationId: string, title: string): Promise<void> {
    const conversation = this.find(conversationId);
    if (conversation === undefined) {
      return;
    }
    await this.replace({ ...conversation, title });
  }

  async *sendMessage(input: SendMessageInput): AsyncIterable<ChatEvent> {
    const conversation = this.find(input.conversationId);
    if (conversation === undefined) {
      throw new ConversationNotFoundError(input.conversationId);
    }

    const runId = newId('run');
    const attachments = input.attachments ?? [];
    const userMessage = await this.append(conversation.id, {
      id: newId('msg'),
      conversationId: conversation.id,
      author: 'user',
      content: input.content,
      ...(attachments.length === 0 ? {} : { attachments }),
      status: 'sent',
      timestamp: Date.now(),
    });
    // A sessão continua "Untitled" até a primeira mensagem dar um nome a ela.
    if (conversation.title === UNTITLED) {
      await this.rename(conversation.id, sessionTitle(input.content, attachments.length));
    }
    yield { type: 'run.started', runId, message: userMessage };

    const adapter = this.registry.require(input.mainAgentId);
    const task = sessionTitle(input.content, attachments.length);
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
    /** Passos do agente nesta resposta, na ordem, prontos para persistir. */
    const steps: AgentStep[] = [];

    // Persistimos a cada passo, e não só no fim: recarregar a conversa no meio
    // de um run precisa devolver o que o agente já fez.
    const upsertStep = async (step: AgentStep): Promise<void> => {
      const at = steps.findIndex((item) => item.id === step.id);
      if (at === -1) {
        steps.push(step);
      } else {
        steps[at] = step;
      }
      await this.patchMessage(conversation.id, agentMessage.id, { steps: [...steps] });
    };

    /**
     * Fecha os passos que ficaram em andamento quando o run acabou antes da
     * ferramenta responder. Sem isto, a bolinha ficaria pulsando para sempre.
     */
    const settlePending = (): AgentStep[] => {
      const now = Date.now();
      const closed: AgentStep[] = [];
      steps.forEach((step, index) => {
        if (step.status !== 'running') {
          return;
        }
        const settled: AgentStep = { ...step, status: 'failed', durationMs: now - step.startedAt };
        steps[index] = settled;
        closed.push(settled);
      });
      return closed;
    };

    try {
      for await (const event of adapter.send(session.id, {
        content: input.content,
        ...(attachments.length === 0 ? {} : { attachments }),
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

          case 'tool.requested': {
            const step: AgentStep = {
              id: event.toolId,
              kind: 'tool',
              tool: event.tool,
              title: event.title,
              ...(event.detail === undefined ? {} : { detail: event.detail }),
              status: 'running',
              startedAt: Date.now(),
            };
            await upsertStep(step);
            yield { type: 'step.started', runId, messageId: agentMessage.id, step };
            break;
          }

          case 'tool.completed': {
            const started = steps.find((item) => item.id === event.toolId);
            const startedAt = started?.startedAt ?? Date.now();
            const detail = event.detail ?? started?.detail;
            const output = event.output === undefined ? null : truncateStepOutput(event.output);
            const step: AgentStep = {
              id: event.toolId,
              kind: 'tool',
              tool: started?.tool ?? 'Tool',
              title: started?.title ?? '',
              ...(detail === undefined ? {} : { detail }),
              ...(output === null
                ? {}
                : {
                    output: output.output,
                    ...(output.truncated ? { truncated: true } : {}),
                  }),
              status: event.failed === true ? 'failed' : 'done',
              startedAt,
              durationMs: Date.now() - startedAt,
            };
            await upsertStep(step);
            yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
            break;
          }

          case 'thought': {
            // Raciocínio chega já concluído: só o par tempo/ordem interessa.
            const step: AgentStep = {
              id: newId('step'),
              kind: 'thought',
              tool: 'Thought',
              title: '',
              status: 'done',
              startedAt: Date.now() - event.durationMs,
              durationMs: event.durationMs,
            };
            await upsertStep(step);
            yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
            break;
          }

          case 'completed':
            content = event.text;
            await this.patchMessage(conversation.id, agentMessage.id, {
              content,
              status: 'sent',
              ...(event.usage === undefined ? {} : { usage: event.usage }),
            });
            yield {
              type: 'message.completed',
              runId,
              messageId: agentMessage.id,
              content,
              ...(event.usage === undefined ? {} : { usage: event.usage }),
            };
            break;

          case 'cancelled':
            for (const step of settlePending()) {
              yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
            }
            await this.patchMessage(conversation.id, agentMessage.id, {
              content,
              status: 'sent',
              steps: [...steps],
            });
            yield { type: 'run.cancelled', runId, messageId: agentMessage.id };
            break;

          case 'failed':
            for (const step of settlePending()) {
              yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
            }
            await this.patchMessage(conversation.id, agentMessage.id, {
              content,
              status: 'failed',
              steps: [...steps],
            });
            yield { type: 'run.failed', runId, error: event.error };
            break;
        }
      }
    } catch (error) {
      this.logger.error(`Run ${runId} falhou: ${String(error)}`);
      for (const step of settlePending()) {
        yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
      }
      await this.patchMessage(conversation.id, agentMessage.id, {
        content,
        status: 'failed',
        steps: [...steps],
      });
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

/** Nome da sessão derivado da primeira mensagem; imagens sozinhas também nomeiam. */
function sessionTitle(content: string, attachmentCount: number): string {
  const line = firstLine(content);
  if (line !== '') {
    return line;
  }
  return attachmentCount === 1 ? '1 image' : `${attachmentCount} images`;
}
