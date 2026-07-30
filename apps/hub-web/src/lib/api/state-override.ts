import { failure, success, type ApiResult } from './result';

/**
 * FERRAMENTA DE DESENVOLVIMENTO — forçar um estado de tela pela URL.
 *
 * Os sete estados do `Docs/05` precisam ser revisados de tempos em tempos, e
 * vários deles (offline, sem permissão, stale) não acontecem quando se quer.
 * Com o app fora de produção, `?state=offline` faz a camada de dados devolver
 * aquele estado — sem derrubar a rede nem mexer no banco.
 *
 * **Em produção o parâmetro é ignorado**: `readForcedState` devolve `undefined`
 * e nada disto participa da execução. Isso não é um recurso do produto; é uma
 * lupa para quem está desenvolvendo a interface.
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
  enabled: boolean,
): ForcedState | undefined {
  if (!enabled || !searchParams) {
    return undefined;
  }
  const raw = searchParams.state;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isForcedState(value) ? value : undefined;
}

/** Atalho das telas: só vale fora de produção. */
export function devForcedState(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): ForcedState | undefined {
  return readForcedState(searchParams, process.env.NODE_ENV !== 'production');
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
        code: 'INTERNAL_ERROR',
        message: 'Estado forçado pela URL, em desenvolvimento.',
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
