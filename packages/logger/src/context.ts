/**
 * Contexto de log propagado por `AsyncLocalStorage`.
 *
 * A ideia é não passar logger de mão em mão: a borda HTTP (ou o worker de job)
 * abre um escopo com `runWithLogContext`, e qualquer `logger.info` disparado lá
 * dentro — inclusive dentro de `await` e de callbacks — sai carimbado com o
 * mesmo `requestId` e `correlationId`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  /** Identificador da requisição HTTP/WS corrente. */
  readonly requestId?: string | undefined;
  /** Identificador que atravessa serviços, vindo do cliente quando existe. */
  readonly correlationId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly userId?: string | undefined;
  readonly deviceId?: string | undefined;
  /** Nome do job ou da rota, útil para agrupar métricas em log. */
  readonly operation?: string | undefined;
}

type MutableLogContext = { -readonly [K in keyof LogContext]: LogContext[K] };

const storage = new AsyncLocalStorage<MutableLogContext>();

/** Remove chaves indefinidas para não poluir a linha de log. */
function compact(context: LogContext): MutableLogContext {
  const result: MutableLogContext = {};

  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) {
      result[key as keyof MutableLogContext] = value as string;
    }
  }

  return result;
}

/**
 * Contexto ativo, ou objeto vazio quando não há escopo aberto.
 *
 * A cópia é obrigatória: o `mixin` do Pino faz `Object.assign` no objeto que
 * recebe, e devolver o store direto faria os campos de uma linha de log
 * grudarem no contexto e reaparecerem em todas as linhas seguintes.
 */
export function getLogContext(): LogContext {
  const store = storage.getStore();

  return store === undefined ? {} : { ...store };
}

/**
 * Abre um escopo. O contexto herda o escopo externo, então aninhar é seguro:
 * o interno só acrescenta ou sobrescreve o que informar.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...getLogContext(), ...compact(context) };

  return storage.run(compact(merged), fn);
}

/**
 * Acrescenta campos ao escopo já aberto. Serve para o que só se descobre no
 * meio da requisição — o `organizationId` depois da autenticação, por exemplo.
 *
 * @returns `false` quando não há escopo aberto e nada foi registrado.
 */
export function updateLogContext(patch: LogContext): boolean {
  const store = storage.getStore();

  if (store === undefined) {
    return false;
  }

  Object.assign(store, compact(patch));

  return true;
}

/**
 * Congela o contexto atual dentro de uma função, para reaplicá-lo quando ela
 * for chamada mais tarde (fila, timer, listener de evento).
 */
export function bindLogContext<A extends readonly unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const captured = getLogContext();

  return (...args: A): R => runWithLogContext(captured, () => fn(...args));
}
