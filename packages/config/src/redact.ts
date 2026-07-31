/**
 * Versão da configuração segura para log e para o endpoint de health.
 *
 * Nenhum segredo sai daqui: o que existe vira `***`, o que não foi configurado
 * vira `null`. O diagnóstico continua útil ("a chave está definida?") sem
 * jamais revelar o valor.
 */

import type { AppConfig, ConfigMeta } from './config.js';
import type { LogLevel, NodeEnvironment } from './schema.js';

export const REDACTED = '***';

/** Marca de presença: `***` quando há valor, `null` quando não há. */
export type RedactedValue = typeof REDACTED | null;

export interface RedactedConfigShape {
  readonly env: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly http: AppConfig['http'];
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: RedactedValue;
    readonly name: string;
  };
  readonly redis: {
    readonly enabled: boolean;
    readonly url: string | null;
    readonly host: string | undefined;
    readonly port: number;
    readonly password: RedactedValue;
    readonly db: number;
    readonly keyPrefix: string;
  };
  readonly secrets: {
    readonly accessToken: RedactedValue;
    readonly refreshToken: RedactedValue;
    readonly realtimeToken: RedactedValue;
    readonly masterKey: RedactedValue;
  };
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | undefined;
    readonly password: RedactedValue;
    readonly from: string;
  };
  readonly github: {
    readonly enabled: boolean;
    /**
     * O client id é público — aparece na URL de autorização que o navegador
     * mostra. O secret não, e por isso só a presença dele é registrada.
     */
    readonly clientId: string | undefined;
    readonly clientSecret: RedactedValue;
    readonly callbackUrl: string | undefined;
    readonly scopes: string;
  };
  readonly transcription: {
    readonly enabled: boolean;
    /**
     * O endereço é interno e diagnóstico — saber para onde a API aponta é o
     * primeiro passo quando o ditado para de funcionar. A chave não: dela só
     * se registra a presença.
     */
    readonly url: string | undefined;
    readonly apiKey: RedactedValue;
    readonly language: string;
  };
  readonly meta: ConfigMeta;
}

function presence(value: string | undefined): RedactedValue {
  return value !== undefined && value.length > 0 ? REDACTED : null;
}

/**
 * Remove usuário e senha embutidos numa URL de conexão. Se a URL não puder ser
 * interpretada, ela é inteiramente suprimida — melhor perder o diagnóstico do
 * que vazar credencial.
 */
export function redactConnectionUrl(url: string | undefined): string | null {
  if (url === undefined || url.length === 0) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return REDACTED;
  }

  if (parsed.password !== '') {
    parsed.password = REDACTED;
  }

  if (parsed.username !== '') {
    parsed.username = REDACTED;
  }

  return parsed.toString();
}

/** Projeção da configuração sem segredos, pronta para log e health. */
export function redactedConfig(config: AppConfig): RedactedConfigShape {
  return Object.freeze({
    env: config.env,
    logLevel: config.logLevel,
    http: config.http,
    database: {
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: presence(config.database.password),
      name: config.database.name,
    },
    redis: {
      enabled: config.redis.enabled,
      url: redactConnectionUrl(config.redis.url),
      host: config.redis.host,
      port: config.redis.port,
      password: presence(config.redis.password),
      db: config.redis.db,
      keyPrefix: config.redis.keyPrefix,
    },
    secrets: {
      accessToken: presence(config.secrets.accessToken),
      refreshToken: presence(config.secrets.refreshToken),
      realtimeToken: presence(config.secrets.realtimeToken),
      masterKey: presence(config.secrets.masterKey),
    },
    smtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      password: presence(config.smtp.password),
      from: config.smtp.from,
    },
    github: {
      enabled: config.github.enabled,
      clientId: config.github.clientId,
      clientSecret: presence(config.github.clientSecret),
      callbackUrl: config.github.callbackUrl,
      scopes: config.github.scopes,
    },
    transcription: {
      enabled: config.transcription.enabled,
      url: config.transcription.url,
      apiKey: presence(config.transcription.apiKey),
      language: config.transcription.language,
    },
    meta: config.meta,
  } satisfies RedactedConfigShape);
}
