/**
 * A máquina de uma sessão WebSocket — os cinco passos do `Docs/08`.
 *
 * ```text
 * 1. cliente obtém token curto em GET /v1/realtime/token
 * 2. conecta em GET /v1/realtime?token=…
 * 3. envia `hello` com versão, dispositivo e inscrições
 * 4. servidor responde `welcome`
 * 5. cliente retoma a partir do último cursor
 * ```
 *
 * O que acontece em cada falha, explicitamente:
 *
 * | Falha                                   | Resposta                                   |
 * | --------------------------------------- | ------------------------------------------ |
 * | sem token, token inválido ou já usado   | `error TOKEN_INVALID`, fecha 4001          |
 * | token expirado                          | `error TOKEN_EXPIRED`, fecha 4001          |
 * | `hello` não chega no prazo              | fecha 4003                                 |
 * | `protocolVersion` diferente             | `PROTOCOL_VERSION_UNSUPPORTED`, fecha 4003 |
 * | JSON quebrado ou mensagem desconhecida  | `INTERNAL_ERROR` retryable, segue          |
 * | mensagem grande demais                  | `PAYLOAD_TOO_LARGE`, fecha 1009            |
 * | mensagens demais por janela             | `RATE_LIMITED`, fecha 1008                 |
 * | nenhuma inscrição autorizada            | `SUBSCRIPTION_DENIED`, fecha 4001          |
 * | acesso revogado durante a conexão       | `SUBSCRIPTION_DENIED`; sem sobrar, 4001    |
 * | cliente lento                           | `BACKPRESSURE`; três seguidos, fecha 4002  |
 * | silêncio além do tempo                  | fecha 4000                                 |
 *
 * O `welcome` sai **antes** dos eventos retomados, e a conexão entra no fanout
 * **antes** de o backlog ser lido — ver `connection.hold()` para o porquê.
 */

import { clientMessageSchema, REALTIME_PROTOCOL_VERSION } from '@prometheon/contracts';
import { newId } from '@prometheon/database';
import { child } from '@prometheon/logger';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import type { AppConfig } from '../../config/index.js';
import type { RedisClient } from '../../plugins/redis.js';
import { CLOSE_CODES, RealtimeConnection } from './connection.js';
import type { RealtimeHub } from './hub.js';
import type { RealtimeKeys } from './keys.js';
import type { RealtimeService } from './service.js';
import { REALTIME_SETTINGS } from './settings.js';
import { verifyRealtimeToken } from './token.js';
import type { RealtimePrincipal } from './types.js';

const logger = child('realtime');

/** Prazo para o `hello` chegar depois de a conexão subir. */
const HELLO_TIMEOUT_MS = 10_000;

export interface SessionDependencies {
  readonly config: AppConfig;
  readonly redis: RedisClient;
  readonly hub: RealtimeHub;
  readonly service: RealtimeService;
  readonly keys: RealtimeKeys;
}

/** Token da query string ou do header, nesta ordem. */
function readToken(request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.['token'];

  if (typeof fromQuery === 'string' && fromQuery !== '') {
    return fromQuery;
  }

  const header = request.headers.authorization;

  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const value = header.slice(7).trim();

    return value === '' ? undefined : value;
  }

  return undefined;
}

/**
 * Queima o `jti` do token.
 *
 * O token viaja na query string porque nenhum navegador permite header em
 * `new WebSocket(...)`. Query string aparece em log de proxy e em histórico, e é
 * por isso que ele vale **uma conexão só**: `SET NX` devolve `null` na segunda
 * tentativa, e a segunda tentativa é justamente o replay.
 */
async function burnToken(
  redis: RedisClient,
  keys: RealtimeKeys,
  tokenId: string,
): Promise<boolean> {
  const result = await redis.set(
    keys.handshakeToken(tokenId),
    '1',
    'EX',
    REALTIME_SETTINGS.tokenTtlSeconds + 5,
    'NX',
  );

  return result !== null;
}

