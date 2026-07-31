import type { HubRealtimeEvent, HubSubscription } from './types';

/**
 * Canal de tempo real do Hub.
 *
 * O servidor manda `{ type: 'event', event: <envelope> }` por um WebSocket; o
 * envelope traz `type`, `aggregate` e `data`. Aqui só se extrai o que o chat
 * consome — conversa e mensagem — e o resto é ignorado: a extensão não precisa
 * conhecer o catálogo inteiro de eventos do Hub para exibir uma conversa.
 *
 * Reconectar **não** é responsabilidade desta camada. O token vale uma conexão
 * só, então reabrir exige pedir outro — quem chama decide se vale a pena.
 */
export interface RealtimeHandlers {
  readonly onEvent: (event: HubRealtimeEvent) => void;
  /** Motivo já pronto para o log. Nunca inclui o token. */
  readonly onError: (message: string) => void;
}

export function openRealtime(url: string, handlers: RealtimeHandlers): HubSubscription {
  const socket = new WebSocket(url);

  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed = parseFrame(event.data);

    if (parsed !== null) {
      handlers.onEvent(parsed);
    }
  });

  socket.addEventListener('error', () => {
    // O evento de erro do WebSocket não carrega motivo utilizável, e o que ele
    // carrega pode incluir a URL — que tem o token na query.
    handlers.onError('conexão interrompida');
  });

  return {
    close: () => {
      // `CLOSING` e `CLOSED` já estão a caminho; fechar de novo lançaria.
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}

/**
 * Lê um quadro do socket.
 *
 * Quadro que não é evento — `welcome`, `error`, heartbeat — devolve `null` em
 * silêncio. Eles fazem parte do protocolo e não são falha; tratá-los como erro
 * encheria o log a cada batida do coração.
 */
export function parseFrame(raw: unknown): HubRealtimeEvent | null {
  if (typeof raw !== 'string') {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(payload) || payload['type'] !== 'event') {
    return null;
  }

  const envelope = payload['event'];

  if (!isRecord(envelope)) {
    return null;
  }

  const type = envelope['type'];

  if (typeof type !== 'string' || type === '') {
    return null;
  }

  const aggregate = envelope['aggregate'];
  const data = isRecord(envelope['data']) ? envelope['data'] : {};

  // A conversa pode vir como o agregado do evento ou como campo do dado,
  // dependendo de quem publicou. As duas formas valem.
  const fromAggregate =
    isRecord(aggregate) && aggregate['type'] === 'conversation' ? aggregate['id'] : undefined;

  return {
    type,
    conversationId: text(fromAggregate) ?? text(data['conversationId']),
    messageId: text(data['messageId']) ?? text(data['id']),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
