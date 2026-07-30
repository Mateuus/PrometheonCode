import { NextResponse, type NextRequest } from 'next/server';
import { hubRequestWithCookies } from '@/lib/api/client';
import { loginResultSchema } from '@/lib/api/schemas';
import { buildSession, writeSession } from '@/lib/auth/session';
import { safeRedirect } from '@/lib/auth/safe-redirect';

/**
 * Volta do login por provedor externo.
 *
 * É um Route Handler, e não uma página, porque **grava cookie**. O Next só
 * permite escrever cookie em Server Action ou Route Handler: de dentro de um
 * Server Component a chamada falha em runtime, e o erro aparece como uma tela
 * genérica de "algo deu errado" — depois de o login já ter dado certo do outro
 * lado, que é a pior hora possível para uma falha silenciosa.
 *
 * A API terminou a conversa com o GitHub e mandou o navegador para cá com um
 * código de handoff, que **não** é um token: vale trinta segundos, serve uma vez
 * e só troca por sessão de dentro do servidor. Mandar o access token na URL
 * teria sido mais simples e teria deixado a credencial no histórico do navegador
 * e no `Referer` de toda requisição seguinte.
 *
 * A troca acontece aqui e o resultado vira o mesmo cookie `HttpOnly` que o login
 * por senha produz. Para o resto do Hub Web não existe "sessão de provedor":
 * existe sessão.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get('code');

  if (code === null || code === '') {
    return NextResponse.redirect(new URL('/login?provider=invalid', origin));
  }

  const { result, cookies } = await hubRequestWithCookies(
    '/v1/auth/oauth/exchange',
    loginResultSchema,
    { method: 'POST', body: { code }, browserOrigin: true },
  );

  if (!result.ok) {
    const reason = result.kind === 'offline' ? 'offline' : 'invalid';

    return NextResponse.redirect(new URL(`/login?provider=${reason}`, origin));
  }

  await writeSession(buildSession(result.data, cookies));

  const next = safeRedirect(request.nextUrl.searchParams.get('next'));

  return NextResponse.redirect(new URL(next, origin));
}
