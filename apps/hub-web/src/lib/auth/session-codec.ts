import { z } from 'zod';

/**
 * Forma e codificação do cookie de sessão.
 *
 * Fica separado de `session.ts` porque o `proxy.ts` (middleware) também precisa
 * ler e regravar a sessão, e lá não existem `next/headers` nem `server-only`.
 * Por isso a codificação usa só APIs que valem no Node e no Edge.
 *
 * O cookie **não é fonte de autoridade**. Quem decide o que o usuário pode
 * fazer é a Hub API, a cada requisição. Aqui ele guarda (a) o que mandar no
 * `Authorization`, (b) o que a API pediu para custodiar em cookie e (c) o
 * mínimo para desenhar o cabeçalho sem uma ida à rede.
 */

export const SESSION_COOKIE = 'prometheon_session';
export const THEME_COOKIE = 'prometheon_theme';

/** Nomes dos cookies que a Hub API emite e que o Hub Web guarda por ela. */
export const API_REFRESH_COOKIE = 'prom_refresh';
export const API_CSRF_COOKIE = 'prom_csrf';

/**
 * Prefixo que a Hub API acrescenta aos próprios cookies quando roda em HTTPS:
 * lá o nome é `__Host-prom_refresh`, e em desenvolvimento é `prom_refresh`.
 *
 * Quem fala com a API aqui é o servidor do Hub Web, não o navegador — então não
 * existe ninguém para acertar o nome sozinho. Procurar apenas a grafia sem
 * prefixo fazia o Hub Web não guardar o refresh em produção: a sessão morria no
 * primeiro vencimento do access token, quinze minutos depois do login.
 *
 * A leitura aceita as duas grafias e a escrita manda as duas com o mesmo valor.
 * Assim a sessão sobrevive com a API em http ou em https, sem o Hub Web ter de
 * repetir a configuração de cookie que já existe do outro lado.
 */
export const HOST_COOKIE_PREFIX = '__Host-';

/** Lê um cookie da API tolerando o prefixo `__Host-`. */
export function readApiCookie(jar: Record<string, string>, name: string): string | undefined {
  return jar[name] ?? jar[`${HOST_COOKIE_PREFIX}${name}`];
}

/** Cookies da API sob custódia, nas duas grafias. Valor vazio não vai. */
export function apiCookieJar(
  session: Pick<Session, 'refreshToken' | 'csrfToken'>,
): Record<string, string> {
  const jar: Record<string, string> = {};

  for (const [name, value] of [
    [API_REFRESH_COOKIE, session.refreshToken],
    [API_CSRF_COOKIE, session.csrfToken],
  ] as const) {
    if (value === '') {
      continue;
    }
    jar[name] = value;
    jar[`${HOST_COOKIE_PREFIX}${name}`] = value;
  }

  return jar;
}

/** Os mesmos cookies já no formato do cabeçalho `cookie`. */
export function apiCookieHeader(
  session: Pick<Session, 'refreshToken' | 'csrfToken'>,
): string {
  return Object.entries(apiCookieJar(session))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export const sessionSchema = z.object({
  accessToken: z.string(),
  /** Momento em que o access token expira, ISO 8601 UTC. */
  accessExpiresAt: z.string(),
  /**
   * Valor do cookie `prom_refresh` da API. Ele nasce `HttpOnly` lá e continua
   * inalcançável pelo JavaScript aqui: só o servidor do Hub Web o lê.
   */
  refreshToken: z.string(),
  /** Valor do cookie `prom_csrf`, ecoado em `x-csrf-token` no refresh. */
  csrfToken: z.string(),
  sessionId: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
  }),
});

export type Session = z.infer<typeof sessionSchema>;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeSession(session: Session): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(session)));
}

export function decodeSession(raw: string | undefined): Session | null {
  if (!raw) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
    const parsed = sessionSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Margem para renovar antes de o token vencer no meio de uma navegação. */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

export function accessTokenExpired(session: Session, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(session.accessExpiresAt);
  return Number.isNaN(expiresAt) || expiresAt - now <= ACCESS_TOKEN_REFRESH_MARGIN_MS;
}

/** Opções do cookie de sessão, iguais em toda escrita. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    // `Secure` sempre em produção. Em desenvolvimento o Hub roda em 127.0.0.1
    // sem TLS, e um cookie Secure simplesmente não seria gravado.
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  };
}
