import { NextResponse } from 'next/server';
import { accessToken } from '@/lib/auth/session';
import { hubRequest } from '@/lib/api/client';
import { transcriptionTicketSchema } from '@/lib/api/schemas';

/**
 * Bilhete de conexão do ditado por voz.
 *
 * Mesma ponte que `/api/realtime/ticket`, e pelo mesmo motivo: o token de acesso
 * mora num cookie `HttpOnly` que só o servidor lê, e `new WebSocket()` não manda
 * cabeçalho. Esta rota troca a sessão por um bilhete curto, de uso único, que
 * pode viajar na query da conexão sem abrir nada por si só.
 *
 * Um bilhete por clique no microfone: ele vale uma conexão, e quem clicar de
 * novo pede outro.
 */
export async function GET(): Promise<NextResponse> {
  const token = await accessToken();
  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await hubRequest('/v1/transcription/ticket', transcriptionTicketSchema, {
    accessToken: token,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.code ?? result.kind },
      { status: result.kind === 'unauthorized' ? 401 : 503 },
    );
  }

  return NextResponse.json(
    {
      token: result.data.token,
      url: result.data.url,
      sampleRate: result.data.sampleRate,
      language: result.data.language,
      maxSessionMs: result.data.maxSessionMs,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
