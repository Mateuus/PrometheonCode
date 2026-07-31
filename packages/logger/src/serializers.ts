/**
 * Serializador de erro.
 *
 * Preserva `code` e a cadeia de `cause` — que é justamente o que some quando se
 * loga só `error.message` — e omite a pilha em produção, onde ela expõe caminho
 * de arquivo e estrutura interna sem ajudar quem lê o log agregado.
 */

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string | number | undefined;
  readonly statusCode?: number | undefined;
  readonly stack?: string | undefined;
  readonly cause?: SerializedError | string | undefined;
  readonly errors?: readonly (SerializedError | string)[] | undefined;
  readonly [key: string]: unknown;
}

export interface ErrorSerializerOptions {
  /** Inclui `stack`. Padrão: `true` fora de produção. */
  readonly includeStack?: boolean;
  /** Quantos níveis de `cause` percorrer. Padrão: 5. */
  readonly maxCauseDepth?: number;
}

const IGNORED_OWN_PROPERTIES = new Set([
  'message',
  'stack',
  'cause',
  'name',
  'errors',
]);

function isError(value: unknown): value is Error {
  return value instanceof Error;
}

export function createErrorSerializer(
  options: ErrorSerializerOptions = {},
): (value: unknown) => SerializedError {
  const includeStack = options.includeStack ?? true;
  const maxCauseDepth = options.maxCauseDepth ?? 5;

  const serialize = (
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
  ): SerializedError => {
    if (!isError(value)) {
      return {
        type: typeof value,
        message: typeof value === 'string' ? value : String(value),
      };
    }

    if (seen.has(value)) {
      return { type: value.name, message: '[Circular error reference]' };
    }

    seen.add(value);

    const record = value as unknown as Record<string, unknown>;
    const extras: Record<string, unknown> = {};

    for (const key of Object.keys(record)) {
      if (IGNORED_OWN_PROPERTIES.has(key) || key === 'code' || key === 'statusCode') {
        continue;
      }

      extras[key] = record[key];
    }

    const rawCode = record['code'];
    const code =
      typeof rawCode === 'string' || typeof rawCode === 'number'
        ? rawCode
        : undefined;
    const rawStatus = record['statusCode'];
    const statusCode = typeof rawStatus === 'number' ? rawStatus : undefined;

    const cause =
      depth < maxCauseDepth && value.cause !== undefined
        ? serialize(value.cause, depth + 1, seen)
        : undefined;

    const aggregated = record['errors'];
    const errors =
      Array.isArray(aggregated) && depth < maxCauseDepth
        ? aggregated.map((item) => serialize(item, depth + 1, seen))
        : undefined;

    return {
      ...extras,
      type: value.name,
      message: value.message,
      ...(code !== undefined ? { code } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(includeStack && value.stack !== undefined ? { stack: value.stack } : {}),
      ...(cause !== undefined ? { cause } : {}),
      ...(errors !== undefined ? { errors } : {}),
    };
  };

  return (value: unknown): SerializedError => serialize(value, 0, new WeakSet());
}

/** Serializador com pilha, adequado a desenvolvimento e teste. */
export const serializeError = createErrorSerializer();
