import type { HubClient } from '../hub/types';
import { HubNotConfiguredError } from '../utils/errors';
import type {
  ChatEvent,
  ChatMessage,
  ChatService,
  Conversation,
  ConversationSummary,
  CreateConversationInput,
  SendMessageInput,
} from './types';

/**
 * Chat associado ao Prometheon Hub. Enquanto o Hub não estiver configurado, todas
 * as operações falham com `HubNotConfiguredError` — nada é enviado para fora e
 * nenhuma conexão é simulada.
 */
export class WebChatService implements ChatService {
  // O cliente do Hub é recebido para quando o transporte remoto existir; hoje
  // nenhuma operação chega a usá-lo, porque todas param antes de sair da máquina.
  constructor(_hub: HubClient) {}

  listConversations(): Promise<ConversationSummary[]> {
    // Listar é inofensivo: sem Hub, simplesmente não há conversas remotas.
    // Com Hub configurado ainda não há transporte implementado, então a lista
    // também vem vazia — nunca simulamos sessões remotas.
    return Promise.resolve([]);
  }

  createConversation(_input: CreateConversationInput): Promise<Conversation> {
    return Promise.reject(new HubNotConfiguredError());
  }

  getMessages(_conversationId: string): Promise<ChatMessage[]> {
    return Promise.reject(new HubNotConfiguredError());
  }

  /**
   * Sem Hub não existe stream para consumir: a primeira iteração já rejeita.
   * Não é um gerador porque não há nenhum valor a produzir antes da falha.
   */
  sendMessage(_input: SendMessageInput): AsyncIterable<ChatEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<ChatEvent> => ({
        next: () => Promise.reject(new HubNotConfiguredError()),
      }),
    };
  }

  cancel(_runId: string): Promise<void> {
    return Promise.reject(new HubNotConfiguredError());
  }
}
