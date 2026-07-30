import { failure, success, type ApiResult } from './result';

/**
 * PROVISÓRIO — forçar um estado de tela pela URL.
 *
 * Os sete estados do `Docs/05` precisam ser vistos e revisados antes de a Hub
 * API existir, e vários deles (offline, sem permissão, stale) não acontecem
 * quando se quer. Com os dados de exemplo ligados, `?state=offline` faz a
 * camada de dados devolver aquele estado.
 *
 * Só funciona quando `HUB_WEB_SAMPLE_DATA` está ligado. Com a API de verdade,
 * `readForcedState` devolve `undefined` e nada disso participa da execução.
 */

export const FORCED_STATES = [
  'loading',
  'empty',
  'error',
  'offline',
  'forbidden',
  'unauthorized',
  'reconnecting',
  'stale',
] as const;

export type ForcedState = (typeof FORCED_STATES)[number];

export function isForcedState(value: unknown): value is ForcedState {
  return typeof value === 'string' && (FORCED_STATES as readonly string[]).includes(value);
}

/** Lê `?state=` de um `searchParams` já resolvido. */
export function readForcedState(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  sampleDataEnabled: boolean,
): ForcedState | undefined {
  if (!sampleDataEnabled || !searchParams) {
    return undefined;
  }
  const raw = searchParams.state;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isForcedState(value) ? value : undefined;
}

/**
 * Aplica o estado forçado sobre um resultado bem-sucedido.
 * `emptyValue` é o que a tela mostra quando a coleção volta vazia.
 */
export async function applyForcedState<T>(
  forced: ForcedState | undefined,
  result: ApiResult<T>,
  emptyValue?: T,
): Promise<ApiResult<T>> {
  switch (forced) {
    case undefined:
      return result;
    case 'loading':
      // Segura a resposta para o `loading.tsx` ficar visível o tempo da revisão.
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      return result;
    case 'empty':
      return emptyValue === undefined ? result : success(emptyValue);
    case 'error':
      return failure('error', {
        code: 'HUB_INTERNAL_ERROR',
        message: 'Sample failure requested by the URL.',
        requestId: '01JB7Q4X2NREQUESTIDSAMPLE',
      });
    case 'offline':
      return failure('offline');
    case 'forbidden':
      return failure('forbidden', { code: 'PROJECT_ACCESS_DENIED' });
    case 'unauthorized':
      return failure('unauthorized', { code: 'SESSION_EXPIRED' });
    case 'reconnecting':
      // Reconectando é estado do canal ao vivo: o dado carregado continua bom.
      return result;
    case 'stale':
      return result.ok
        ? { ...result, stale: true, fetchedAt: new Date(Date.now() - 18 * 60_000).toISOString() }
        : result;
  }
}
