/**
 * Sessão de ditado: o navegador de um lado, o serviço de transcrição do outro.
 *
 * O Hub fica no meio porque é o único que sabe **quem** está falando. O serviço
 * de transcrição não conhece usuário, organização nem plano, e a chave dele não
 * pode chegar ao navegador — é a mesma regra que o `CLAUDE.md` impõe à webview
 * da extensão: quem alcança rede e segredo é o servidor.
 *
 * O que atravessa em cada sentido:
 *
 * - do navegador, só quadros binários de PCM e um `stop` de texto;
 * - do serviço, os eventos `ready`, `speech`, `partial`, `final` e `error`.
 *
 * Nada além disso é repassado. Um cliente que mande outra coisa está fora do
 * protocolo e a conexão cai — não porque seja perigoso, mas porque um proxy que
 * repassa o que não entende vira um túnel para o serviço interno.
 */

import type { FastifyRequest } from 'fastify';
import type { WebSocket as ClientSocket } from 'ws';

import type { AppConfig } from '../../config/index.js';
import type { RedisClient } from '../../plugins/redis.js';
import { CLOSE_CODES, TRANSCRIPTION_SETTINGS } from './settings.js';
import { verifyTranscriptionTicket } from './token.js';
import { connectUpstream } from './upstream.js';

export interface TranscriptionSessionDependencies {
  readonly config: AppConfig;
  readonly redis: RedisClient;
  readonly log: {
    warn(payload: unknown, message: string): void;
    error(payload: unknown, message: string): void;
  };
}

/** Bilhete queimado: `SET NX` devolve `null` na segunda tentativa, que é o replay. */
function ticketKey(ticketId: string): string {
  return `transcription:ticket:${ticketId}`;
}

/** Contador de sessões abertas de um usuário. */
function sessionCountKey(userId: string): string {
  return `transcription:sessions:${userId}`;
}

async function burnTicket(redis: RedisClient, ticketId: string): Promise<boolean> {
  const result = await redis.set(
    ticketKey(ticketId),
    '1',
    'EX',
    TRANSCRIPTION_SETTINGS.ticketTtlSeconds + 5,
    'NX',
  );

  return result !== null;
}

/**
 * Reserva uma vaga de sessão para o usuário.
 *
 * O TTL não é decoração: sem ele, um processo derrubado no meio de uma sessão
 * deixaria o contador para cima para sempre, e a pessoa perderia o ditado até
 * alguém limpar o Redis à mão. Com TTL, o pior caso se resolve sozinho no tempo
 * de uma sessão.
 */
async function reserveSlot(redis: RedisClient, userId: string): Promise<boolean> {
  const key = sessionCountKey(userId);
  const count = await redis.incr(key);

  await redis.expire(key, Math.ceil(TRANSCRIPTION_SETTINGS.maxSessionMs / 1000) + 30);

  if (count > TRANSCRIPTION_SETTINGS.maxConcurrentSessionsPerUser) {
    await redis.decr(key);

    return false;
  }

  return true;
}

async function releaseSlot(redis: RedisClient, userId: string): Promise<void> {
  const key = sessionCountKey(userId);
  const count = await redis.decr(key);

  // O contador nunca deveria ficar negativo, mas um `decr` a mais depois de um
  // reinício deixaria a chave abaixo de zero e o teto viraria mais folgado do
  // que o configurado — exatamente o oposto do que ele existe para fazer.
  if (count < 0) {
    await redis.del(key);
  }
}

function readTicket(request: FastifyRequest): string | undefined {
  const query = request.query as { ticket?: unknown } | undefined;
  const ticket = query?.ticket;

  return typeof ticket === 'string' && ticket !== '' ? ticket : undefined;
}

function readLanguage(request: FastifyRequest, fallback: string): string {
  const query = request.query as { language?: unknown } | undefined;
  const language = query?.language;

  // Códigos de idioma são curtos e alfanuméricos; qualquer outra coisa vai
  // direto para o `start` do serviço e não tem por que chegar lá.
  if (typeof language === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(language)) {
    return language;
  }

  return fallback;
}

