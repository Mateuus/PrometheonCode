/**
 * Uma conexão WebSocket viva.
 *
 * Concentra as três garantias do `Docs/08` que só existem por conexão:
 *
 * **Backpressure.** O servidor nunca escreve direto no socket. Tudo entra numa
 * fila e sai enquanto o `bufferedAmount` do socket estiver abaixo do teto. Se a
 * fila passar do limite — cliente que não drena —, ela é **descartada inteira** e
 * o cliente recebe `BACKPRESSURE`, que para ele significa a mesma coisa que
 * perder a janela: recarregue por REST. Crescer sem limite não é opção; é como
 * um cliente parado no debugger derruba o processo inteiro.
 *
 * **Heartbeat.** Qualquer sinal do cliente — pong, mensagem, `ack` — renova
 * `lastSeenAt`. Um verificador externo (o hub) encerra quem passou do tempo. Sem
 * isso a lista de presença mente, porque um socket meio-aberto pode ficar
 * "conectado" por horas em uma rede que caiu.
 *
 * **Payload limitado.** O teto de bytes por mensagem é imposto pelo `ws`
 * (`maxPayload`); aqui fica o teto de mensagens por janela, que é o que contém
 * laço acidental no cliente.
 */

import type { WebSocket } from 'ws';

import { REALTIME_SETTINGS } from './settings.js';
import type { AuthorizedSubscription, RealtimeEnvelope, RealtimePrincipal } from './types.js';

/** Códigos de fechamento. 4000+ é a faixa reservada à aplicação. */
export const CLOSE_CODES = {
  normal: 1000,
  policyViolation: 1008,
  tooLarge: 1009,
  timeout: 4000,
  unauthorized: 4001,
  backpressure: 4002,
  protocol: 4003,
  shuttingDown: 4004,
} as const;

export type RealtimeErrorCode =
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'SUBSCRIPTION_DENIED'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'BACKPRESSURE'
  | 'INTERNAL_ERROR';

export interface ConnectionOptions {
  readonly id: string;
  readonly socket: WebSocket;
  readonly principal: RealtimePrincipal;
  /** Chamado quando o cliente estoura a fila; o hub decide se encerra. */
  readonly onBackpressure?: ((connection: RealtimeConnection) => void) | undefined;
}

export class RealtimeConnection {
  readonly id: string;
  readonly principal: RealtimePrincipal;
  readonly socket: WebSocket;
  readonly connectedAt = Date.now();

  /** Preenchido pelo `hello`; até lá a conexão não recebe evento algum. */
  subscriptions: AuthorizedSubscription[] = [];
  /** Organizações inscritas, para o hub indexar sem varrer as inscrições. */
  organizationIds = new Set<string>();
  /** `true` depois do `welcome`. */
  ready = false;
  /** Último cursor entregue; vira o ponto de retomada do cliente. */
  lastCursor: string | null = null;
  /** Último cursor confirmado pelo cliente com `ack`. */
  acknowledgedCursor: string | null = null;
  lastSeenAt = Date.now();

  readonly #queue: string[] = [];
  readonly #onBackpressure: ((connection: RealtimeConnection) => void) | undefined;

  /**
   * Eventos ao vivo retidos até o `welcome` sair.
   *
   * A conexão entra no fanout **antes** de o servidor calcular a retomada — o
   * contrário abriria um buraco entre a última linha lida do outbox e a primeira
   * mensagem do canal, e o cliente nunca saberia que ficou sem ela. O preço é
   * que os primeiros eventos ao vivo chegam antes da hora; retê-los aqui e
   * soltá-los depois do backlog preserva a ordem que o cliente espera.
   */
  #held: RealtimeEnvelope[] | undefined;

  #queuedBytes = 0;
  #writing = false;
  #closed = false;
  #backpressureStrikes = 0;
  #incomingCount = 0;
  #incomingWindowStart = Date.now();

