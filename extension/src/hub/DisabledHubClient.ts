import type { HubConnectionStatus } from '../core/types';
import { HubNotConfiguredError } from '../utils/errors';
import { parseHubUrl } from './HubClient';
import type { HubClient, HubConnectionConfig } from './types';

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
}
