/**
 * Ditado por voz — o que precisa valer independente do serviço de transcrição
 * estar no ar.
 *
 * A suíte não fala com o Applio: o que está sob teste é a fronteira do Hub — o
 * bilhete que autoriza a conexão e a leitura da saúde do serviço. O caminho do
 * áudio em si é exercitado do outro lado, em `Applio/api/streaming.py`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyRealtimeToken } from '../modules/realtime/token.js';
import { issueTranscriptionTicket, verifyTranscriptionTicket } from '../modules/transcription/token.js';
import { checkUpstreamHealth, upstreamSocketUrl } from '../modules/transcription/upstream.js';
import { testConfig } from './support.js';

const config = testConfig();

function ticketFor(userId = 'usr_1'): Promise<{ token: string }> {
  return issueTranscriptionTicket(config, {
    userId,
    kind: 'user',
    organizationId: 'org_1',
    ticketId: `tkt_${userId}`,
  });
}

describe('bilhete de ditado', () => {
  it('sobrevive à ida e volta preservando quem é', async () => {
    const issued = await issueTranscriptionTicket(config, {
      userId: 'usr_42',
      kind: 'user',
      organizationId: 'org_9',
      ticketId: 'tkt_42',
    });

    const claims = await verifyTranscriptionTicket(config, issued.token);

    expect(claims.userId).toBe('usr_42');
    expect(claims.organizationId).toBe('org_9');
    expect(claims.ticketId).toBe('tkt_42');
  });

  /**
   * O ponto que justifica os dois módulos compartilharem `AUTH_REALTIME_TOKEN_SECRET`.
   *
   * A separação é feita pelo público do JWT, não pela chave. Se ela falhar, um
   * bilhete de ditado vazado em log de proxy abriria também o canal de eventos
   * da organização — e o contrário deixaria qualquer conexão de tempo real
   * consumir uma vaga de inferência. Os dois sentidos são testados porque um
   * `audience` esquecido em qualquer um dos verificadores produz o mesmo furo.
   */
  it('não é aceito pelo canal de tempo real', async () => {
    const issued = await ticketFor();

    await expect(verifyRealtimeToken(config, issued.token)).rejects.toThrow();
  });

  it('não aceita um token de tempo real no lugar', async () => {
    const { issueRealtimeToken } = await import('../modules/realtime/token.js');

    const issued = await issueRealtimeToken(config, {
      userId: 'usr_1',
      kind: 'user',
      sessionId: 'ses_1',
      deviceId: null,
      organizationId: 'org_1',
      tokenId: 'tok_1',
    });

    await expect(verifyTranscriptionTicket(config, issued.token)).rejects.toThrow();
  });

  it('recusa um bilhete adulterado', async () => {
    const issued = await ticketFor();
    const [header, payload] = issued.token.split('.');

    await expect(
      verifyTranscriptionTicket(config, `${header}.${payload}.assinaturaerrada`),
    ).rejects.toThrow();
  });
});

describe('endereço do serviço de transcrição', () => {
  it('deriva ws de http e wss de https', () => {
    expect(upstreamSocketUrl('http://applio:8000')).toBe('ws://applio:8000/ws/transcribe');
    expect(upstreamSocketUrl('https://voice.example.com')).toBe(
      'wss://voice.example.com/ws/transcribe',
    );
  });

  it('ignora o caminho da base em vez de concatená-lo', () => {
    // `new URL('/ws/transcribe', base)` substitui o caminho. Concatenar
    // produziria `/api/ws/transcribe`, que não existe do outro lado.
    expect(upstreamSocketUrl('http://applio:8000/api')).toBe('ws://applio:8000/ws/transcribe');
  });
});

describe('saúde do serviço de transcrição', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respondWith(body: unknown, ok = true): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) }),
    );
  }

  it('reconhece o serviço pronto', async () => {
    respondWith({
      status: 'healthy',
      streaming: { enabled: true, ready: true, model: 'large-v3-turbo', device: 'cuda' },
    });

    const health = await checkUpstreamHealth('http://applio:8000', 'chave');

    expect(health).toMatchObject({ reachable: true, enabled: true, ready: true, device: 'cuda' });
  });

  /**
   * O serviço responde ao HTTP muito antes de os pesos estarem na memória.
   * Tratar isso como pronto poria o microfone na tela antes de ele funcionar,
   * e o primeiro clique morreria sem explicação.
   */
  it('não anuncia pronto enquanto o modelo carrega', async () => {
    respondWith({ status: 'healthy', streaming: { enabled: true, ready: false } });

    const health = await checkUpstreamHealth('http://applio:8000', undefined);

    expect(health.reachable).toBe(true);
    expect(health.ready).toBe(false);
  });

  /**
   * Um Applio anterior a este trabalho responde `healthy` sem a seção
   * `streaming` — ele simplesmente não tem o endpoint de fluxo ao vivo. Aceitar
   * esse `healthy` como suficiente adiaria a falha para o primeiro clique.
   */
  it('trata um serviço sem suporte a streaming como indisponível', async () => {
    respondWith({ status: 'healthy', timestamp: '2026-07-31T00:00:00Z' });

    const health = await checkUpstreamHealth('http://applio:8000', undefined);

    expect(health.reachable).toBe(true);
    expect(health.enabled).toBe(false);
    expect(health.ready).toBe(false);
  });

  it('trata serviço inalcançável como indisponível, sem lançar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(checkUpstreamHealth('http://applio:8000', undefined)).resolves.toMatchObject({
      reachable: false,
      ready: false,
    });
  });
});
