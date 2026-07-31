import type { CustomAgentRole, HubConnectionStatus } from '../core/types';

export interface HubConnectionConfig {
  /** URL base da API do Hub. HTTPS obrigatório fora de localhost. */
  readonly url: string;
}

/**
 * Projeto do Hub, reduzido ao que a extensão exibe.
 *
 * Conversa do Web Chat mora dentro de um projeto (`/projects/:id/conversations`),
 * então escolher o projeto é pré-requisito para listar qualquer coisa.
 */
export interface HubProject {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** Conversa do Hub, com o que a lista de sessões precisa mostrar. */
export interface HubConversation {
  readonly id: string;
  readonly title: string;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Mensagem do Hub já achatada para o formato do painel.
 *
 * O Hub guarda a mensagem em envelope + partes ordenadas; a extensão exibe um
 * texto por mensagem. A junção das partes acontece aqui, no transporte, e não
 * na interface — a webview recebe conteúdo pronto, como todo o resto.
 */
export interface HubMessage {
  readonly id: string;
  readonly authorType: 'user' | 'agent' | 'system';
  readonly authorName: string | null;
  readonly content: string;
  readonly status: 'pending' | 'streaming' | 'complete' | 'failed' | 'cancelled' | 'redacted';
  readonly createdAt: number;
}

/**
 * Contrato do cliente do Prometheon Hub. A extensão fala apenas com a API
 * HTTPS/WebSocket do Hub — nunca com MySQL, Redis ou qualquer banco.
 */
/**
 * Evento do canal de tempo real, reduzido ao que o chat consome.
 *
 * O Hub publica `message.created` e `message.updated` — não existe delta por
 * token no contrato. O Web Chat, portanto, atualiza por mensagem, e não letra a
 * letra como o agente local.
 */
export interface HubRealtimeEvent {
  readonly type: string;
  readonly conversationId: string | null;
  readonly messageId: string | null;
}

/** Assinatura viva do canal; `close` desfaz tudo o que ela abriu. */
export interface HubSubscription {
  close(): void;
}

export interface HubClient {
  getStatus(): HubConnectionStatus;
  connect(config: HubConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  isAuthenticated(): boolean;
  /**
   * Esquece a credencial deste dispositivo.
   *
   * Só apaga o que está nesta máquina. Revogar o dispositivo do lado do Hub é
   * outra operação, feita na conta — e dizer isso importa: quem sai daqui não
   * deve achar que derrubou a sessão em todo lugar.
   */
  signOut(): Promise<void>;
  /** Projetos visíveis para esta credencial, para escolher onde conversar. */
  listProjects(): Promise<readonly HubProject[]>;
  listConversations(projectId: string): Promise<readonly HubConversation[]>;
  getMessages(conversationId: string): Promise<readonly HubMessage[]>;
  createConversation(projectId: string, title: string): Promise<HubConversation>;
  /** Grava a mensagem do usuário e devolve o que o Hub registrou. */
  postMessage(conversationId: string, content: string): Promise<HubMessage>;
  /** Papéis de agente compartilhados pela organização. */
  listAgentRoles(): Promise<readonly CustomAgentRole[]>;
  /**
   * Grava a lista inteira e devolve o que o Hub passou a ter. É substituição em
   * bloco porque a interface edita a lista como um todo; o retorno é a fonte de
   * verdade, não o que foi enviado.
   */
  saveAgentRoles(roles: readonly CustomAgentRole[]): Promise<readonly CustomAgentRole[]>;
  /** Escuta o canal de tempo real da organização até `close`. */
  subscribe(onEvent: (event: HubRealtimeEvent) => void): Promise<HubSubscription>;
}
