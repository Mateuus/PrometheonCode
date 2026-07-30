/**
 * Esquema Zod das variáveis de ambiente.
 *
 * Cobre todas as chaves de `.env.example`. Qualquer chave nova precisa entrar
 * aqui e no exemplo ao mesmo tempo, senão a aplicação sobe sem enxergá-la.
 */

import { z } from 'zod';

import { assessSecret } from './secrets.js';

export const NODE_ENVIRONMENTS = [
  'development',
  'test',
  'staging',
  'production',
] as const;

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const BOOLEAN_VALUES = [
  'true',
  'false',
  '1',
  '0',
  'yes',
  'no',
  'on',
  'off',
] as const;

/** Booleano vindo de string, tolerante a maiúsculas e a espaços em volta. */
function booleanEnv() {
  return z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(BOOLEAN_VALUES))
    .transform((value) => TRUE_VALUES.has(value));
}

/** Inteiro em faixa de porta TCP. */
function portEnv() {
  return z.coerce.number().int().min(1).max(65_535);
}

/** URL absoluta http(s), sem barra final. */
function httpUrlEnv() {
  return z
    .string()
    .trim()
    .refine((value) => /^https?:\/\//.test(value), {
      message: 'must be an absolute http(s) URL',
    })
    .refine(
      (value) => {
        try {
          new URL(value);

          return true;
        } catch {
          return false;
        }
      },
      { message: 'must be a parseable URL' },
    )
    .transform((value) => value.replace(/\/+$/, ''));
}

/** Lista de origens CORS separada por vírgula. */
function corsOriginsEnv() {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .superRefine((origins, ctx) => {
      for (const origin of origins) {
        if (origin === '*') {
          ctx.addIssue({
            code: 'custom',
            message:
              'must not use the "*" wildcard; list the allowed origins explicitly',
          });

          continue;
        }

        let parsed: URL;

        try {
          parsed = new URL(origin);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: `contains an entry that is not a valid origin: "${origin}"`,
          });

          continue;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          ctx.addIssue({
            code: 'custom',
            message: `contains an origin with an unsupported protocol: "${origin}"`,
          });
        }

        if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
          ctx.addIssue({
            code: 'custom',
            message: `contains an origin with a path, query or fragment: "${origin}" (use scheme://host:port)`,
          });
        }
      }
    })
    .transform((origins) => Object.freeze([...new Set(origins)]));
}

/** Segredo com pelo menos 32 bytes de entropia. */
function secretEnv() {
  return z.string().superRefine((value, ctx) => {
    const assessment = assessSecret(value);

    if (!assessment.ok) {
      ctx.addIssue({ code: 'custom', message: assessment.reason });
    }
  });
}

const requiredString = (label: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `is required (${label})` });

/**
 * Esquema bruto. O objeto é `strip`: variáveis desconhecidas do ambiente são
 * ignoradas em vez de derrubar o boot — `PATH` e companhia sempre estão lá.
 */
export const envSchema = z.object({
  // -- Ambiente -------------------------------------------------------------
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // -- HTTP -----------------------------------------------------------------
  HUB_API_PORT: portEnv().default(3551),
  HUB_WEB_PORT: portEnv().default(3550),
  HUB_API_URL: httpUrlEnv().default('http://127.0.0.1:3551'),
  HUB_WEB_URL: httpUrlEnv().default('http://127.0.0.1:3550'),
  CORS_ORIGINS: corsOriginsEnv().default([]),

  // -- MySQL ----------------------------------------------------------------
  DATABASE_HOST: requiredString('MySQL host'),
  DATABASE_PORT: portEnv().default(3306),
  DATABASE_USER: requiredString('MySQL user'),
  DATABASE_PASSWORD: z.string().default(''),
  DATABASE_NAME: requiredString('MySQL database name'),

  // -- Redis / Valkey -------------------------------------------------------
  VALKEY_ENABLED: booleanEnv().default(true),
  VALKEY_URL: z.string().trim().min(1).optional(),
  VALKEY_HOST: z.string().trim().min(1).optional(),
  VALKEY_PORT: portEnv().default(6379),
  VALKEY_PASSWORD: z.string().optional(),
  VALKEY_DB: z.coerce.number().int().min(0).max(15).default(0),
  VALKEY_KEY_PREFIX: z.string().default('prometheon:'),

  // -- Segredos -------------------------------------------------------------
  AUTH_ACCESS_TOKEN_SECRET: secretEnv(),
  AUTH_REFRESH_TOKEN_SECRET: secretEnv(),
  AUTH_REALTIME_TOKEN_SECRET: secretEnv(),
  SECRETS_MASTER_KEY: secretEnv(),

  // -- E-mail ---------------------------------------------------------------
  SMTP_HOST: z.string().trim().min(1).default('127.0.0.1'),
  SMTP_PORT: portEnv().default(1025),
  SMTP_SECURE: booleanEnv().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z
    .string()
    .trim()
    .min(1)
    .default('Prometheon <no-reply@prometheoncode.xyz>'),

  /**
   * `smtp` entrega de verdade; `capture` grava a mensagem em disco e registra o
   * link no log. A captura existe porque o servidor SMTP de desenvolvimento roda
   * em contêiner, e nem toda máquina tem Docker no ar — sem ela, o cadastro
   * simplesmente não conclui em desenvolvimento.
   */
  MAIL_TRANSPORT: z.enum(['smtp', 'capture']).default('capture'),
  /** Diretório da captura. Vazio usa o temporário do sistema, fora do repositório. */
  MAIL_CAPTURE_DIR: z.string().optional(),

  // -- Operação -------------------------------------------------------------

  /**
   * Desligar o rate limit só se justifica em teste automatizado, onde as
   * chamadas são propositalmente repetitivas.
   */
  RATE_LIMIT_ENABLED: booleanEnv().default(true),
  /** Aparece em `/health/version` e nos logs, para saber o que está no ar. */
  SERVICE_VERSION: z.string().trim().optional(),
  GIT_COMMIT_SHA: z.string().trim().optional(),
  BUILD_TIMESTAMP: z.string().trim().optional(),
});

export type ParsedEnv = z.output<typeof envSchema>;
