import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content Security Policy e portaria das rotas privadas.
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

const SESSION_COOKIE = 'prometheon_session';

/** Rotas que exigem um cookie de sessão para sequer renderizar. */
const PRIVATE_PREFIXES = ['/app', '/settings', '/admin'];

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
    // A API é falada pelo servidor. O navegador só volta ao próprio Hub.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export default function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const csp = buildContentSecurityPolicy(nonce, isDevelopment);

  const { pathname, search } = request.nextUrl;
  const isPrivate = PRIVATE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isPrivate && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL('/login', request.url);
    // `next` sai daqui como caminho relativo; `safeRedirect` valida na volta.
    login.searchParams.set('next', `${pathname}${search}`);
    const redirect = NextResponse.redirect(login);
    redirect.headers.set('Content-Security-Policy', csp);
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  // PROVISÓRIO: `?state=` força um dos sete estados para revisão visual. Layouts
  // não recebem `searchParams`, então o valor viaja por cabeçalho.
  const forcedState = request.nextUrl.searchParams.get('state');
  if (forcedState) {
    requestHeaders.set('x-forced-state', forcedState);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
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
