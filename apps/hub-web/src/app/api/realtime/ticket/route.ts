import { NextResponse } from 'next/server';
import { accessToken } from '@/lib/auth/session';
import { hubRequest } from '@/lib/api/client';
import { realtimeTicketSchema } from '@/lib/api/schemas';

/**
 * Bilhete de conexão do canal ao vivo.
 *
 * O navegador não tem — e não pode ter — o token de acesso: ele mora num cookie
 * `HttpOnly` que só o servidor lê. Mas `new WebSocket()` não manda cabeçalho, e
 * é por isso que a Hub API emite um bilhete curto, de uso único, que viaja na
 * query da conexão.
 *
 * Esta rota é a única ponte: recebe a sessão pelo cookie, pede o bilhete à API
 * e devolve ao cliente só o necessário para abrir o socket. O bilhete vale 60
 * segundos e uma conexão — reconectar exige pedir outro, e é isso que a store
 * de conexão faz a cada tentativa.
 */
export async function GET(): Promise<NextResponse> {
  const token = await accessToken();
  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await hubRequest('/v1/realtime/token', realtimeTicketSchema, {
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
      protocolVersion: result.data.protocolVersion,
      heartbeatIntervalMs: result.data.heartbeatIntervalMs,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
