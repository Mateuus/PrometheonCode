/**
 * Relaxamento explícito para `NODE_ENV=test`.
 *
 * Testes precisam rodar sem `.env` completo, então geramos segredos derivados
 * de um rótulo fixo — determinísticos, com 32 bytes, e reconhecíveis. Fora de
 * `test` este módulo nunca é chamado, e `assertNoTestSecrets` reprova a
 * configuração caso um desses valores apareça em qualquer outro ambiente.
 */

import { createHash } from 'node:crypto';

import type { ConfigIssue } from './errors.js';

/** Chaves de segredo que ganham valor de teste quando ausentes. */
export const TEST_SECRET_KEYS = [
  'AUTH_ACCESS_TOKEN_SECRET',
  'AUTH_REFRESH_TOKEN_SECRET',
  'AUTH_REALTIME_TOKEN_SECRET',
  'SECRETS_MASTER_KEY',
] as const;

export type TestSecretKey = (typeof TEST_SECRET_KEYS)[number];

/** Deriva o segredo de teste de uma chave. 32 bytes em base64url. */
export function testSecretFor(key: TestSecretKey): string {
  return createHash('sha256')
    .update(`prometheon/test-only-value/${key}`)
    .digest('base64url');
}

const TEST_SECRET_VALUES: ReadonlySet<string> = new Set(
  TEST_SECRET_KEYS.map(testSecretFor),
);

/** Valores mínimos de banco para que a suíte suba sem MySQL configurado. */
const TEST_DATABASE_FALLBACKS: Readonly<Record<string, string>> = {
  DATABASE_HOST: '127.0.0.1',
  DATABASE_USER: 'prometheon_test',
  DATABASE_NAME: 'prometheon_test',
};

/**
 * Preenche o que faltar para o ambiente de teste. Só deve ser chamado quando
 * `nodeEnv === 'test'`; a checagem é repetida aqui de propósito.
 */
export function applyTestFallbacks(
  raw: Record<string, string>,
  nodeEnv: string,
): { readonly raw: Record<string, string>; readonly applied: boolean } {
  if (nodeEnv !== 'test') {
    return { raw, applied: false };
  }

  let applied = false;
  const next = { ...raw };

  for (const key of TEST_SECRET_KEYS) {
    if (next[key] === undefined) {
      next[key] = testSecretFor(key);
      applied = true;
    }
  }

  for (const [key, value] of Object.entries(TEST_DATABASE_FALLBACKS)) {
    if (next[key] === undefined) {
      next[key] = value;
      applied = true;
    }
  }

  return { raw: next, applied };
}

/**
 * Segunda barreira: mesmo que alguém copie um segredo de teste para o `.env`
 * de produção, o boot cai.
 */
export function assertNoTestSecrets(
  values: Readonly<Record<string, string>>,
  nodeEnv: string,
): readonly ConfigIssue[] {
  if (nodeEnv === 'test') {
    return [];
  }

  const issues: ConfigIssue[] = [];

  for (const key of TEST_SECRET_KEYS) {
    const value = values[key];

    if (value !== undefined && TEST_SECRET_VALUES.has(value)) {
      issues.push({
        key,
        message: `holds a value reserved for NODE_ENV=test and cannot be used in "${nodeEnv}"`,
      });
    }
  }

  return issues;
}
