import type { CustomAgentRole, HubConnectionStatus } from '../core/types';
import { HubNotConfiguredError } from '../utils/errors';
import { parseHubUrl } from './HubClient';
import type {
  HubClient,
  HubConnectionConfig,
  HubConversation,
  HubMessage,
  HubProject,
  HubSubscription,
} from './types';

/**
 * Implementação usada enquanto o Hub não existe. Valida a URL informada — para
 * já rejeitar configuração insegura — mas nunca abre conexão nem envia dados.
 */
export class DisabledHubClient implements HubClient {
  getStatus(): HubConnectionStatus {
    return { state: 'local-only' };
  }

  connect(config: HubConnectionConfig): Promise<void> {
    // Valida antes de recusar: erro de URL é mais útil que "não implementado".
    parseHubUrl(config.url);
    return Promise.reject(
      new HubNotConfiguredError(
        'Prometheon Hub ainda não está disponível nesta versão. A configuração foi guardada, mas nenhuma conexão é feita.',
      ),
    );
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  isAuthenticated(): boolean {
    return false;
  }

  // Sem Hub não há projeto nem conversa. Falha em vez de devolver lista vazia:
  // "nenhuma conversa" e "não perguntei a ninguém" são estados diferentes, e
  // confundi-los faria o painel dizer que o histórico está vazio sem saber.
  listProjects(): Promise<readonly HubProject[]> {
    return Promise.reject(new HubNotConfiguredError());
  }

  listConversations(): Promise<readonly HubConversation[]> {
    return Promise.reject(new HubNotConfiguredError());
  }

  getMessages(): Promise<readonly HubMessage[]> {
    return Promise.reject(new HubNotConfiguredError());
  }

  /** Nada guardado, nada a esquecer — sair é sempre um sucesso silencioso. */
  signOut(): Promise<void> {
    return Promise.resolve();
  }

  createConversation(): Promise<HubConversation> {
    return Promise.reject(new HubNotConfiguredError());
  }

  postMessage(): Promise<HubMessage> {
    return Promise.reject(new HubNotConfiguredError());
  }

  // Papéis da equipe vivem na organização do Hub. Sem Hub, o painel continua
  // oferecendo os escopos de projeto e de máquina — só o de equipe fica fora.
  listAgentRoles(): Promise<readonly CustomAgentRole[]> {
    return Promise.reject(new HubNotConfiguredError());
  }

  saveAgentRoles(): Promise<readonly CustomAgentRole[]> {
    return Promise.reject(new HubNotConfiguredError());
  }

  subscribe(): Promise<HubSubscription> {
    return Promise.reject(new HubNotConfiguredError());
  }
}
