import { DEFAULT_HUB_URL } from '../constants';
import { t } from '../i18n';
import { PrometheonError } from '../utils/errors';

export class InvalidHubUrlError extends PrometheonError {
  constructor(message: string) {
    super(message, 'hub.invalid-url');
  }
}

const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * URL efetiva do Hub: a configurada pelo usuário ou, em branco, o Hub oficial.
 * Em branco é o caso comum — entrar não pede endereço; a configuração fica para
 * quem hospeda o próprio Hub.
 */
export function resolveHubUrl(configured: string): string {
  const trimmed = configured.trim();
  return trimmed === '' ? DEFAULT_HUB_URL : trimmed;
}

/**
 * Valida a URL do Hub antes de qualquer uso. HTTP só é aceito em localhost;
 * qualquer Hub remoto exige HTTPS.
 */
export function parseHubUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InvalidHubUrlError(t('Enter the Prometheon Hub URL.'));
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidHubUrlError(t('Invalid URL: {0}', trimmed));
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidHubUrlError(t('Unsupported protocol: {0}', url.protocol));
  }

  const isLocal = LOCAL_HOSTNAMES.includes(url.hostname);
  if (url.protocol === 'http:' && !isLocal) {
    throw new InvalidHubUrlError(
      t('Remote Hubs require HTTPS. HTTP is allowed only on localhost.'),
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new InvalidHubUrlError(t('Do not put credentials in the Hub URL.'));
  }

  return url;
}

export type { HubClient, HubConnectionConfig, HubConnectOptions } from './types';
