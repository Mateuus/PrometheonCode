import type { AgentRegistry } from '../agents/AgentRegistry';
import {
  questionTitle,
  summarizeAnswers,
  type AgentQuestionOutcome,
} from '../agents/questions';
import type { Logger } from '../logger';
import type { LocalStateStore } from '../storage/LocalStateStore';
import { PrometheonError, serializeError } from '../utils/errors';
import { newId } from '../utils/ids';
import type { TokenUsage } from '../providers/UsageTracker';
import type { ToolOutputStore } from './ToolOutputStore';
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
  /** Pergunta aberta neste run, esperando resposta do usuário. */
  pendingQuestionId: string | null;
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
    /** Ausente nos testes: sem ele, a saída longa apenas não fica em disco. */
    private readonly outputs?: ToolOutputStore,
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

  /**
   * Apaga a conversa. Some do histórico e leva as mensagens junto — é o que
   * "excluir" quer dizer, e nada disso saiu da máquina para haver o que limpar
   * em outro lugar.
   *
   * Apagar uma conversa inexistente não é erro: quem clicou já queria que ela
   * não estivesse ali, e falhar só atrapalharia quem tem duas janelas abertas.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const remaining = this.store
      .getConversations()
      .filter((conversation) => conversation.id !== conversationId);

    await this.store.setConversations(remaining);

    if (this.store.getActiveConversationId() === conversationId) {
      await this.store.setActiveConversationId(null);
    }
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
      // Uma continuação disparada pelo próprio Prometheon não é fala do
      // usuário. Marcá-la como tal faria a conversa mentir sobre quem pediu o
      // quê — e é justamente essa distinção que impede o agente de tratar um
      // recado automático como autorização.
      author: input.author ?? 'user',
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
    // O resumo da sessão anterior vai junto da primeira mensagem da nova, e só
    // dela: a partir daí quem lembra é o próprio CLI.
    const carryOver = conversation.resumeId === undefined ? conversation.carryOver : undefined;
    if (carryOver !== undefined) {
      const { carryOver: _used, ...rest } = conversation;
      await this.replace(rest);
    }
    const session = await adapter.start({
      workMode: input.workMode,
      autonomy: input.autonomy,
      role: 'main',
      task,
      ...(input.workspaceFolder === undefined ? {} : { workspaceFolder: input.workspaceFolder }),
      // Continua a conversa que este CLI já tem, quando há uma.
      ...(conversation.resumeId === undefined ? {} : { resumeId: conversation.resumeId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
    });

    const agentMessage = await this.append(conversation.id, {
      id: newId('msg'),
      conversationId: conversation.id,
      author: 'agent',
      agentId: adapter.id,
      // O nome do agente do Prometheon vence o do adaptador: quem responde
      // é "Claudio Main", e o Claude Code é o motor por trás dele.
      agentName: input.agentLabel ?? adapter.displayName,
      ...(input.model === undefined || input.model === '' ? {} : { agentModel: input.model }),
      content: '',
      status: 'streaming',
      timestamp: Date.now(),
    });
    const run: RunState = {
      sessionId: session.id,
      agentId: adapter.id,
      messageId: agentMessage.id,
      pendingQuestionId: null,
    };
    this.runs.set(runId, run);
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
    /** Tokens somados enquanto o run acontece, para a interface ter o que contar. */
    let liveUsage: TokenUsage = { input: 0, output: 0 };
    /** Turno mais pesado do run; é o que estima a ocupação da janela. */
    let contextTokens = 0;
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
        // A mensagem persistida é a do usuário; a que vai ao agente carrega o
        // resumo na frente quando a sessão é nova.
        content:
          carryOver === undefined
            ? input.content
            : [
                '[Prometheon] The previous session filled its context window and was closed.',
                'Here is where the work stands:',
                '',
                carryOver,
                '',
                '---',
                '',
                input.content,
              ].join('\n'),
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
              sessionId: session.id,
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
            // A cópia integral só existe quando o histórico não deu conta. Se a
            // saída coube inteira no passo, gravar um arquivo idêntico ao que já
            // está ali seria só lixo em disco.
            const full =
              output !== null && output.truncated && this.outputs !== undefined
                ? await this.outputs.save(event.toolId, event.output ?? '')
                : false;
            const step: AgentStep = {
              id: event.toolId,
              sessionId: session.id,
              kind: 'tool',
              tool: started?.tool ?? 'Tool',
              title: started?.title ?? '',
              ...(detail === undefined ? {} : { detail }),
              ...(output === null
                ? {}
                : {
                    output: output.output,
                    outputLines: output.lines,
                    ...(output.truncated ? { truncated: true } : {}),
                    ...(full ? { fullOutput: true } : {}),
                  }),
              status: event.failed === true ? 'failed' : 'done',
              startedAt,
              durationMs: Date.now() - startedAt,
            };
            await upsertStep(step);
            yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
            break;
          }

          case 'model':
            yield { type: 'run.model', runId, model: event.model };
            break;

          case 'usage':
            liveUsage = {
              input: liveUsage.input + Math.max(0, event.delta.input),
              output: liveUsage.output + Math.max(0, event.delta.output),
            };
            contextTokens = Math.max(contextTokens, event.delta.input);
            yield { type: 'run.usage', runId, usage: liveUsage, contextTokens };
            break;

          case 'question.asked': {
            // O passo nasce em andamento e só fecha quando a resposta chega:
            // é ele que registra a pergunta no histórico da conversa.
            run.pendingQuestionId = event.request.requestId;
            const step: AgentStep = {
              id: event.request.requestId,
              sessionId: session.id,
              kind: 'question',
              tool: 'Question',
              title: questionTitle(event.request),
              status: 'running',
              startedAt: Date.now(),
            };
            await upsertStep(step);
            yield { type: 'step.started', runId, messageId: agentMessage.id, step };
            yield {
              type: 'question.asked',
              runId,
              messageId: agentMessage.id,
              request: event.request,
            };
            break;
          }

          case 'question.answered': {
            if (run.pendingQuestionId === event.requestId) {
              run.pendingQuestionId = null;
            }
            const asked = steps.find((item) => item.id === event.requestId);
            const startedAt = asked?.startedAt ?? Date.now();
            const step: AgentStep = {
              id: event.requestId,
              sessionId: session.id,
              kind: 'question',
              tool: 'Question',
              title: asked?.title ?? '',
              detail: summarizeAnswers(event.outcome),
              status: event.outcome.type === 'cancelled' ? 'failed' : 'done',
              startedAt,
              durationMs: Date.now() - startedAt,
            };
            await upsertStep(step);
            yield { type: 'step.completed', runId, messageId: agentMessage.id, step };
            yield { type: 'question.closed', runId, requestId: event.requestId };
            break;
          }

          case 'thought': {
            // Raciocínio chega já concluído: só o par tempo/ordem interessa.
            const step: AgentStep = {
              id: newId('step'),
              sessionId: session.id,
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
      // Antes de encerrar o processo, guarda a chave que retoma esta conversa:
      // depois do `dispose` o adaptador já não sabe quem ela era.
      const resumeId = adapter.resumeId?.(session.id) ?? null;
      if (resumeId !== null) {
        const current = this.find(conversation.id);
        if (current !== undefined && current.resumeId !== resumeId) {
          await this.replace({ ...current, resumeId });
        }
      }
      await adapter.dispose(session.id);
    }
  }

  /**
   * Larga a sessão do CLI e guarda um resumo para a próxima.
   *
   * A janela de contexto é do processo, não da conversa: quando enche, resumir
   * dentro dela não devolve espaço nenhum. O que devolve é começar outra e
   * levar o resumo junto.
   */
  async startFreshSession(conversationId: string, summary: string): Promise<void> {
    const conversation = this.find(conversationId);
    if (conversation === undefined) {
      return;
    }
    const { resumeId: _dropped, ...rest } = conversation;
    await this.replace(summary.trim() === '' ? rest : { ...rest, carryOver: summary.trim() });
    this.logger.info(`Conversa ${conversationId}: sessão do CLI reiniciada com resumo.`);
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return;
    }
    // Uma pergunta aberta some junto do run: o agente não pode ficar esperando
    // uma resposta que a interface já não mostra.
    if (run.pendingQuestionId !== null) {
      await this.answerQuestion(run.pendingQuestionId, { type: 'cancelled' });
    }
    await this.registry.require(run.agentId).interrupt(run.sessionId);
  }

  /**
   * Entrega ao agente a resposta de uma pergunta aberta. Um `requestId` que não
   * pertence a nenhum run em andamento é descartado — o run pode ter terminado
   * entre o clique do usuário e a chegada da mensagem.
   */
  async answerQuestion(requestId: string, outcome: AgentQuestionOutcome): Promise<void> {
    const run = [...this.runs.values()].find((item) => item.pendingQuestionId === requestId);
    if (run === undefined) {
      this.logger.info(`Resposta descartada: pergunta ${requestId} não está aberta.`);
      return;
    }
    const adapter = this.registry.require(run.agentId);
    if (adapter.answer === undefined) {
      this.logger.warn(`Agente ${adapter.id} perguntou mas não sabe receber a resposta.`);
      return;
    }
    run.pendingQuestionId = null;
    await adapter.answer(run.sessionId, requestId, outcome);
  }

  /** Pergunta aberta de um run, quando há uma. */
  pendingQuestionOf(runId: string): string | null {
    return this.runs.get(runId)?.pendingQuestionId ?? null;
  }

  private find(conversationId: string): Conversation | undefined {
    return this.store.getConversations().find((item) => item.id === conversationId);
  }

  /**
   * Grava um recado do próprio Prometheon na conversa.
   *
   * É como o relatório de um worker que terminou fora do turno chega à tela: a
   * conversa é o lugar onde o trabalho aparece, e um relatório que só existisse
   * no log seria trabalho feito que ninguém vê.
   */
  async appendSystemMessage(conversationId: string, content: string): Promise<ChatMessage> {
    return this.append(conversationId, {
      id: newId('msg'),
      conversationId,
      author: 'system',
      content,
      status: 'sent',
      timestamp: Date.now(),
    });
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
