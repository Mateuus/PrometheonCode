import 'server-only';
import { cookies } from 'next/headers';
import { isProduction } from '@/lib/env';
import { hubRequestWithCookies } from '@/lib/api/client';
import { refreshResultSchema } from '@/lib/api/schemas';
import {
  API_CSRF_COOKIE,
  API_REFRESH_COOKIE,
  SESSION_COOKIE,
  THEME_COOKIE,
  accessTokenExpired,
  apiCookieJar,
  decodeSession,
  encodeSession,
  readApiCookie,
  sessionCookieOptions,
  type Session,
} from './session-codec';

export { SESSION_COOKIE, THEME_COOKIE };
export type { Session };

/**
 * Sessão do navegador.
 *
 * O `Docs/05` proíbe credencial em `localStorage`; um cookie que o JavaScript
 * não lê é o que sobra de honesto. O caminho de login é o que a Hub API
 * desenhou para o Hub Web: a chamada leva `Origin` do Hub, a API devolve o
 * refresh em `Set-Cookie` `HttpOnly` em vez do corpo, e o Hub Web guarda esse
 * valor — junto do CSRF que o acompanha — dentro do seu próprio cookie
 * `HttpOnly`. A credencial nunca chega ao JavaScript da página.
 */

export async function readSession(): Promise<Session | null> {
  return decodeSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function writeSession(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, encodeSession(session), sessionCookieOptions(isProduction()));
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Monta a sessão a partir da resposta de login e dos cookies que a API pediu. */
export function buildSession(
  login: {
    user: { id: string; name: string; email: string; emailVerified: boolean };
    tokens: { accessToken: string; expiresIn: number; refreshToken?: string | undefined };
    sessionId: string;
  },
  apiCookies: Record<string, string>,
  previous?: Session | null,
): Session {
  return {
    accessToken: login.tokens.accessToken,
    accessExpiresAt: new Date(Date.now() + login.tokens.expiresIn * 1_000).toISOString(),
    // Com `Origin` do Hub Web o refresh vem no cookie; o corpo é o plano B.
    refreshToken:
      readApiCookie(apiCookies, API_REFRESH_COOKIE) ??
      login.tokens.refreshToken ??
      previous?.refreshToken ??
      '',
    csrfToken: readApiCookie(apiCookies, API_CSRF_COOKIE) ?? previous?.csrfToken ?? '',
    sessionId: login.sessionId,
    user: login.user,
  };
}

/**
 * Renova o access token pelo caminho de cookie da API: manda `prom_refresh` e
 * `prom_csrf` como cookies, ecoa o CSRF no cabeçalho e recolhe o refresh novo
 * (a API rotaciona a cada uso).
 *
 * Devolve `null` quando o refresh não vale mais — aí a sessão acabou de
 * verdade e a tela precisa mandar para o login.
 */
export async function refreshSession(session: Session): Promise<Session | null> {
  if (session.refreshToken === '') {
    return null;
  }

  const { result, cookies: apiCookies } = await hubRequestWithCookies(
    '/v1/auth/refresh',
    refreshResultSchema,
    {
      method: 'POST',
      body: {},
      browserOrigin: true,
      apiCookies: apiCookieJar(session),
      csrfToken: session.csrfToken,
    },
  );

  if (!result.ok) {
    // Offline não invalida a sessão: o refresh volta a ser tentado depois.
    return result.kind === 'offline' ? session : null;
  }

  return {
    ...session,
    accessToken: result.data.tokens.accessToken,
    accessExpiresAt: new Date(Date.now() + result.data.tokens.expiresIn * 1_000).toISOString(),
    refreshToken: readApiCookie(apiCookies, API_REFRESH_COOKIE) ?? session.refreshToken,
    csrfToken: readApiCookie(apiCookies, API_CSRF_COOKIE) ?? session.csrfToken,
  };
}

/**
 * Token para o `Authorization` das chamadas de servidor, renovado quando está
 * por vencer.
 *
 * O caminho normal de renovação é o `proxy.ts`, que roda antes da página e pode
 * gravar cookie. Aqui existe a rede de segurança para o caso de a sessão vencer
 * no meio de uma navegação: o token novo é usado, e a gravação é tentada — em
 * Server Component ela falha, e tudo bem, porque a próxima navegação passa pelo
 * middleware de novo.
 */
export async function accessToken(): Promise<string | undefined> {
  const session = await readSession();
  if (!session) {
    return undefined;
  }
  if (!accessTokenExpired(session)) {
    return session.accessToken;
  }

  const renewed = await refreshSession(session);
  if (!renewed) {
    return undefined;
  }
  try {
    await writeSession(renewed);
  } catch {
    // Server Component não escreve cookie. O middleware regrava na próxima volta.
  }
  return renewed.accessToken;
}

/** Descarta a sessão na API antes de apagar o cookie. Logout é ação auditada. */
export async function revokeSession(session: Session, allSessions: boolean): Promise<void> {
  await hubRequestWithCookies('/v1/auth/logout', refreshResultSchema.partial(), {
    method: 'POST',
    body: { allSessions },
    accessToken: session.accessToken,
    browserOrigin: true,
    apiCookies: apiCookieJar(session),
    csrfToken: session.csrfToken,
  });
}
