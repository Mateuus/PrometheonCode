/**
 * Avaliação de segredos.
 *
 * Um segredo do Prometheon precisa carregar pelo menos 32 bytes de entropia.
 * A string pode chegar em hex, base64/base64url ou texto puro; a checagem
 * decodifica quando reconhece o formato e, no pior caso, conta os bytes UTF-8.
 */

export const MIN_SECRET_BYTES = 32;

/** Quantidade mínima de caracteres distintos aceita num segredo. */
const MIN_DISTINCT_CHARACTERS = 12;

const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Valores manjados que jamais devem passar, mesmo que tenham comprimento
 * suficiente. A comparação é feita em minúsculas.
 */
const FORBIDDEN_FRAGMENTS = [
  'changeme',
  'change-me',
  'placeholder',
  'insecure',
  'password',
  'secret-secret',
  'replace-me',
  'todo',
  'xxxxxxxx',
  'aaaaaaaa',
  '00000000',
  '12345678',
];

/** Número de bytes que a string representa, decodificando quando possível. */
export function secretEntropyBytes(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  if (value.length % 2 === 0 && HEX_PATTERN.test(value)) {
    return value.length / 2;
  }

  if (BASE64URL_PATTERN.test(value) || BASE64_PATTERN.test(value)) {
    const decoded = Buffer.from(value, 'base64');

    // O decodificador do Node é tolerante: só confiamos no resultado quando o
    // tamanho bate com o esperado para a codificação.
    // `={1,2}` e não `=+`: o padding de base64 tem no máximo dois sinais — o
    // `BASE64_PATTERN` acima já garante isso — e o quantificador aberto dava
    // backtracking quadrático numa string cheia de `=`.
    const withoutPadding = value.replace(/={1,2}$/, '');
    const expected = Math.floor((withoutPadding.length * 3) / 4);

    if (decoded.length === expected && decoded.length > 0) {
      return decoded.length;
    }
  }

  return Buffer.byteLength(value, 'utf8');
}

export type SecretAssessment =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

/** Avalia um segredo sem nunca devolver o valor recebido na mensagem. */
export function assessSecret(value: string): SecretAssessment {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'is required and must not be empty' };
  }

  if (trimmed !== value) {
    return {
      ok: false,
      reason: 'must not start or end with whitespace',
    };
  }

  const lowered = trimmed.toLowerCase();
  const forbidden = FORBIDDEN_FRAGMENTS.find((fragment) =>
    lowered.includes(fragment),
  );

  if (forbidden !== undefined) {
    return {
      ok: false,
      reason: 'looks like a placeholder; generate a real random value',
    };
  }

  const distinct = new Set(trimmed).size;

  if (distinct < MIN_DISTINCT_CHARACTERS) {
    return {
      ok: false,
      reason: `has too little variation (${String(distinct)} distinct characters, at least ${String(MIN_DISTINCT_CHARACTERS)} expected)`,
    };
  }

  const bytes = secretEntropyBytes(trimmed);

  if (bytes < MIN_SECRET_BYTES) {
    return {
      ok: false,
      reason: `carries about ${String(bytes)} bytes of entropy, at least ${String(MIN_SECRET_BYTES)} required (generate with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")`,
    };
  }

  return { ok: true, bytes };
}