/** Mensagens aceitas antes de o handshake estar pronto para processá-las. */
const PENDING_MESSAGE_LIMIT = 8;

export async function handleRealtimeConnection(
  socket: WebSocket,
  request: FastifyRequest,
  deps: SessionDependencies,
): Promise<void> {
  /**
   * O `message` é escutado **antes** de qualquer `await`.
   *
   * Um cliente correto manda o `hello` no mesmo instante em que o socket abre,
   * e o `ws` não guarda o que chega sem ouvinte. Se o listener só fosse
   * registrado depois de conferir o token no Redis e o principal no MySQL, o
   * `hello` sumiria — e o cliente ficaria esperando para sempre um `welcome`
   * que nunca sairia. É uma corrida que só aparece sob latência, e o resultado
   * dela é a pior falha possível: socket aberto e mudo.
   */
  const pending: { raw: Buffer; isBinary: boolean }[] = [];
  // Estado mutável num objeto: os callbacks abaixo escrevem nele, e o
  // compilador não estreitaria um `let` alterado dentro de um callback.
  const state: {
    handle: ((raw: Buffer, isBinary: boolean) => void) | undefined;
    aborted: boolean;
  } = { handle: undefined, aborted: false };

  socket.on('message', (raw: Buffer, isBinary: boolean) => {
    if (state.handle !== undefined) {
      state.handle(raw, isBinary);

      return;
    }

    // Teto pequeno: antes do `hello` a conexão ainda não provou nada, e uma
    // fila sem limite aqui seria memória grátis para quem só abre sockets.
    if (pending.length < PENDING_MESSAGE_LIMIT) {
      pending.push({ raw, isBinary });
    }
  });

  socket.once('close', () => {
    state.aborted = true;
  });

  const token = readToken(request);

  if (token === undefined) {
    socket.close(CLOSE_CODES.unauthorized, 'missing token');

    return;
  }

  let principal: RealtimePrincipal;
  let tokenId: string;

  try {
    const claims = await verifyRealtimeToken(deps.config, token);

    principal = {
      userId: claims.userId,
      kind: claims.kind,
      sessionId: claims.sessionId,
      deviceId: claims.deviceId,
      organizationId: claims.organizationId,
    };
    tokenId = claims.tokenId;
  } catch {
    socket.close(CLOSE_CODES.unauthorized, 'invalid token');

    return;
  }

  if (!(await burnToken(deps.redis, deps.keys, tokenId))) {
    socket.close(CLOSE_CODES.unauthorized, 'token already used');

    return;
  }

  // A credencial pode ter sido revogada entre a emissão do token e a conexão.
  if (!(await deps.service.principalStillValid(principal))) {
    socket.close(CLOSE_CODES.unauthorized, 'credential revoked');

    return;
  }

  if (state.aborted) {
    return;
  }

  const connection = new RealtimeConnection({
    id: newId(),
    socket,
    principal,
    onBackpressure: (target) => {
      if (target.backpressureStrikes >= REALTIME_SETTINGS.maxBackpressureStrikes) {
        target.close(CLOSE_CODES.backpressure, 'client too slow');
      }
    },
  });

  deps.hub.register(connection);

  let helloReceived = false;
  const helloTimer = setTimeout(() => {
    if (!helloReceived) {
      connection.close(CLOSE_CODES.protocol, 'hello timeout');
    }
  }, HELLO_TIMEOUT_MS);

  helloTimer.unref();

  const finish = (): void => {
    clearTimeout(helloTimer);
    void deps.hub.detach(connection).catch((error: unknown) => {
      logger.warn({ err: error }, 'realtime: falha ao desconectar');
    });
  };

  socket.on('pong', () => {
    connection.touch();
  });

  socket.on('close', finish);
  socket.on('error', (error: unknown) => {
    logger.debug({ err: error }, 'realtime: socket com erro');
    finish();
  });

  /**
   * Processa uma mensagem. As chamadas são **serializadas** por `handle`: um
   * `subscribe` seguido de um `unsubscribe` não pode terminar na ordem inversa
   * só porque o primeiro foi ao banco e o segundo não.
   */
  const handleMessage = async (raw: Buffer, isBinary: boolean): Promise<void> => {
    connection.touch();

    if (isBinary) {
      connection.sendError('INTERNAL_ERROR', 'Only text frames are accepted.', false);

      return;
    }

    if (raw.byteLength > REALTIME_SETTINGS.maxIncomingPayloadBytes) {
      connection.sendError('PAYLOAD_TOO_LARGE', 'The message is too large.', false);
      connection.close(CLOSE_CODES.tooLarge, 'payload too large');

      return;
    }

    if (!connection.admitIncoming()) {
      connection.sendError('RATE_LIMITED', 'Too many messages on this connection.', true);
      connection.close(CLOSE_CODES.policyViolation, 'too many messages');

      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      connection.sendError('INTERNAL_ERROR', 'The message is not valid JSON.', false);

      return;
    }

    const message = clientMessageSchema.safeParse(parsed);

    if (!message.success) {
      connection.sendError('INTERNAL_ERROR', 'The message does not match the protocol.', false);

      return;
    }

    switch (message.data.type) {
      case 'hello': {
        if (helloReceived) {
          connection.sendError('INTERNAL_ERROR', 'hello was already received.', false);

          return;
        }

        helloReceived = true;
        clearTimeout(helloTimer);

        if (message.data.protocolVersion !== REALTIME_PROTOCOL_VERSION) {
          connection.sendError(
            'PROTOCOL_VERSION_UNSUPPORTED',
            `This server speaks protocol version ${String(REALTIME_PROTOCOL_VERSION)}.`,
            false,
          );
          connection.close(CLOSE_CODES.protocol, 'unsupported protocol version');

          return;
        }

        await openSession(connection, deps, message.data.subscriptions, message.data.cursor);

        return;
      }

      case 'subscribe': {
        if (!connection.ready) {
          connection.sendError('INTERNAL_ERROR', 'Send hello first.', false);

          return;
        }

        await changeSubscriptions(connection, deps, message.data.subscriptions, 'add');

        return;
      }

      case 'unsubscribe': {
        if (!connection.ready) {
          connection.sendError('INTERNAL_ERROR', 'Send hello first.', false);

          return;
        }

        await changeSubscriptions(connection, deps, message.data.subscriptions, 'remove');

        return;
      }

      case 'ping': {
        connection.send({
          type: 'pong',
          sentAt: message.data.sentAt,
          serverTime: new Date().toISOString(),
        });

        return;
      }

      case 'ack': {
        // O `ack` é o que permite ao servidor esquecer o que já foi
        // processado: depois de um estouro de fila, é a partir dele que a
        // conexão volta a contar.
        connection.acknowledgedCursor = message.data.cursor;

        return;
      }

      default: {
        connection.sendError('INTERNAL_ERROR', 'Unknown message type.', false);
      }
    }
  };

  const queue: { chain: Promise<void> } = { chain: Promise.resolve() };

  state.handle = (raw: Buffer, isBinary: boolean): void => {
    queue.chain = queue.chain
      .then(async () => handleMessage(raw, isBinary))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'realtime: falha ao processar mensagem');
        connection.sendError('INTERNAL_ERROR', 'The server failed to process the message.', true);
      });
  };

  // Drena o que chegou enquanto o handshake era conferido, na ordem original.
  for (const message of pending.splice(0)) {
    state.handle(message.raw, message.isBinary);
  }
}

