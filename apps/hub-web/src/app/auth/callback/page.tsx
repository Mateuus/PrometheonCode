import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { hubRequestWithCookies } from '@/lib/api/client';
import { loginResultSchema } from '@/lib/api/schemas';
import { buildSession, writeSession } from '@/lib/auth/session';
import { safeRedirect } from '@/lib/auth/safe-redirect';

export const metadata: Metadata = { title: 'Signing in' };

/**
 * Volta do login por provedor externo.
 *
 * A API terminou a conversa com o GitHub e mandou o navegador para cá com um
 * código de handoff — que **não** é um token: ele vale trinta segundos, serve
 * uma vez e só troca por sessão de dentro do servidor. Mandar o access token na
 * URL teria sido mais simples e teria deixado a credencial no histórico do
 * navegador e no `Referer` de toda requisição seguinte.
 *
 * A troca acontece aqui, no servidor, e o resultado vira o mesmo cookie
 * `HttpOnly` que o login por senha produz. Do ponto de vista do resto do Hub Web
 * não existe "sessão de provedor": existe sessão.
 *
 * A página não renderiza nada. Ou redireciona para onde a pessoa ia, ou devolve
 * ao login com o motivo — ficar numa tela intermediária depois de já ter
 * autorizado no GitHub só faria a pessoa se perguntar se deu certo.
 */
export default async function ProviderCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.code;
  const code = Array.isArray(raw) ? raw[0] : raw;

  if (typeof code !== 'string' || code === '') {
    redirect('/login?provider=invalid');
  }

  const { result, cookies } = await hubRequestWithCookies('/v1/auth/oauth/exchange', loginResultSchema, {
    method: 'POST',
    body: { code },
    browserOrigin: true,
  });

  if (!result.ok) {
    redirect(`/login?provider=${result.kind === 'offline' ? 'offline' : 'invalid'}`);
  }

  await writeSession(buildSession(result.data, cookies));

  const next = params.next;

  redirect(safeRedirect(Array.isArray(next) ? next[0] : next));
}
