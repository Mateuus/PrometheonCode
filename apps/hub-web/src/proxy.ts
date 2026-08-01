import { NextResponse, type NextRequest } from 'next/server';
import {
  API_CSRF_COOKIE,
  API_REFRESH_COOKIE,
  SESSION_COOKIE,
  accessTokenExpired,
  apiCookieHeader,
  decodeSession,
  encodeSession,
  readApiCookie,
  sessionCookieOptions,
  type Session,
} from '@/lib/auth/session-codec';

/**
 * Content Security Policy, portaria das rotas privadas e renovação da sessão.
 *
 * Arquivo `proxy.ts` porque o Next 16 aposentou a convenção `middleware.ts`; o
 * papel é o mesmo — rodar antes de qualquer rota.
 *
 * A CSP é montada por requisição porque carrega um nonce: sem ele, o Next
 * precisaria de `'unsafe-inline'` para os scripts que hidratam a página, e uma
 * política com `unsafe-inline` protege contra quase nada.
 *
 * Aqui não se decide autorização de domínio. O middleware só evita mostrar a
 * casca de uma tela privada a quem nem sessão tem; quem diz o que cada papel
 * pode fazer é a Hub API, a cada requisição (`Docs/05`).
 */

/**
 * Rotas que exigem um cookie de sessão para sequer renderizar.
 *
 * `/device` está aqui porque a autorização de dispositivo (`Docs/09`) só faz
 * sentido logado — as rotas da API que ela consome exigem sessão. O redirect
 * abaixo guarda `?user_code=` dentro do `next`, então quem veio do editor entra
 * e volta direto para o pedido que ia aprovar.
 */
const PRIVATE_PREFIXES = ['/app', '/settings', '/admin', '/device'];

const API_URL = process.env.HUB_API_URL ?? 'http://127.0.0.1:3551';

/**
 * Origem do WebSocket de tempo real.
 *
 * É a única exceção ao `connect-src 'self'`: a Hub API é falada pelo servidor,
 * mas o socket precisa sair do navegador, porque não existe proxy de WebSocket
 * no Next. A conexão usa um bilhete de uso único — o token de acesso continua
 * fora do alcance do JavaScript.
 */
function realtimeConnectSources(): string {
  try {
    const api = new URL(API_URL);
    const scheme = api.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${api.host}`;
  } catch {
    return '';
  }
}

function buildContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  const scriptSrc = isDevelopment
    ? // O dev server usa eval para o hot reload; em produção isso não entra.
      `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // O Next injeta estilos no `<head>`; sem `unsafe-inline` a página fica nua.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${realtimeConnectSources()}`.trim(),
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Renova o access token quando ele está por vencer.
 *
 * É aqui e não numa página porque Server Component não escreve cookie: o
 * middleware é o único ponto que roda antes de toda navegação e ainda pode
 * gravar. O refresh vai pelo caminho de cookie da API (`prom_refresh` +
 * `prom_csrf` no cabeçalho `cookie`, o CSRF ecoado em `x-csrf-token`), e a API
 * rotaciona o refresh a cada uso — daí a releitura do `Set-Cookie`.
 */
async function renew(session: Session, origin: string): Promise<Session | null> {
  if (session.refreshToken === '') {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: apiCookieHeader(session),
        'x-csrf-token': session.csrfToken,
      },
      body: '{}',
      cache: 'no-store',
    });
  } catch {
    // API fora do ar não é sessão inválida: o cookie sobrevive à queda.
    return session;
  }

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: { tokens?: { accessToken?: string; expiresIn?: number } } }
    | null;
  const tokens = payload?.data?.tokens;
  if (typeof tokens?.accessToken !== 'string' || typeof tokens.expiresIn !== 'number') {
    return null;
  }

  const rotated: Record<string, string> = {};
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) {
      rotated[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
  }

  return {
    ...session,
    accessToken: tokens.accessToken,
    accessExpiresAt: new Date(Date.now() + tokens.expiresIn * 1_000).toISOString(),
    refreshToken: readApiCookie(rotated, API_REFRESH_COOKIE) ?? session.refreshToken,
    csrfToken: readApiCookie(rotated, API_CSRF_COOKIE) ?? session.csrfToken,
  };
}

export default async function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const csp = buildContentSecurityPolicy(nonce, isDevelopment);

  const { pathname, search } = request.nextUrl;
  const isPrivate = PRIVATE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  let session = decodeSession(raw);

  if (isPrivate && !session) {
    const login = new URL('/login', request.url);
    // `next` sai daqui como caminho relativo; `safeRedirect` valida na volta.
    login.searchParams.set('next', `${pathname}${search}`);
    const redirect = NextResponse.redirect(login);
    redirect.headers.set('Content-Security-Policy', csp);
    if (raw !== undefined) {
      redirect.cookies.delete(SESSION_COOKIE);
    }
    return redirect;
  }

  let refreshed: Session | null = null;
  if (session && accessTokenExpired(session)) {
    refreshed = await renew(session, request.nextUrl.origin);
    if (!refreshed) {
      session = null;
    } else {
      session = refreshed;
    }
  }

  if (isPrivate && !session) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    const expired = NextResponse.redirect(login);
    expired.headers.set('Content-Security-Policy', csp);
    expired.cookies.delete(SESSION_COOKIE);
    return expired;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const encoded = refreshed ? encodeSession(refreshed) : undefined;
  if (encoded) {
    // A página desta mesma requisição precisa enxergar o token novo, então o
    // cookie é reescrito também no cabeçalho que segue para o servidor.
    const jar = request.cookies
      .getAll()
      .map((cookie) => (cookie.name === SESSION_COOKIE ? `${cookie.name}=${encoded}` : `${cookie.name}=${cookie.value}`));
    if (!request.cookies.has(SESSION_COOKIE)) {
      jar.push(`${SESSION_COOKIE}=${encoded}`);
    }
    requestHeaders.set('cookie', jar.join('; '));
  }

  // Ferramenta de desenvolvimento: `?state=` força um dos sete estados para
  // revisão visual. Layouts não recebem `searchParams`, então o valor viaja por
  // cabeçalho. Em produção o parâmetro é ignorado (ver `state-override.ts`).
  const forcedState = request.nextUrl.searchParams.get('state');
  if (forcedState) {
    requestHeaders.set('x-forced-state', forcedState);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (encoded) {
    response.cookies.set(SESSION_COOKIE, encoded, sessionCookieOptions(!isDevelopment));
  }
  return response;
}

export const config = {
  matcher: [
    // Fora: assets estáticos e o favicon, que não executam script.
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
