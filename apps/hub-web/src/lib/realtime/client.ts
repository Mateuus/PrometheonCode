import type { RealtimeEventType } from '@/lib/api/types';

/**
 * Canal ao vivo do Hub Web.
 *
 * A conexão é um sistema externo ao React, então ela vive numa store lida por
 * `useSyncExternalStore`. Não é preciosismo: `setState` dentro de efeito para
 * espelhar o socket gera renderização em cascata e, no servidor, um primeiro
 * quadro que discorda do cliente.
 *
 * O protocolo é o do `Docs/08`:
 *
 * 1. `/api/realtime/ticket` devolve um bilhete curto, de **uso único** — o
 *    navegador nunca vê o token de acesso, que fica no cookie `HttpOnly`.
 * 2. A conexão abre em `ws(s)://…/v1/realtime?token=…`, porque `new WebSocket`
 *    não manda cabeçalho.
 * 3. O cliente manda `hello` com as inscrições e o último `cursor` conhecido.
 * 4. O servidor responde `welcome`; se vier `resumeGap: true`, houve buraco na
 *    retomada e o estado precisa ser recarregado por REST.
 *
 * Entrega é pelo menos uma vez: eventos repetidos são descartados por `id`.
 */

export type ConnectionStatus = 'online' | 'offline' | 'reconnecting';

export interface ConnectionValue {
  status: ConnectionStatus;
  /** Tentativa de reconexão em curso. `0` quando a conexão está boa. */
  attempt: number;
}

export interface RealtimeEnvelope {
  id: string;
  type: RealtimeEventType;
  organizationId: string;
  projectId: string | null;
  occurredAt: string;
  cursor: string;
  data: Record<string, unknown>;
  aggregate?: { type: string; id: string; sequence: number | null };
}

/** Avisa que a retomada falhou e o estado precisa vir de novo pelo REST. */
export interface ResyncSignal {
  kind: 'resync';
}

export type RealtimeListener = (event: RealtimeEnvelope | ResyncSignal) => void;

const SERVER_SNAPSHOT: ConnectionValue = { status: 'online', attempt: 0 };

/** Acima disto a interface para de prometer "já volta" e assume o offline. */
const RECONNECTING_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Quantos ids de evento guardar para descartar repetição. */
const SEEN_LIMIT = 512;

interface Subscription {
  organizationId: string;
  projectId: string | null;
  eventTypes: RealtimeEventType[];
}

let snapshot: ConnectionValue = SERVER_SNAPSHOT;
const statusListeners = new Set<() => void>();
const eventListeners = new Set<RealtimeListener>();

let socket: WebSocket | null = null;
let subscription: Subscription | null = null;
let attempt = 0;
let cursor: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let ackTimer: ReturnType<typeof setTimeout> | undefined;
let closedByUs = false;
const seen = new Set<string>();

function publish(next: ConnectionValue): void {
  if (snapshot.status === next.status && snapshot.attempt === next.attempt) {
    return;
  }
  snapshot = next;
  for (const listener of statusListeners) {
    listener();
  }
}

function emit(event: RealtimeEnvelope | ResyncSignal): void {
  for (const listener of eventListeners) {
    listener(event);
  }
}

/**
 * Traduz a tentativa em curso no estado que a interface mostra.
 *
 * As primeiras tentativas são "reconectando", porque quedas curtas são o caso
 * comum e a promessa de "já volta" se sustenta. Depois disso a interface para de
 * prometer e assume o offline — sem deixar de tentar por baixo.
 */
export function statusForAttempt(current: number): ConnectionStatus {
  if (current === 0) {
    return 'online';
  }
  return current <= RECONNECTING_ATTEMPTS ? 'reconnecting' : 'offline';
}

/** Recuo exponencial com teto. O sobressalto é somado por quem agenda. */
export function backoffDelay(currentAttempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (currentAttempt - 1), BACKOFF_MAX_MS);
}

function clearTimers(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (ackTimer) {
    clearTimeout(ackTimer);
    ackTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (retryTimer || closedByUs || !subscription) {
    return;
  }
  attempt += 1;
  publish({ status: statusForAttempt(attempt), attempt });

  // Recuo exponencial com sobressalto: sem o sobressalto, todas as abas abertas
  // voltariam no mesmo milissegundo depois de uma queda do Hub.
  const delay = backoffDelay(attempt);
  const jitter = Math.random() * Math.min(delay, 1_000);

  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void open();
  }, delay + jitter);
}

