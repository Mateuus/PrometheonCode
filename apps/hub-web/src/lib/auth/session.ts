import 'server-only';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { isProduction } from '@/lib/env';

/**
 * Sessão do navegador.
 *
 * Os tokens vivem num cookie `HttpOnly` — o `Docs/05` proíbe credencial em
 * `localStorage`, e um cookie que o JavaScript não lê é o que sobra de honesto.
 * O cookie **não é fonte de autoridade**: quem decide o que o usuário pode
 * fazer é a Hub API, a cada requisição. Aqui ele só serve para (a) mandar o
 * `Authorization` e (b) desenhar o cabeçalho sem uma ida à rede.
 */

export const SESSION_COOKIE = 'prometheon_session';
export const THEME_COOKIE = 'prometheon_theme';

const sessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  }),
});

export type Session = z.infer<typeof sessionSchema>;

function encode(session: Session): string {
  return Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
}

function decode(raw: string): Session | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = sessionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function readSession(): Promise<Session | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  return raw ? decode(raw) : null;
}

export async function writeSession(session: Session): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, encode(session), {
    httpOnly: true,
    // `Secure` sempre em produção. Em desenvolvimento o Hub roda em 127.0.0.1
    // sem TLS, e um cookie Secure simplesmente não seria gravado.
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Token para o `Authorization` das chamadas de servidor. */
export async function accessToken(): Promise<string | undefined> {
  return (await readSession())?.accessToken;
}
