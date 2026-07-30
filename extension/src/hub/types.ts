import type { HubConnectionStatus } from '../core/types';

export interface HubConnectionConfig {
  /** URL base da API do Hub. HTTPS obrigatório fora de localhost. */
  readonly url: string;
}

/**
 * Contrato do cliente do Prometheon Hub. A extensão fala apenas com a API
 * HTTPS/WebSocket do Hub — nunca com MySQL, Redis ou qualquer banco.
 */
export interface HubClient {
  getStatus(): HubConnectionStatus;
  connect(config: HubConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  isAuthenticated(): boolean;
}