  constructor(options: ConnectionOptions) {
    this.id = options.id;
    this.socket = options.socket;
    this.principal = options.principal;
    this.#onBackpressure = options.onBackpressure;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  /** Bytes ainda não escritos no socket. É a medida do atraso do cliente. */
  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get backpressureStrikes(): number {
    return this.#backpressureStrikes;
  }

  /** Renova a marca de vida. Chamado por qualquer sinal do cliente. */
  touch(): void {
    this.lastSeenAt = Date.now();
  }

  /** `true` quando o cliente passou do silêncio tolerado. */
  isStale(now: number = Date.now()): boolean {
    return now - this.lastSeenAt > REALTIME_SETTINGS.connectionTimeoutMs;
  }

  /**
   * Contabiliza uma mensagem recebida. `false` quando o cliente passou do teto
   * da janela — o chamador responde `RATE_LIMITED` e encerra.
   */
  admitIncoming(now: number = Date.now()): boolean {
    if (now - this.#incomingWindowStart >= REALTIME_SETTINGS.incomingMessageWindowMs) {
      this.#incomingWindowStart = now;
      this.#incomingCount = 0;
    }

    this.#incomingCount += 1;

    return this.#incomingCount <= REALTIME_SETTINGS.incomingMessageLimit;
  }

  /** Diz se esta conexão quer um envelope, segundo as inscrições autorizadas. */
  wants(envelope: RealtimeEnvelope): boolean {
    return this.subscriptions.some((subscription) => {
      if (subscription.organizationId !== envelope.organizationId) {
        return false;
      }

      // Inscrição de projeto só recebe o daquele projeto.
      if (subscription.projectId !== null) {
        if (subscription.projectId !== envelope.projectId) {
          return false;
        }
      } else if (envelope.projectId !== null) {
        // Inscrição de organização: evento sem projeto passa; evento de projeto
        // só passa se aquele projeto estiver na lista de visíveis. Ausência da
        // lista é tratada como "nada visível" — falhar fechado é o único jeito
        // seguro de errar aqui.
        if (subscription.allowedProjectIds?.has(envelope.projectId) !== true) {
          return false;
        }
      }

      return subscription.eventTypes.size === 0 || subscription.eventTypes.has(envelope.type);
    });
  }

  /** Envia uma mensagem de controle (`welcome`, `pong`, `error`). */
  send(message: Record<string, unknown>): void {
    this.#enqueue(JSON.stringify(message));
  }

  /** Começa a reter os eventos ao vivo. Chamado antes de calcular a retomada. */
  hold(): void {
    this.#held = [];
  }

  /**
   * Desliga a retenção e devolve o que foi retido.
   *
   * Devolver em vez de entregar é proposital: quem chama precisa mandar o
   * backlog **primeiro** e só depois estes, e para isso a retenção já tem de
   * estar desligada — do contrário o próprio backlog cairia na retenção.
   */
  stopHolding(): RealtimeEnvelope[] {
    const held = this.#held ?? [];

    this.#held = undefined;

    return held;
  }

  /** Envia um evento e avança o cursor entregue. */
  deliver(envelope: RealtimeEnvelope): void {
    const held = this.#held;

    if (held !== undefined) {
      // O teto vale também para o que está retido: um cliente que demora a
      // completar o handshake não pode acumular memória sem limite.
      if (held.length < REALTIME_SETTINGS.outboundQueueLimit) {
        held.push(envelope);
      }

      return;
    }

    this.lastCursor = envelope.cursor;
    this.#enqueue(JSON.stringify({ type: 'event', event: envelope }));
  }

  sendError(code: RealtimeErrorCode, message: string, retryable: boolean): void {
    this.send({ type: 'error', code, message, retryable });
  }

  close(code: number, reason: string): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#queue.length = 0;
    this.#queuedBytes = 0;

    try {
      // `reason` tem teto de 123 bytes no protocolo; passar disso lança.
      this.socket.close(code, reason.slice(0, 100));
    } catch {
      this.socket.terminate();
    }
  }

  #enqueue(payload: string): void {
    if (this.#closed) {
      return;
    }

    this.#queue.push(payload);
    this.#queuedBytes += payload.length;

    if (this.#queue.length > REALTIME_SETTINGS.outboundQueueLimit) {
      this.#overflow();

      return;
    }

    this.#flush();
  }

  /**
   * Fila cheia: descarta o acumulado e avisa.
   *
   * Descartar é a escolha certa entre as três disponíveis. Bloquear o produtor
   * faria um cliente lento atrasar todos os outros da mesma instância; crescer
   * sem limite troca uma conexão ruim por um processo morto. Descartar custa ao
   * cliente uma recarga por REST — que é exatamente o procedimento que ele já
   * tem para perda de janela.
   */
  #overflow(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
    this.#backpressureStrikes += 1;
    // O cursor entregue deixa de valer: o cliente precisa recarregar o estado,
    // não retomar de um ponto que nunca chegou até ele.
    this.lastCursor = this.acknowledgedCursor;

    const payload = JSON.stringify({
      type: 'error',
      code: 'BACKPRESSURE',
      message:
        'The connection fell behind and buffered events were dropped. Reload the state over REST before trusting the next events.',
      retryable: true,
    });

    this.#queue.push(payload);
    this.#queuedBytes = payload.length;
    this.#flush();

    this.#onBackpressure?.(this);
  }

  /** Escreve enquanto o socket aceitar. Reentrante por desenho. */
  #flush(): void {
    if (this.#writing || this.#closed) {
      return;
    }

    this.#writing = true;

    while (this.#queue.length > 0) {
      if (this.socket.bufferedAmount > REALTIME_SETTINGS.outboundBufferLimitBytes) {
        // Socket congestionado: para de escrever e volta quando o `ws` drenar.
        // O `setTimeout` não é polling caro — só existe enquanto há fila.
        this.#writing = false;
        setTimeout(() => {
          this.#flush();
        }, 25).unref();

        return;
      }

      const payload = this.#queue.shift();

      if (payload === undefined) {
        break;
      }

      this.#queuedBytes -= payload.length;
      // O parâmetro é anotado como `Error | null | undefined` de propósito: o
      // tipo publicado pelo `ws` promete `Error | undefined`, mas em caso de
      // **sucesso** o callback chega com `null`. Confiar no tipo aqui faz toda
      // escrita bem-sucedida parecer falha — e a conexão morre logo depois de
      // entregar o `welcome`, que é o sintoma mais confuso possível.
      this.socket.send(payload, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          this.close(CLOSE_CODES.normal, 'write failed');
        }
      });
    }

    this.#writing = false;
  }
}