function remember(id: string): boolean {
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  if (seen.size > SEEN_LIMIT) {
    // `Set` preserva ordem de inserção: o primeiro é o mais velho.
    const oldest = seen.values().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
  return true;
}

function acknowledge(): void {
  if (ackTimer || !cursor) {
    return;
  }
  ackTimer = setTimeout(() => {
    ackTimer = undefined;
    if (socket?.readyState === WebSocket.OPEN && cursor) {
      socket.send(JSON.stringify({ type: 'ack', cursor }));
    }
  }, 1_000);
}

function handleMessage(raw: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return;
  }

  const typed = message as { type: string; [key: string]: unknown };

  if (typed.type === 'welcome') {
    attempt = 0;
    publish({ status: 'online', attempt: 0 });
    const resumeCursor = typed.resumeCursor;
    if (typeof resumeCursor === 'string') {
      cursor = resumeCursor;
    }
    if (typed.resumeGap === true) {
      // Buraco na retomada: o que passou não chega mais por aqui.
      emit({ kind: 'resync' });
    }
    // O intervalo chega pela rede. Um valor absurdo — zero, negativo, NaN —
    // transformaria o heartbeat em laço apertado de `send`, então ele fica
    // preso a uma faixa sã antes de virar timer.
    const proposto =
      typeof typed.heartbeatIntervalMs === 'number' && Number.isFinite(typed.heartbeatIntervalMs)
        ? Math.trunc(typed.heartbeatIntervalMs)
        : 30_000;
    const interval = Math.min(Math.max(proposto, 5_000), 300_000);
    clearTimers();
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping', sentAt: new Date().toISOString() }));
      }
    }, interval);
    return;
  }

  if (typed.type === 'event' && typeof typed.event === 'object' && typed.event !== null) {
    const envelope = typed.event as RealtimeEnvelope;
    if (typeof envelope.id !== 'string' || !remember(envelope.id)) {
      return;
    }
    cursor = envelope.cursor;
    acknowledge();
    emit(envelope);
    return;
  }

  if (typed.type === 'error') {
    // Erro de protocolo derruba a conexão; o `onclose` agenda a volta.
    socket?.close();
  }
}

async function open(): Promise<void> {
  if (!subscription || closedByUs || typeof window === 'undefined') {
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  let ticket: { token: string; url: string; heartbeatIntervalMs: number };
  try {
    const response = await fetch('/api/realtime/ticket', { cache: 'no-store' });
    if (!response.ok) {
      scheduleReconnect();
      return;
    }
    ticket = (await response.json()) as typeof ticket;
  } catch {
    scheduleReconnect();
    return;
  }

  const next = new WebSocket(`${ticket.url}?token=${encodeURIComponent(ticket.token)}`);
  socket = next;

  next.addEventListener('open', () => {
    // O servidor derruba quem não se apresenta em 10 s. Campos nulos são
    // obrigatórios e explícitos: é assim que ele distingue "não informado" de
    // "informado como vazio".
    next.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        deviceId: null,
        clientVersion: 'hub-web',
        subscriptions: [subscription],
        cursor,
      }),
    );
  });

  next.addEventListener('message', (event: MessageEvent<string>) => {
    handleMessage(typeof event.data === 'string' ? event.data : '');
  });

  next.addEventListener('close', () => {
    clearTimers();
    if (socket === next) {
      socket = null;
    }
    if (!closedByUs) {
      scheduleReconnect();
    }
  });

  next.addEventListener('error', () => {
    next.close();
  });
}

/** Liga o canal para uma organização (e, quando houver, um projeto). */
export function connect(target: Subscription): void {
  const changed =
    subscription?.organizationId !== target.organizationId ||
    subscription?.projectId !== target.projectId;

  subscription = target;
  closedByUs = false;

  if (changed && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'subscribe', subscriptions: [target] }));
    return;
  }
  void open();
}

export function disconnect(): void {
  closedByUs = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  clearTimers();
  socket?.close();
  socket = null;
  attempt = 0;
  publish(SERVER_SNAPSHOT);
}

export function subscribeToStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function subscribeToEvents(listener: RealtimeListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function getStatusSnapshot(): ConnectionValue {
  return snapshot;
}

export function getServerStatusSnapshot(): ConnectionValue {
  return SERVER_SNAPSHOT;
}

/** Só os testes precisam disto: devolve a store ao estado de partida. */
export function resetRealtimeForTests(): void {
  disconnect();
  subscription = null;
  cursor = null;
  seen.clear();
  eventListeners.clear();
}