/** Eventos que o serviço de transcrição pode emitir, e só eles. */
const UPSTREAM_EVENTS = new Set(['ready', 'speech', 'partial', 'final', 'error']);

export async function handleTranscriptionSession(
  socket: ClientSocket,
  request: FastifyRequest,
  deps: TranscriptionSessionDependencies,
): Promise<void> {
  const { config, redis, log } = deps;

  /**
   * Os quadros que chegam antes de o serviço estar conectado são guardados.
   *
   * O `ws` não retém o que chega sem ouvinte, e entre abrir o socket e o
   * serviço aceitar a conexão passam centenas de milissegundos — nos quais o
   * navegador já está gravando. Sem esta fila, o começo da primeira frase se
   * perde, e é justamente o pedaço que a pessoa percebe faltando.
   */
  const pending: Buffer[] = [];

  /**
   * Tudo o que muda durante a sessão, num objeto só.
   *
   * Agrupado — e lido por `isClosed()` em vez de `state.closed` — porque a
   * análise de fluxo do TypeScript não modela mutação vinda de callback: ela vê
   * a inicialização em `false`, não vê o `shutdown` disparado pelo evento de
   * fechamento do socket, e conclui que toda conferência depois de um `await` é
   * morta. A chamada de função interrompe esse estreitamento; ler o campo
   * direto faria o compilador apagar exatamente as guardas que existem para a
   * conexão que caiu no meio do handshake.
   */
  const state: {
    forward: ((frame: Buffer) => void) | undefined;
    closed: boolean;
    upstream: Awaited<ReturnType<typeof connectUpstream>> | undefined;
    slotUserId: string | undefined;
    idleTimer: NodeJS.Timeout | undefined;
    sessionTimer: NodeJS.Timeout | undefined;
  } = {
    forward: undefined,
    closed: false,
    upstream: undefined,
    slotUserId: undefined,
    idleTimer: undefined,
    sessionTimer: undefined,
  };

  const isClosed = (): boolean => state.closed;

  const send = (payload: unknown): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const shutdown = (code: number, reason: string): void => {
    if (isClosed()) {
      return;
    }

    state.closed = true;

    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
    }
    if (state.sessionTimer !== undefined) {
      clearTimeout(state.sessionTimer);
    }

    state.upstream?.close();

    if (socket.readyState === socket.OPEN) {
      socket.close(code, reason);
    }

    if (state.slotUserId !== undefined) {
      const userId = state.slotUserId;
      state.slotUserId = undefined;
      void releaseSlot(redis, userId).catch((error: unknown) => {
        log.warn({ err: error, userId }, 'transcription: falha ao liberar a vaga');
      });
    }
  };

  const touch = (): void => {
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      shutdown(CLOSE_CODES.exhausted, 'idle');
    }, TRANSCRIPTION_SETTINGS.idleTimeoutMs);
  };

  socket.on('message', (raw: Buffer, isBinary: boolean) => {
    touch();

    if (isBinary) {
      if (raw.byteLength > TRANSCRIPTION_SETTINGS.maxAudioFrameBytes) {
        shutdown(CLOSE_CODES.protocol, 'audio frame too large');

        return;
      }

      if (state.forward !== undefined) {
        state.forward(raw);
      } else if (pending.length * TRANSCRIPTION_SETTINGS.maxAudioFrameBytes < 2 * 1024 * 1024) {
        // Teto da fila em bytes, não em número de quadros: o que se quer limitar
        // é a memória que uma conexão ainda não autorizada consegue segurar.
        pending.push(raw);
      }

      return;
    }

    // O único controle que o cliente manda é `stop`. Ele repassa ao serviço,
    // que responde com o `final` do que estava em aberto antes de encerrar.
    let message: { type?: unknown };

    try {
      message = JSON.parse(raw.toString('utf8')) as { type?: unknown };
    } catch {
      shutdown(CLOSE_CODES.protocol, 'malformed control message');

      return;
    }

    if (message.type !== 'stop') {
      shutdown(CLOSE_CODES.protocol, 'unsupported control message');

      return;
    }

    state.upstream?.send(JSON.stringify({ type: 'stop' }));
  });

  socket.once('close', () => {
    shutdown(1000, 'client closed');
  });

  socket.once('error', () => {
    shutdown(1011, 'client error');
  });

  if (!config.transcription.enabled || config.transcription.url === undefined) {
    send({ type: 'error', code: 'DISABLED', message: 'Voice dictation is not enabled.' });
    shutdown(CLOSE_CODES.unavailable, 'disabled');

    return;
  }

  const ticket = readTicket(request);

  if (ticket === undefined) {
    shutdown(CLOSE_CODES.unauthorized, 'missing ticket');

    return;
  }

  let userId: string;

  try {
    const claims = await verifyTranscriptionTicket(config, ticket);
    userId = claims.userId;

    if (!(await burnTicket(redis, claims.ticketId))) {
      shutdown(CLOSE_CODES.unauthorized, 'ticket already used');

      return;
    }
  } catch {
    shutdown(CLOSE_CODES.unauthorized, 'invalid ticket');

    return;
  }

  if (isClosed()) {
    return;
  }

  if (!(await reserveSlot(redis, userId))) {
    send({
      type: 'error',
      code: 'TOO_MANY_SESSIONS',
      message: 'Too many dictation sessions open.',
    });
    shutdown(CLOSE_CODES.exhausted, 'too many sessions');

    return;
  }

  state.slotUserId = userId;

  // A conexão pode ter caído durante as idas ao Redis. Sem esta conferência a
  // vaga acabou de ser reservada para um socket que já não existe, e ela só
  // seria devolvida quando o TTL expirasse.
  if (isClosed()) {
    await releaseSlot(redis, userId);
    state.slotUserId = undefined;

    return;
  }

  let upstream: Awaited<ReturnType<typeof connectUpstream>>;

  try {
    upstream = await connectUpstream(config.transcription.url, config.transcription.apiKey);
  } catch (error) {
    log.error({ err: error }, 'transcription: serviço de transcrição inalcançável');
    send({
      type: 'error',
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Transcription service is unavailable.',
    });
    shutdown(CLOSE_CODES.unavailable, 'upstream unavailable');

    return;
  }

  if (isClosed()) {
    upstream.close();

    return;
  }

  state.upstream = upstream;

  upstream.on('message', (raw: Buffer) => {
    let event: { type?: unknown };

    try {
      event = JSON.parse(raw.toString('utf8')) as { type?: unknown };
    } catch {
      return;
    }

    // Filtro de saída: o cliente só vê os eventos do contrato. Repassar
    // qualquer coisa que chegue transformaria este proxy num túnel de leitura
    // para um serviço que está numa rede fechada por um motivo.
    if (typeof event.type !== 'string' || !UPSTREAM_EVENTS.has(event.type)) {
      return;
    }

    send(event);
  });

  upstream.once('close', () => {
    shutdown(1000, 'upstream closed');
  });

  upstream.once('error', (error: unknown) => {
    log.warn({ err: error }, 'transcription: erro no serviço de transcrição');
    shutdown(CLOSE_CODES.unavailable, 'upstream error');
  });

  upstream.send(
    JSON.stringify({
      type: 'start',
      language: readLanguage(request, config.transcription.language),
    }),
  );

  state.forward = (frame: Buffer): void => {
    if (upstream.readyState !== upstream.OPEN) {
      return;
    }

    // Descarta em vez de enfileirar quando o serviço não vaza o que já foi
    // mandado. Áudio ao vivo velho não tem valor: guardá-lo só faria a
    // transcrição afundar cada vez mais atrás da fala, sem nunca alcançar.
    if (upstream.bufferedAmount > 4 * TRANSCRIPTION_SETTINGS.maxAudioFrameBytes) {
      return;
    }

    upstream.send(frame);
  };

  for (const frame of pending) {
    state.forward(frame);
  }
  pending.length = 0;

  state.sessionTimer = setTimeout(() => {
    shutdown(CLOSE_CODES.exhausted, 'session limit');
  }, TRANSCRIPTION_SETTINGS.maxSessionMs);

  touch();
}
