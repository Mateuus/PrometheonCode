import type { HubClient } from '../hub/types';
import { HubNotConfiguredError } from '../utils/errors';
import { newId } from '../utils/ids';
import { UNTITLED } from './LocalChatService';
import type {
  ChatEvent,
  ChatMessage,
  ChatService,
  Conversation,
  ConversationSummary,
  CreateConversationInput,
  MessageAuthor,
  MessageStatus,
  SendMessageInput,
} from './types';

/**
 * Chat associado ao Prometheon Hub.
 *
 * Lê do Hub pelas rotas de conversa e mensagem; a escrita ainda não passa por
 * aqui. O que não está implementado **falha** em vez de responder vazio: um
 * histórico que parece vazio e um Hub que não foi consultado são coisas
 * diferentes, e confundi-las esconderia o problema em vez de mostrá-lo.
 *
 * Nada nesta classe conhece MySQL, Redis ou o schema do Hub — só a API.
 */
export class WebChatService implements ChatService {
  /** Projeto onde as conversas do Web Chat moram; escolhido no painel. */
  private projectId: string | null = null;

  constructor(private readonly hub: HubClient) {}

  setProject(projectId: string | null): void {
    this.projectId = projectId;
  }

  get selectedProject(): string | null {
    return this.projectId;
  }

  /**
   * Conversas do projeto escolhido.
   *
   * Sem Hub conectado ou sem projeto, a lista é vazia — e é vazia de verdade:
   * não há o que listar. É diferente de uma falha de rede, que sobe como erro
   * para o núcleo registrar e a interface mostrar.
   */
  async listConversations(): Promise<ConversationSummary[]> {
    if (!this.hub.isAuthenticated() || this.projectId === null) {
      return [];
    }

    const conversations = await this.hub.listConversations(this.projectId);

    return conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      chatType: 'web' as const,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messageCount,
    }));
  }

  async getMessages(conversationId: string): Promise<ChatMessage[]> {
    if (!this.hub.isAuthenticated()) {
      throw new HubNotConfiguredError();
    }

    const messages = await this.hub.getMessages(conversationId);

    return messages.map((message) => ({
      id: message.id,
      conversationId,
      author: authorOf(message.authorType),
      ...(message.authorName === null ? {} : { agentName: message.authorName }),
      content: message.content,
      status: statusOf(message.status),
      timestamp: message.createdAt,
    }));
  }

  async createConversation(_input: CreateConversationInput): Promise<Conversation> {
    if (this.projectId === null) {
      throw new HubNotConfiguredError('Pick a Hub project before starting a web conversation.');
    }

    const created = await this.hub.createConversation(this.projectId, UNTITLED);

    return {
      id: created.id,
      title: created.title,
      chatType: 'web',
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      messageCount: created.messageCount,
      messages: [],
    };
  }

  /**
   * Apagar uma conversa do Hub exige falar com o Hub. Sem a rota implementada,
   * isso falha em vez de responder "pronto" — dizer que uma conversa remota foi
   * apagada sem ter apagado nada é a pior resposta possível a esse pedido.
   */
  deleteConversation(_conversationId: string): Promise<void> {
    return Promise.reject(new HubNotConfiguredError());
  }

  /**
   * Envia ao Hub e acompanha o que ele publicar em resposta.
   *
   * Quem executa o agente é o Hub, não a extensão: aqui a mensagem é gravada e
   * o canal de tempo real é escutado até o Hub parar de falar. **Não há delta
   * por token** — o Hub publica `message.created`/`message.updated`, então a
   * resposta aparece por mensagem, e cada uma é relida por inteiro quando o
   * evento chega.
   *
   * O run termina por silêncio: passado `QUIET_MS` sem evento novo, o Hub
   * acabou de responder ou não vai responder. Sem um evento de fim no contrato,
   * esperar para sempre deixaria o painel travado no "trabalhando".
   */
  async *sendMessage(input: SendMessageInput): AsyncIterable<ChatEvent> {
    if (!this.hub.isAuthenticated()) {
      throw new HubNotConfiguredError();
    }

    const runId = newId('run');
    const stored = await this.hub.postMessage(input.conversationId, input.content);

    yield {
      type: 'run.started',
      runId,
      message: {
        id: stored.id,
        conversationId: input.conversationId,
        author: 'user',
        content: input.content,
        status: 'sent',
        timestamp: stored.createdAt,
      },
    };

    const inbox = new EventInbox();
    const subscription = await this.hub.subscribe((event) => {
      // Evento de outra conversa é ruído: o canal é da organização inteira.
      if (event.conversationId === input.conversationId) {
        inbox.push(event.type);
      }
    });

    const delivered = new Set<string>([stored.id]);

    try {
      while (await inbox.waitForActivity(QUIET_MS)) {
        for (const message of await this.getMessages(input.conversationId)) {
          if (delivered.has(message.id)) {
            continue;
          }
          delivered.add(message.id);
          yield { type: 'message.created', runId, message };
        }
      }
    } finally {
      subscription.close();
    }
    // Sem evento de fim: o run acaba quando o gerador acaba. Cada mensagem já
    // saiu daqui pronta, relida do Hub — não há nada pendente para fechar.
  }

  /**
   * Interromper um run do Hub exige uma rota que ainda não existe. Falha em vez
   * de fingir: dizer que parou sem ter parado deixaria o agente trabalhando (e
   * gastando) enquanto o painel afirma o contrário.
   */
  cancel(_runId: string): Promise<void> {
    return Promise.reject(new HubNotConfiguredError());
  }
}

/**
 * Silêncio que encerra o run.
 *
 * Não existe evento de "terminei" no contrato do Hub. Este é o tempo que se
 * espera por um evento novo antes de considerar a resposta pronta — curto
 * demais cortaria a resposta pela metade, longo demais deixaria o painel
 * girando muito depois de o Hub ter acabado.
 */
const QUIET_MS = 20_000;

/**
 * Caixa de entrada dos eventos do canal.
 *
 * Existe para separar "chegou algo" de "o quê": o gerador acorda a cada
 * atividade e relê a conversa, em vez de tentar reconstruir o estado a partir
 * de eventos soltos — que é onde uma perda de evento viraria uma mensagem que
 * nunca aparece.
 */
export class EventInbox {
  private pending = 0;
  private wake: (() => void) | null = null;

  push(_type: string): void {
    this.pending += 1;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** `true` quando houve atividade; `false` quando o silêncio venceu. */
  async waitForActivity(timeoutMs: number): Promise<boolean> {
    if (this.pending > 0) {
      this.pending = 0;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(false);
      }, timeoutMs);

      this.wake = () => {
        clearTimeout(timer);
        this.pending = 0;
        resolve(true);
      };
    });
  }
}

/** `system` do Hub não tem equivalente no painel; entra como agente. */
function authorOf(authorType: 'user' | 'agent' | 'system'): MessageAuthor {
  return authorType === 'user' ? 'user' : 'agent';
}

function statusOf(status: string): MessageStatus {
  switch (status) {
    case 'streaming':
      return 'streaming';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'sent';
  }
}
