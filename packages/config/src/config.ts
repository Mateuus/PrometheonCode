/**
 * Forma pública da configuração.
 *
 * Os campos opcionais são declarados como `T | undefined` em vez de `?:` por
 * causa do `exactOptionalPropertyTypes`: assim o objeto sempre tem a chave e
 * quem lê não precisa distinguir "ausente" de "indefinido".
 */

import type { LogLevel, NodeEnvironment, ParsedEnv } from './schema.js';

export interface HttpConfig {
  readonly apiPort: number;
  readonly webPort: number;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly corsOrigins: readonly string[];
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly name: string;
}

export interface RedisConfig {
  readonly enabled: boolean;
  readonly url: string | undefined;
  readonly host: string | undefined;
  readonly port: number;
  readonly password: string | undefined;
  readonly db: number;
  readonly keyPrefix: string;
}

export interface SecretsConfig {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly realtimeToken: string;
  readonly masterKey: string;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly from: string;
}

/**
 * Login com GitHub.
 *
 * `enabled` é derivado: sem client id, secret e callback, não há o que oferecer.
 * Deixar a decisão aqui evita que cada ponto do código repita a mesma verificação
 * de três campos — e que um deles esqueça de um.
 */
export interface GitHubOAuthConfig {
  readonly enabled: boolean;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly callbackUrl: string | undefined;
  readonly scopes: string;
}

/**
 * Ditado por voz.
 *
 * `enabled` é derivado como no GitHub acima: ligar a funcionalidade sem dizer
 * onde o serviço está não descreve nada que possa funcionar, e resolver isso
 * aqui evita que cada ponto do código repita a mesma dupla verificação.
 */
export interface TranscriptionConfig {
  readonly enabled: boolean;
  readonly url: string | undefined;
  readonly apiKey: string | undefined;
  readonly language: string;
}

export interface ConfigMeta {
  /** Arquivos `.env` lidos, em ordem de precedência crescente. */
  readonly envFiles: readonly string[];
  /** Raiz do workspace pnpm, quando encontrada. */
  readonly workspaceRoot: string | undefined;
  /** Momento em que a configuração foi resolvida, em ISO 8601 UTC. */
  readonly loadedAt: string;
  /** `true` quando o relaxamento de segredos de teste foi aplicado. */
  readonly usesTestSecrets: boolean;
}

export interface AppConfig {
  readonly env: NodeEnvironment;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly isStaging: boolean;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  readonly http: HttpConfig;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly secrets: SecretsConfig;
  readonly smtp: SmtpConfig;
  readonly github: GitHubOAuthConfig;
  readonly transcription: TranscriptionConfig;
  readonly meta: ConfigMeta;
}

/** Congela o objeto e tudo que estiver abaixo dele. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}

/** Converte o resultado do parse no objeto de configuração da aplicação. */
export function buildConfig(
  parsed: ParsedEnv,
  meta: ConfigMeta,
): AppConfig {
  const env = parsed.NODE_ENV;

  return deepFreeze({
    env,
    isDevelopment: env === 'development',
    isTest: env === 'test',
    isStaging: env === 'staging',
    isProduction: env === 'production',
    logLevel: parsed.LOG_LEVEL,
    http: {
      apiPort: parsed.HUB_API_PORT,
      webPort: parsed.HUB_WEB_PORT,
      apiUrl: parsed.HUB_API_URL,
      webUrl: parsed.HUB_WEB_URL,
      corsOrigins: parsed.CORS_ORIGINS,
    },
    database: {
      host: parsed.DATABASE_HOST,
      port: parsed.DATABASE_PORT,
      user: parsed.DATABASE_USER,
      password: parsed.DATABASE_PASSWORD,
      name: parsed.DATABASE_NAME,
    },
    redis: {
      enabled: parsed.VALKEY_ENABLED,
      url: parsed.VALKEY_URL,
      host: parsed.VALKEY_HOST,
      port: parsed.VALKEY_PORT,
      password: parsed.VALKEY_PASSWORD,
      db: parsed.VALKEY_DB,
      keyPrefix: parsed.VALKEY_KEY_PREFIX,
    },
    secrets: {
      accessToken: parsed.AUTH_ACCESS_TOKEN_SECRET,
      refreshToken: parsed.AUTH_REFRESH_TOKEN_SECRET,
      realtimeToken: parsed.AUTH_REALTIME_TOKEN_SECRET,
      masterKey: parsed.SECRETS_MASTER_KEY,
    },
    smtp: {
      host: parsed.SMTP_HOST,
      port: parsed.SMTP_PORT,
      secure: parsed.SMTP_SECURE,
      user: parsed.SMTP_USER,
      password: parsed.SMTP_PASSWORD,
      from: parsed.MAIL_FROM,
    },
    github: {
      // Os três juntos, ou nada: um Hub configurado pela metade ofereceria o
      // botão e falharia no meio do fluxo, depois de a pessoa já ter autorizado.
      enabled:
        parsed.GITHUB_OAUTH_CLIENT_ID !== undefined &&
        parsed.GITHUB_OAUTH_CLIENT_SECRET !== undefined &&
        parsed.GITHUB_OAUTH_CALLBACK_URL !== undefined,
      clientId: parsed.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: parsed.GITHUB_OAUTH_CLIENT_SECRET,
      callbackUrl: parsed.GITHUB_OAUTH_CALLBACK_URL,
      scopes: parsed.GITHUB_OAUTH_SCOPES,
    },
    transcription: {
      // Ligado sem endereço não descreve nada: o botão apareceria na tela e a
      // conexão morreria no primeiro clique.
      enabled: parsed.TRANSCRIPTION_ENABLED && parsed.TRANSCRIPTION_URL !== undefined,
      url: parsed.TRANSCRIPTION_URL,
      apiKey: parsed.TRANSCRIPTION_API_KEY,
      language: parsed.TRANSCRIPTION_LANGUAGE,
    },
    meta,
  } satisfies AppConfig);
}