/** Passos 3 a 5: autoriza, ativa, responde `welcome` e retoma. */
async function openSession(
  connection: RealtimeConnection,
  deps: SessionDependencies,
  requested: readonly { organizationId: string; projectId: string | null; eventTypes: readonly string[] }[],
  cursor: string | null,
): Promise<void> {
  const decision = await deps.service.authorizeSubscriptions(connection.principal, requested);

  if (decision.granted.length === 0) {
    const reason = decision.denied[0]?.reason ?? 'No subscription was authorized.';

    connection.sendError('SUBSCRIPTION_DENIED', reason, false);
    connection.close(CLOSE_CODES.unauthorized, 'no authorized subscription');

    return;
  }

  for (const denied of decision.denied) {
    connection.sendError('SUBSCRIPTION_DENIED', denied.reason, false);
  }

  connection.subscriptions = decision.granted;
  // Retém o ao vivo antes de entrar no fanout: nada pode escapar entre a última
  // linha do backlog e a primeira mensagem do canal.
  connection.hold();

  await deps.hub.activate(connection);

  const resumed = await deps.service.resume(decision.granted, cursor);
  const events = resumed.events.filter((envelope) => connection.wants(envelope));

  connection.send({
    type: 'welcome',
    protocolVersion: REALTIME_PROTOCOL_VERSION,
    sessionId: connection.id,
    serverTime: new Date().toISOString(),
    heartbeatIntervalMs: REALTIME_SETTINGS.heartbeatIntervalMs,
    resumeCursor: cursor,
    resumeGap: resumed.gap,
    subscriptions: decision.granted.map((subscription) => ({
      organizationId: subscription.organizationId,
      projectId: subscription.projectId,
      eventTypes: [...subscription.eventTypes],
    })),
  });

  // Desliga a retenção **antes** de entregar o backlog: com ela ligada, o
  // próprio backlog seria retido em vez de sair.
  const held = connection.stopHolding();
  const sent = new Set<string>();

  for (const envelope of events) {
    connection.deliver(envelope);
    sent.add(envelope.id);
  }

  // O que chegou ao vivo durante a leitura do backlog vai em seguida, sem
  // repetir o que já saiu. A dedup por `id` é obrigação do cliente de qualquer
  // forma — a entrega é pelo menos uma vez —, mas repetir de propósito seria
  // desperdício previsível.
  for (const envelope of held) {
    if (!sent.has(envelope.id)) {
      connection.deliver(envelope);
    }
  }
}

