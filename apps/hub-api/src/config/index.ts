/**
 * Configuração da Hub API.
 *
 * A configuração de ambiente vem inteira de `@prometheon/config` — este módulo
 * não relê `process.env` para nada que já esteja lá. O que ele acrescenta são
 * os parâmetros de política da API (tempos de vida de token, custo do Argon2id,
 * tetos de rate limit), que são decisão de produto e não de implantação.
 *
 * Os poucos valores lidos direto do ambiente aqui estão marcados um a um: são
 * chaves que ainda não existem no esquema de `@prometheon/config` e que migram
 * para lá assim que aquele pacote as aceitar.
 */

import process from 'node:process';

import { getConfig, type AppConfig } from '@prometheon/config';

export type { AppConfig };

/** Lê uma chave ainda ausente do esquema de `@prometheon/config`. */
function extraEnv(key: string): string | undefined {
  const value = process.env[key];

  return value === undefined || value === '' ? undefined : value;
}

function extraBoolean(key: string, fallback: boolean): boolean {
  const value = extraEnv(key)?.toLowerCase();

  if (value === undefined) {
    return fallback;
  }

  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

// ---------------------------------------------------------------------------
// Argon2id
// ---------------------------------------------------------------------------

/**
 * Parâmetros do Argon2id.
 *
 * Seguem a recomendação de primeira linha do OWASP Password Storage Cheat
 * Sheet: `m = 19 MiB`, `t = 2`, `p = 1`. Cada número tem um porquê:
 *
 * - `memoryCost` (19456 KiB) é o que torna o ataque em GPU caro: memória é o
 *   recurso que placas gráficas têm pouco por núcleo. Reduzir isto é o jeito
 *   mais rápido de enfraquecer o hash.
 * - `timeCost` (2) é o número de passagens. Com 19 MiB, duas passagens já ficam
 *   na casa de dezenas de milissegundos num servidor comum — caro para quem
 *   ataca, imperceptível para quem faz login.
 * - `parallelism` (1) casa com o modelo de execução do Node: uma requisição por
 *   vez no thread pool, sem disputar núcleos com o resto do processo.
 * - `hashLength` (32 bytes) é o tamanho da saída; 16 seria suficiente, 32 dá
 *   margem sem custo relevante.
 *
 * Aumentar qualquer um destes valores continua aceitando hashes antigos: o
 * `argon2` lê os parâmetros do próprio hash na verificação. Quem loga com um
 * hash em parâmetros defasados é re-hasheado na hora (ver `password.ts`).
 */
export const ARGON2_OPTIONS = {
  /** 19 MiB, em KiB. */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

// ---------------------------------------------------------------------------
// Tokens e sessões
// ---------------------------------------------------------------------------

export const AUTH_SETTINGS = {
  /**
   * Access token de 15 minutos. Curto porque ele não é consultado no banco a
   * cada uso: a janela entre revogar uma sessão e o token parar de valer é, no
   * pior caso, o tempo que falta para expirar. (A denylist no Redis fecha essa
   * janela quando o Redis está no ar; ver `plugins/auth.ts`.)
   */
  accessTokenTtlSeconds: 15 * 60,
  /** Refresh token de 30 dias, rotacionado a cada uso. */
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  /** Sessão expira junto do refresh mais longo que ela pode emitir. */
  sessionTtlSeconds: 30 * 24 * 60 * 60,
  /** Token de verificação de e-mail: 24 horas, uso único. */
  emailVerificationTtlSeconds: 24 * 60 * 60,
  /**
   * Token de recuperação de senha: 30 minutos, uso único. Curto de propósito —
   * ele dá acesso total à conta e vive numa caixa de e-mail.
   */
  passwordResetTtlSeconds: 30 * 60,
  /** Convite para organização: 7 dias. */
  invitationTtlSeconds: 7 * 24 * 60 * 60,
  /** Credencial de dispositivo: 90 dias, renovável pelo device flow. */
  deviceCredentialTtlSeconds: 90 * 24 * 60 * 60,
  /** Device code: 10 minutos. Se o usuário demorar mais, pede outro. */
  deviceCodeTtlSeconds: 10 * 60,
  /** Intervalo mínimo entre chamadas de polling do device flow, em segundos. */
  devicePollIntervalSeconds: 5,
  /** Emissor e público dos JWTs. */
  issuer: 'prometheon-hub',
  audience: 'prometheon-api',
} as const;

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Nomes e atributos dos cookies do Hub Web.
 *
 * `__Host-` exige `Secure`, `Path=/` e proíbe `Domain` — o navegador então
 * garante que o cookie não veio de um subdomínio vizinho. O prefixo só é usado
 * quando a API roda em HTTPS; em `http://127.0.0.1` ele invalidaria o cookie,
 * então o nome cai para a versão sem prefixo.
 */
export const COOKIE_SETTINGS = {
  refreshName: 'prom_refresh',
  refreshNameSecure: '__Host-prom_refresh',
  csrfName: 'prom_csrf',
  csrfNameSecure: '__Host-prom_csrf',
  csrfHeader: 'x-csrf-token',
} as const;

export interface CookieProfile {
  readonly refreshName: string;
  readonly csrfName: string;
  readonly secure: boolean;
  readonly sameSite: 'strict' | 'lax';
  readonly path: string;
}

/**
 * `SameSite=Strict` no cookie de refresh: ele só é usado por chamadas que a
 * própria aplicação dispara, nunca por navegação vinda de fora, então não há o
 * problema clássico de "o usuário clica num link e aparece deslogado".
 */
export function cookieProfile(config: AppConfig): CookieProfile {
  const secure = config.http.apiUrl.startsWith('https://') || config.isProduction;

  return {
    refreshName: secure ? COOKIE_SETTINGS.refreshNameSecure : COOKIE_SETTINGS.refreshName,
    csrfName: secure ? COOKIE_SETTINGS.csrfNameSecure : COOKIE_SETTINGS.csrfName,
    secure,
    sameSite: 'strict',
    // `__Host-` exige `Path=/`. Sem o prefixo o caminho poderia ser mais
    // estreito, mas manter os dois iguais evita cookie órfão ao alternar
    // entre http e https em desenvolvimento.
    path: '/',
  };
}

// ---------------------------------------------------------------------------
// Limites de payload e rate limit
// ---------------------------------------------------------------------------

export const PAYLOAD_LIMITS = {
  /** Teto global do corpo da requisição: 1 MiB. */
  global: 1_048_576,
  /** Rotas de autenticação não têm por que receber mais que 16 KiB. */
  auth: 16_384,
} as const;

export interface RateLimitTier {
  readonly max: number;
  readonly windowSeconds: number;
}

/**
 * Tetos por rota. O `Docs/06` pede limite por IP, usuário, organização e rota;
 * a chave de cada limite é montada em `plugins/rate-limit.ts`.
 */
export const RATE_LIMITS = {
  /** Teto global por IP, aplicado a tudo. */
  global: { max: 600, windowSeconds: 60 },
  /** Teto global por usuário autenticado, mais generoso que o de IP. */
  perUser: { max: 1_200, windowSeconds: 60 },
  /** Teto por organização, para conter um tenant barulhento. */
  perOrganization: { max: 3_000, windowSeconds: 60 },
  /**
   * Login tem dois tetos, e os dois são necessários.
   *
   * `loginPerIp` contém o atacante que varre muitas contas de um lugar só;
   * `loginPerEmail` contém o ataque distribuído contra uma conta específica.
   * Um sem o outro deixa metade do problema aberta — e o teto por e-mail
   * precisa ser o mais baixo, ou nunca seria alcançado.
   */
  loginPerIp: { max: 60, windowSeconds: 300 },
  loginPerEmail: { max: 10, windowSeconds: 300 },
  register: { max: 5, windowSeconds: 3_600 },
  passwordResetPerIp: { max: 30, windowSeconds: 3_600 },
  passwordResetPerEmail: { max: 5, windowSeconds: 3_600 },
  emailVerification: { max: 20, windowSeconds: 3_600 },
  refresh: { max: 60, windowSeconds: 300 },
  /** Início do device flow: uma extensão não pede código o tempo todo. */
  deviceAuthorization: { max: 20, windowSeconds: 3_600 },
  /**
   * Polling do device flow. O teto é por device code, e o intervalo mínimo é
   * cobrado à parte com `SLOW_DOWN` — este limite é a rede de segurança para
   * quem ignora o `interval`.
   */
  devicePolling: { max: 120, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitTier>;

// ---------------------------------------------------------------------------
// Ajustes ainda fora de `@prometheon/config`
// ---------------------------------------------------------------------------

export interface ApiRuntimeSettings {
  /** Desligar rate limit é exclusividade de teste. */
  readonly rateLimitEnabled: boolean;
  /** `auto` tenta SMTP e cai para captura em disco; ver `mail/transport.ts`. */
  readonly mailTransport: 'auto' | 'smtp' | 'capture';
  /** Diretório do transporte de captura. */
  readonly mailCaptureDir: string | undefined;
  /** Versão do serviço reportada em `/health/version`. */
  readonly serviceVersion: string;
  readonly commitSha: string | undefined;
  readonly builtAt: string | undefined;
}

/**
 * PROVISÓRIO: estas chaves migram para o esquema de `@prometheon/config`
 * (`RATE_LIMIT_ENABLED`, `MAIL_TRANSPORT`, `MAIL_CAPTURE_DIR`, `SERVICE_VERSION`,
 * `GIT_COMMIT_SHA`, `BUILD_TIMESTAMP`) quando aquele pacote as aceitar. Até lá
 * ficam aqui, isoladas nesta função, para serem movidas em bloco.
 */
export function runtimeSettings(): ApiRuntimeSettings {
  const transport = extraEnv('MAIL_TRANSPORT');

  return {
    rateLimitEnabled: extraBoolean('RATE_LIMIT_ENABLED', true),
    mailTransport:
      transport === 'smtp' || transport === 'capture' || transport === 'auto'
        ? transport
        : 'auto',
    mailCaptureDir: extraEnv('MAIL_CAPTURE_DIR'),
    serviceVersion: extraEnv('SERVICE_VERSION') ?? '0.0.1',
    commitSha: extraEnv('GIT_COMMIT_SHA'),
    builtAt: extraEnv('BUILD_TIMESTAMP'),
  };
}

export { getConfig };
