/**
 * Redaction em profundidade.
 *
 * A opção `redact` do Pino trabalha com caminhos fixos, e o que precisamos é
 * mais forte: qualquer chave sensível, em qualquer nível, dentro de qualquer
 * objeto ou array. Por isso o redator é aplicado como `formatters.log`, que
 * recebe o objeto já mesclado, logo antes da serialização.
 */

export const REDACTED = '[REDACTED]';
export const CIRCULAR = '[Circular]';
export const TRUNCATED = '[Truncated]';

/** Nomes de campo que devem sumir do log, em qualquer profundidade. */
export const DEFAULT_SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^auth$/,
  /authorization$/,
  /^cookie$/,
  /^setcookie$/,
  /password/,
  /passwd/,
  /passphrase/,
  /token/,
  /secret/,
  /apikey/,
  /accesskey/,
  /privatekey/,
  /credential/,
  /^sessionid$/,
  /^sid$/,
  /^otp$/,
  /^pin$/,
  /^signature$/,
  /^xhubsignature/,
  /masterkey/,
  /^bearer$/,
];

/**
 * Campos que casariam com os padrões acima mas não carregam segredo nenhum.
 * Contagem de tokens de modelo é o caso recorrente neste projeto.
 */
export const DEFAULT_ALLOWED_KEYS: readonly string[] = [
  'tokens',
  'tokencount',
  'tokensused',
  'tokenusage',
  'totaltokens',
  'inputtokens',
  'outputtokens',
  'prompttokens',
  'completiontokens',
  'maxtokens',
  'tokenlimit',
  'tokentype',
  'tokensremaining',
  'hastoken',
  'tokenexpiresat',
  'passwordupdatedat',
  'secretcount',
];

/** JWT compacto: três segmentos base64url separados por ponto. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
/** Cabeçalho `Authorization` colado dentro de uma string livre. */
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export interface DeepRedactorOptions {
  /**
   * Converte um `Error` em objeto simples antes da redaction.
   *
   * O Pino aplica `formatters.log` **antes** dos serializers, então quem
   * encontra o `Error` primeiro é este redator; se ele apenas copiasse as
   * propriedades enumeráveis, `message` e `stack` se perderiam.
   */
  readonly transformError?: (error: Error) => Record<string, unknown>;
  /** Padrões adicionais, somados aos padrões padrão. */
  readonly patterns?: readonly RegExp[];
  /** Chaves liberadas, somadas à lista padrão. */
  readonly allowedKeys?: readonly string[];
  /** Profundidade máxima antes de cortar. Padrão: 12. */
  readonly maxDepth?: number;
  /** Também procura credenciais dentro de strings livres. Padrão: `true`. */
  readonly scanStrings?: boolean;
  /** Texto usado no lugar do valor. Padrão: `[REDACTED]`. */
  readonly censor?: string;
}

/** `X-Api-Key`, `x_api_key` e `apiKey` viram a mesma coisa. */
export function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export interface DeepRedactor {
  (value: unknown): unknown;
  readonly isSensitiveKey: (key: string) => boolean;
}

export function createDeepRedactor(
  options: DeepRedactorOptions = {},
): DeepRedactor {
  const patterns = [...DEFAULT_SENSITIVE_PATTERNS, ...(options.patterns ?? [])];
  const allowed = new Set(
    [...DEFAULT_ALLOWED_KEYS, ...(options.allowedKeys ?? [])].map(normalizeKey),
  );
  const maxDepth = options.maxDepth ?? 12;
  const scanStrings = options.scanStrings ?? true;
  const censor = options.censor ?? REDACTED;
  const transformError = options.transformError;

  const isSensitiveKey = (key: string): boolean => {
    const normalized = normalizeKey(key);

    if (normalized.length === 0 || allowed.has(normalized)) {
      return false;
    }

    return patterns.some((pattern) => pattern.test(normalized));
  };

  const scrubString = (value: string): string => {
    if (!scanStrings) {
      return value;
    }

    return value.replace(JWT_PATTERN, censor).replace(BEARER_PATTERN, (match) => {
      const scheme = match.split(/\s+/)[0] ?? '';

      return `${scheme} ${censor}`;
    });
  };

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') {
      return scrubString(value);
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (depth >= maxDepth) {
      return TRUNCATED;
    }

    if (seen.has(value)) {
      return CIRCULAR;
    }

    // Tipos que o serializador do Pino já entende e que não escondem chaves.
    if (
      value instanceof Date ||
      value instanceof RegExp ||
      Buffer.isBuffer(value)
    ) {
      return value;
    }

    seen.add(value);

    if (value instanceof Error && transformError !== undefined) {
      try {
        return walk(transformError(value), depth + 1, seen);
      } finally {
        seen.delete(value);
      }
    }

    try {
      if (Array.isArray(value)) {
        return value.map((item) => walk(item, depth + 1, seen));
      }

      const result: Record<string, unknown> = {};

      for (const [key, nested] of Object.entries(
        value as Record<string, unknown>,
      )) {
        result[key] = isSensitiveKey(key) ? censor : walk(nested, depth + 1, seen);
      }

      return result;
    } finally {
      seen.delete(value);
    }
  };

  const redactor = (value: unknown): unknown => walk(value, 0, new WeakSet());

  return Object.assign(redactor, { isSensitiveKey });
}

/** Redator com as opções padrão, suficiente para a maioria dos usos. */
export const redactDeep: DeepRedactor = createDeepRedactor();