/** `subscribe` e `unsubscribe` refazem o conjunto inteiro e reativam. */
async function changeSubscriptions(
  connection: RealtimeConnection,
  deps: SessionDependencies,
  changed: readonly { organizationId: string; projectId: string | null; eventTypes: readonly string[] }[],
  mode: 'add' | 'remove',
): Promise<void> {
  const identity = (organizationId: string, projectId: string | null): string =>
    `${organizationId}|${projectId ?? ''}`;

  const current = new Map(
    connection.subscriptions.map((subscription) => [
      identity(subscription.organizationId, subscription.projectId),
      subscription,
    ]),
  );

  if (mode === 'remove') {
    for (const subscription of changed) {
      current.delete(identity(subscription.organizationId, subscription.projectId));
    }

    connection.subscriptions = [...current.values()];

    if (connection.subscriptions.length === 0) {
      connection.close(CLOSE_CODES.normal, 'no subscription left');
      await deps.hub.detach(connection);

      return;
    }

    await deps.hub.activate(connection);

    return;
  }

  const decision = await deps.service.authorizeSubscriptions(connection.principal, changed);

  for (const denied of decision.denied) {
    connection.sendError('SUBSCRIPTION_DENIED', denied.reason, false);
  }

  for (const subscription of decision.granted) {
    current.set(identity(subscription.organizationId, subscription.projectId), subscription);
  }

  if (current.size > REALTIME_SETTINGS.maxSubscriptions) {
    connection.sendError(
      'INTERNAL_ERROR',
      `A connection accepts at most ${String(REALTIME_SETTINGS.maxSubscriptions)} subscriptions.`,
      false,
    );

    return;
  }

  connection.subscriptions = [...current.values()];

  await deps.hub.activate(connection);
}
