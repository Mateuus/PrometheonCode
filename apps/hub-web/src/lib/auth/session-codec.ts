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
