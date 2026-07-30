/**
 * Resultado de uma leitura da Hub API, no formato que as telas consomem.
 *
 * O tipo é discriminado de propósito: cada um dos estados obrigatórios do
 * `Docs/05` vira um caso que o TypeScript obriga a tratar. Uma tela não
 * consegue "esquecer" o caso offline ou o sem permissão, porque o
 * `<DataView>` não compila sem eles.
 */

export type ApiFailureKind =
  /** A API respondeu erro, ou a resposta veio fora do contrato. */
  | 'error'
  /** A API não foi alcançada — rede caiu, DNS falhou, timeout. */
  | 'offline'
  /** Autenticado, mas o papel não permite. */
  | 'forbidden'
  /** Sem sessão válida; a tela manda para o login. */
  | 'unauthorized'
  /** O recurso pedido não existe. */
  | 'not-found';

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  /** Quando o dado foi lido, em ISO 8601 UTC. */
  fetchedAt: string;
  /**
   * `true` quando veio de cache porque a origem falhou. A tela continua útil,
   * mas precisa dizer ao usuário que o número pode estar velho.
   */
  stale: boolean;
}

export interface ApiFailure {
  ok: false;
  kind: ApiFailureKind;
  /** Código do contrato de erro da API, ex.: `PROJECT_ACCESS_DENIED`. */
  code?: string;
  message?: string;
  requestId?: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function success<T>(data: T, options?: { stale?: boolean; fetchedAt?: string }): ApiSuccess<T> {
  return {
    ok: true,
    data,
    fetchedAt: options?.fetchedAt ?? new Date().toISOString(),
    stale: options?.stale ?? false,
  };
}

export function failure(kind: ApiFailureKind, details?: Omit<ApiFailure, 'ok' | 'kind'>): ApiFailure {
  return { ok: false, kind, ...details };
}

/** Aplica uma transformação sem perder os metadados de frescor. */
export function mapResult<T, U>(result: ApiResult<T>, transform: (value: T) => U): ApiResult<U> {
  return result.ok ? { ...result, data: transform(result.data) } : result;
}
