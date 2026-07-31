/**
 * Carregamento da configuração.
 *
 * `loadConfig` lê, valida e devolve um objeto congelado; `getConfig` memoiza o
 * resultado para que o ambiente seja lido uma única vez por processo.
 */

import { type z } from 'zod';

import { buildConfig, type AppConfig, type ConfigMeta } from './config.js';
import { collectRawEnv, type EnvSourceOptions } from './env-source.js';
import { ConfigValidationError, type ConfigIssue } from './errors.js';
import { envSchema, type ParsedEnv } from './schema.js';
import { applyTestFallbacks, assertNoTestSecrets } from './test-fallbacks.js';

const SCHEMA_KEY_ORDER: readonly string[] = Object.keys(envSchema.shape);

export type LoadConfigOptions = EnvSourceOptions;

/** Traduz os issues do Zod para o formato do relatório de boot. */
function toConfigIssues(
  error: z.ZodError,
  raw: Readonly<Record<string, string>>,
): ConfigIssue[] {
  return error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    const topLevel = String(issue.path[0] ?? key);

    if (raw[topLevel] === undefined) {
      return {
        key,
        message: 'is required but is not set (see .env.example)',
      };
    }

    return { key, message: issue.message };
  });
}

/** Regras que dependem de mais de uma variável ao mesmo tempo. */
function crossFieldIssues(parsed: ParsedEnv): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const isProduction = parsed.NODE_ENV === 'production';
  const isStaging = parsed.NODE_ENV === 'staging';

  if (
    parsed.VALKEY_ENABLED &&
    parsed.VALKEY_URL === undefined &&
    parsed.VALKEY_HOST === undefined
  ) {
    issues.push({
      key: 'VALKEY_URL',
      message:
        'is required when VALKEY_ENABLED is true (or set VALKEY_HOST instead)',
    });
  }

  if (
    parsed.SMTP_USER !== undefined &&
    parsed.SMTP_USER.length > 0 &&
    (parsed.SMTP_PASSWORD === undefined || parsed.SMTP_PASSWORD.length === 0)
  ) {
    issues.push({
      key: 'SMTP_PASSWORD',
      message: 'is required when SMTP_USER is set',
    });
  }

  const secretEntries = [
    ['AUTH_ACCESS_TOKEN_SECRET', parsed.AUTH_ACCESS_TOKEN_SECRET],
    ['AUTH_REFRESH_TOKEN_SECRET', parsed.AUTH_REFRESH_TOKEN_SECRET],
    ['AUTH_REALTIME_TOKEN_SECRET', parsed.AUTH_REALTIME_TOKEN_SECRET],
    ['SECRETS_MASTER_KEY', parsed.SECRETS_MASTER_KEY],
  ] as const;

  const seen = new Map<string, string>();

  for (const [key, value] of secretEntries) {
    const previous = seen.get(value);

    if (previous !== undefined) {
      issues.push({
        key,
        message: `must not repeat the value of ${previous}; every secret is rotated independently`,
      });

      continue;
    }

    seen.set(value, key);
  }

  if (isProduction || isStaging) {
    if (parsed.DATABASE_PASSWORD.length === 0) {
      issues.push({
        key: 'DATABASE_PASSWORD',
        message: `must not be empty in "${parsed.NODE_ENV}"`,
      });
    }

    if (parsed.CORS_ORIGINS.length === 0) {
      issues.push({
        key: 'CORS_ORIGINS',
        message: `must list at least one allowed origin in "${parsed.NODE_ENV}"`,
      });
    }
  }

  if (isProduction) {
    for (const key of ['HUB_API_URL', 'HUB_WEB_URL'] as const) {
      if (!parsed[key].startsWith('https://')) {
        issues.push({
          key,
          message: 'must use https in "production"',
        });
      }
    }
  }

  return issues;
}

/** Ordena pelo esquema para que o relatório saia sempre igual. */
function sortIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  const rank = (key: string): number => {
    const index = SCHEMA_KEY_ORDER.indexOf(key.split('.')[0] ?? key);

    return index === -1 ? SCHEMA_KEY_ORDER.length : index;
  };

  return [...issues].sort((a, b) => rank(a.key) - rank(b.key));
}

/**
 * Lê o ambiente, valida tudo de uma vez e devolve a configuração congelada.
 *
 * @throws {ConfigValidationError} com a lista completa de variáveis inválidas.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const source = collectRawEnv(options);
  const nodeEnv = options.nodeEnv ?? source.raw['NODE_ENV'] ?? 'development';
  const { raw, applied } = applyTestFallbacks(source.raw, nodeEnv);

  const reservedIssues = assertNoTestSecrets(raw, nodeEnv);
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    throw new ConfigValidationError(
      sortIssues([...toConfigIssues(result.error, raw), ...reservedIssues]),
    );
  }

  const issues = [...reservedIssues, ...crossFieldIssues(result.data)];

  if (issues.length > 0) {
    throw new ConfigValidationError(sortIssues(issues));
  }

  const meta: ConfigMeta = {
    envFiles: Object.freeze([...source.envFiles]),
    workspaceRoot: source.workspaceRoot,
    loadedAt: new Date().toISOString(),
    usesTestSecrets: applied,
  };

  return buildConfig(result.data, meta);
}

let cached: AppConfig | undefined;

/**
 * Configuração do processo. Lê o ambiente na primeira chamada e devolve sempre
 * a mesma instância congelada depois disso.
 */
export function getConfig(): AppConfig {
  cached ??= loadConfig();

  return cached;
}

/** Descarta o cache. Existe para testes; não use em código de produção. */
export function resetConfigCache(): void {
  cached = undefined;
}
