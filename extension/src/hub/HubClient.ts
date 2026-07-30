import { PrometheonError } from '../utils/errors';

export class InvalidHubUrlError extends PrometheonError {
  constructor(message: string) {
    super(message, 'hub.invalid-url');
  }
}

const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Valida a URL do Hub antes de qualquer uso. HTTP só é aceito em localhost;
 * qualquer Hub remoto exige HTTPS.
 */
export function parseHubUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InvalidHubUrlError('Informe a URL do Prometheon Hub.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidHubUrlError(`URL inválida: ${trimmed}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidHubUrlError(`Protocolo não suportado: ${url.protocol}`);
  }

  const isLocal = LOCAL_HOSTNAMES.includes(url.hostname);
  if (url.protocol === 'http:' && !isLocal) {
    throw new InvalidHubUrlError('Hubs remotos exigem HTTPS. HTTP é permitido apenas em localhost.');
  }

  if (url.username !== '' || url.password !== '') {
    throw new InvalidHubUrlError('Não coloque credenciais na URL do Hub.');
  }

  return url;
}

export type { HubClient, HubConnectionConfig } from './types';
