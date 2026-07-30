/**
 * O hub de tempo real de **uma instância** da API.
 *
 * A API roda em mais de um processo, e um cliente está conectado a exatamente
 * um deles. O fanout, então, não pode ser em memória: o `hub-worker` publica o
 * envelope em `<prefixo>realtime:org:<orgId>` no Redis, cada instância assina os
 * canais das organizações que **ela** tem conectadas, e entrega apenas aos seus
 * sockets. Uma instância sem ninguém de uma organização não assina o canal dela
 * — é o que evita que cada evento trafegue para todas as réplicas.
 *
 * Três relógios sustentam as garantias do `Docs/08`:
 *
 * | Relógio          | O que ele impede                                         |
 * | ---------------- | -------------------------------------------------------- |
 * | heartbeat        | socket meio-aberto contado como presente                  |
 * | varredura        | presença expirada que ninguém anunciou                    |
 * | revalidação      | token de realtime que sobrevive à revogação da permissão  |
 *
 * Os eventos de presença e de dispositivo **não passam pelo outbox**: são
 * efêmeros, nascem de heartbeat e valeriam uma linha no MySQL por batida. Eles
 * são publicados direto no mesmo canal, no mesmo envelope, e por isso aparecem
 * para todas as instâncias — mas não entram na retomada por cursor, que é o
 * comportamento certo para um estado que já está no Redis com TTL.
 */

import { newId } from '@prometheon/database';
import { child } from '@prometheon/logger';

import type { RedisClient } from '../../plugins/redis.js';
import { CLOSE_CODES, type RealtimeConnection } from './connection.js';
import type { RealtimeKeys } from './keys.js';
import { PresenceStore } from './presence.js';
import type { RealtimeService } from './service.js';
import { REALTIME_SETTINGS } from './settings.js';
import { realtimeEnvelopeSchema, type RealtimeEnvelope } from './types.js';

const logger = child('realtime');

export interface RealtimeHubOptions {
  readonly redis: RedisClient;
  readonly keys: RealtimeKeys;
  readonly service: RealtimeService;
  /** Presença injetável para o teste encurtar o TTL. */
  readonly presence?: PresenceStore | undefined;
  /** Desliga os temporizadores; o teste chama os passos à mão. */
  readonly timers?: boolean | undefined;
}

export class RealtimeHub {
  readonly #redis: RedisClient;
  readonly #keys: RealtimeKeys;
  readonly #service: RealtimeService;
  readonly #presence: PresenceStore;

  readonly #connections = new Map<string, RealtimeConnection>();
  /** Conexões por organização; a chave é o que decide assinar ou não o canal. */
  readonly #byOrganization = new Map<string, Set<RealtimeConnection>>();
  /** Projetos com pelo menos uma conexão local, para a varredura de presença. */
  readonly #projects = new Map<string, number>();

  #subscriber: RedisClient | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #sweepTimer: NodeJS.Timeout | undefined;
  #revalidationTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: RealtimeHubOptions) {
    this.#redis = options.redis;
    this.#keys = options.keys;
    this.#service = options.service;
    this.#presence = options.presence ?? new PresenceStore(options.redis);

    if (options.timers !== false) {
      this.#startTimers();
    }
  }

  get presence(): PresenceStore {
    return this.#presence;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const timer of [this.#heartbeatTimer, this.#sweepTimer, this.#revalidationTimer]) {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    }

    for (const connection of [...this.#connections.values()]) {
      connection.close(CLOSE_CODES.shuttingDown, 'server shutting down');
      await this.#detach(connection);
    }

    const subscriber = this.#subscriber;

    this.#subscriber = undefined;

    if (subscriber !== undefined) {
      await subscriber.quit().catch(() => {
        subscriber.disconnect();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Conexões
  // -------------------------------------------------------------------------

  register(connection: RealtimeConnection): void {
    this.#connections.set(connection.id, connection);
  }

  /**
   * Ativa a conexão: indexa por organização, assina os canais que faltarem e
   * anuncia a presença.
   */
  async activate(connection: RealtimeConnection): Promise<void> {
    const organizationIds = new Set(
      connection.subscriptions.map((subscription) => subscription.organizationId),
    );
    const projectIds = new Set(
      connection.subscriptions
        .map((subscription) => subscription.projectId)
        .filter((projectId): projectId is string => projectId !== null),
    );

    // Sai dos índices antigos antes de entrar nos novos: `subscribe` depois do
    // `hello` pode mudar o conjunto inteiro.
    await this.#detachIndexes(connection);

    connection.organizationIds = organizationIds;
    connection.ready = true;

    for (const organizationId of organizationIds) {
      const set = this.#byOrganization.get(organizationId) ?? new Set();

      set.add(connection);
      this.#byOrganization.set(organizationId, set);

      if (set.size === 1) {
        await this.#subscribe(organizationId);
      }
    }

    for (const projectId of projectIds) {
      this.#projects.set(projectId, (this.#projects.get(projectId) ?? 0) + 1);
    }

    await this.#announceJoin(connection, organizationIds, projectIds);
  }

  /** Tira a conexão de tudo e anuncia a saída. */
  async detach(connection: RealtimeConnection): Promise<void> {
    await this.#detach(connection);
  }

  async #detach(connection: RealtimeConnection): Promise<void> {
    this.#connections.delete(connection.id);

    if (!connection.ready) {
      await this.#detachIndexes(connection);

      return;
    }

    const organizationIds = new Set(connection.organizationIds);
    const projectIds = new Set(
      connection.subscriptions
        .map((subscription) => subscription.projectId)
        .filter((projectId): projectId is string => projectId !== null),
    );

    await this.#announceLeave(connection, organizationIds, projectIds);
    await this.#detachIndexes(connection);
  }

  async #detachIndexes(connection: RealtimeConnection): Promise<void> {
    for (const organizationId of connection.organizationIds) {
      const set = this.#byOrganization.get(organizationId);

      if (set === undefined) {
        continue;
      }

      set.delete(connection);

      if (set.size === 0) {
        this.#byOrganization.delete(organizationId);
        await this.#unsubscribe(organizationId);
      }
    }

    for (const subscription of connection.subscriptions) {
      if (subscription.projectId === null) {
        continue;
      }

      const count = (this.#projects.get(subscription.projectId) ?? 1) - 1;

      if (count <= 0) {
        this.#projects.delete(subscription.projectId);
      } else {
        this.#projects.set(subscription.projectId, count);
      }
    }

    connection.organizationIds = new Set();
  }

  // -------------------------------------------------------------------------
  // Pub/sub
  // -------------------------------------------------------------------------

  /**
   * A conexão dedicada ao modo subscribe.
   *
   * Um cliente ioredis em modo subscribe recusa comandos normais, então o
   * assinante precisa ser um socket próprio. `duplicate()` herda host, porta,
   * senha e banco — e o `keyPrefix`, que é irrelevante aqui porque canal não é
   * chave.
   */
  async #ensureSubscriber(): Promise<RedisClient> {
    if (this.#subscriber !== undefined) {
      return this.#subscriber;
    }

    const subscriber = this.#redis.duplicate();

    subscriber.on('error', (error: unknown) => {
      logger.warn({ err: error }, 'realtime: falha no assinante do Redis');
    });

    subscriber.on('message', (channel: string, payload: string) => {
      this.#onMessage(channel, payload);
    });

    if (subscriber.status !== 'ready' && subscriber.status !== 'connecting') {
      await subscriber.connect();
    }

    this.#subscriber = subscriber;

    return subscriber;
  }

  async #subscribe(organizationId: string): Promise<void> {
    const subscriber = await this.#ensureSubscriber();

    await subscriber.subscribe(this.#keys.channel(organizationId));
  }

  async #unsubscribe(organizationId: string): Promise<void> {
    if (this.#subscriber === undefined) {
      return;
    }

    await this.#subscriber.unsubscribe(this.#keys.channel(organizationId)).catch(() => undefined);
  }

  #onMessage(channel: string, payload: string): void {
    const organizationId = this.#keys.organizationOfChannel(channel);

    if (organizationId === undefined) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(payload);
    } catch {
      logger.warn({ channel }, 'realtime: payload do canal não é JSON');

      return;
    }

    const envelope = realtimeEnvelopeSchema.safeParse(parsed);

    if (!envelope.success) {
      logger.warn({ channel }, 'realtime: envelope fora do formato, descartado');

      return;
    }

    this.dispatch(envelope.data);
  }

  /** Entrega um envelope às conexões locais que o querem. */
  dispatch(envelope: RealtimeEnvelope): number {
    const targets = this.#byOrganization.get(envelope.organizationId);

    if (targets === undefined) {
      return 0;
    }

    let delivered = 0;

    for (const connection of targets) {
      if (!connection.ready || connection.closed || !connection.wants(envelope)) {
        continue;
      }

      connection.deliver(envelope);
      delivered += 1;
    }

    return delivered;
  }

  /**
   * Publica um envelope no canal da organização.
   *
   * Vai pelo Redis mesmo quando o destinatário está nesta instância: assim o
   * caminho é um só, e um evento nunca chega duas vezes por dois caminhos
   * diferentes.
   */
  async publish(envelope: RealtimeEnvelope): Promise<void> {
    await this.#redis.publish(
      this.#keys.channel(envelope.organizationId),
      JSON.stringify(envelope),
    );
  }

  // -------------------------------------------------------------------------
  // Presença
  // -------------------------------------------------------------------------

  async #announceJoin(
    connection: RealtimeConnection,
    organizationIds: ReadonlySet<string>,
    projectIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const organizationId of organizationIds) {
      const result = await this.#presence.join(
        this.#keys.presenceOrganization(organizationId),
        connection.principal.userId,
        connection.id,
      );

      await this.#publishPresence(
        organizationId,
        null,
        connection.principal.userId,
        'online',
        result.connections,
      );
    }

    for (const projectId of projectIds) {
      const organizationId = this.#organizationOfProject(connection, projectId);

      if (organizationId === undefined) {
        continue;
      }

      const result = await this.#presence.join(
        this.#keys.presenceProject(projectId),
        connection.principal.userId,
        connection.id,
      );

      await this.#publishPresence(
        organizationId,
        projectId,
        connection.principal.userId,
        'online',
        result.connections,
      );
    }
  }

  async #announceLeave(
    connection: RealtimeConnection,
    organizationIds: ReadonlySet<string>,
    projectIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const organizationId of organizationIds) {
      const result = await this.#presence.leave(
        this.#keys.presenceOrganization(organizationId),
        connection.principal.userId,
        connection.id,
      );

      // Fechar uma aba de quem tem três não deixa ninguém offline: o evento sai
      // do mesmo jeito, com a contagem menor, e o status só vira `offline`
      // quando a última conexão some.
      await this.#publishPresence(
        organizationId,
        null,
        connection.principal.userId,
        result.becameOffline ? 'offline' : 'online',
        result.connections,
      );
    }

    for (const projectId of projectIds) {
      const organizationId = this.#organizationOfProject(connection, projectId);

      if (organizationId === undefined) {
        continue;
      }

      const result = await this.#presence.leave(
        this.#keys.presenceProject(projectId),
        connection.principal.userId,
        connection.id,
      );

      await this.#publishPresence(
        organizationId,
        projectId,
        connection.principal.userId,
        result.becameOffline ? 'offline' : 'online',
        result.connections,
      );
    }
  }

  #organizationOfProject(connection: RealtimeConnection, projectId: string): string | undefined {
    return connection.subscriptions.find(
      (subscription) => subscription.projectId === projectId,
    )?.organizationId;
  }

  async #publishPresence(
    organizationId: string,
    projectId: string | null,
    userId: string,
    status: 'online' | 'idle' | 'offline',
    deviceCount: number,
  ): Promise<void> {
    await this.publish({
      id: newId(),
      type: 'presence.changed',
      version: 1,
      organizationId,
      projectId,
      occurredAt: new Date().toISOString(),
      cursor: newId(),
      data: { userId, status, deviceCount },
    });
  }

  /**
   * Renova a presença de todas as conexões vivas.
   *
   * É o que transforma heartbeat em presença: sem esta renovação o TTL vence e
   * a pessoa some, que é exatamente o comportamento desejado para quem parou de
   * responder.
   */
  async renewPresence(): Promise<void> {
    for (const connection of this.#connections.values()) {
      if (!connection.ready || connection.closed) {
        continue;
      }

      for (const organizationId of connection.organizationIds) {
        await this.#presence.join(
          this.#keys.presenceOrganization(organizationId),
          connection.principal.userId,
          connection.id,
        );
      }

      for (const subscription of connection.subscriptions) {
        if (subscription.projectId === null) {
          continue;
        }

        await this.#presence.join(
          this.#keys.presenceProject(subscription.projectId),
          connection.principal.userId,
          connection.id,
        );
      }
    }
  }

  /**
   * Remove presença vencida e anuncia quem saiu.
   *
   * O lock curto evita que N instâncias anunciem a mesma saída com `id`
   * diferente — a dedup do cliente é por `id`, então duplicata com id novo
   * apareceria como dois eventos.
   */
  async sweepPresence(): Promise<void> {
    for (const organizationId of this.#byOrganization.keys()) {
      const lock = await this.#redis.set(
        `rt:sweep:org:${organizationId}`,
        '1',
        'PX',
        REALTIME_SETTINGS.presenceSweepIntervalMs,
        'NX',
      );

      if (lock === null) {
        continue;
      }

      for (const expiry of await this.#presence.sweep(
        this.#keys.presenceOrganization(organizationId),
      )) {
        await this.#publishPresence(organizationId, null, expiry.userId, 'offline', 0);
      }
    }

    for (const projectId of this.#projects.keys()) {
      const organizationId = this.#projectOrganization(projectId);

      if (organizationId === undefined) {
        continue;
      }

      const lock = await this.#redis.set(
        `rt:sweep:prj:${projectId}`,
        '1',
        'PX',
        REALTIME_SETTINGS.presenceSweepIntervalMs,
        'NX',
      );

      if (lock === null) {
        continue;
      }

      for (const expiry of await this.#presence.sweep(this.#keys.presenceProject(projectId))) {
        await this.#publishPresence(organizationId, projectId, expiry.userId, 'offline', 0);
      }
    }
  }

  /**
   * Tira da lista os dispositivos que pararam de bater e anuncia a saída.
   *
   * A leitura de `agents/active` já ignora o vencido, então esta varredura não
   * é o que mantém a lista correta — ela é o que faz a interface **saber** que
   * alguém saiu sem precisar consultar a lista de novo.
   */
  async sweepDevices(): Promise<void> {
    const now = Date.now();

    for (const projectId of this.#projects.keys()) {
      const organizationId = this.#projectOrganization(projectId);

      if (organizationId === undefined) {
        continue;
      }

      const key = this.#keys.deviceProject(projectId);
      const expired = await this.#redis.zrangebyscore(key, '-inf', now);

      if (expired.length === 0) {
        continue;
      }

      const lock = await this.#redis.set(
        `rt:sweep:dev:${projectId}`,
        '1',
        'PX',
        REALTIME_SETTINGS.presenceSweepIntervalMs,
        'NX',
      );

      await this.#redis.zremrangebyscore(key, '-inf', now);

      if (lock === null) {
        continue;
      }

      for (const deviceId of expired) {
        await this.publish({
          id: newId(),
          type: 'device.changed',
          version: 1,
          organizationId,
          projectId,
          occurredAt: new Date().toISOString(),
          cursor: newId(),
          data: { deviceId, status: 'offline' },
        });
      }
    }
  }

  #projectOrganization(projectId: string): string | undefined {
    for (const connection of this.#connections.values()) {
      const found = connection.subscriptions.find(
        (subscription) => subscription.projectId === projectId,
      );

      if (found !== undefined) {
        return found.organizationId;
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Relógios
  // -------------------------------------------------------------------------

  /** Fecha conexões silenciosas e pinga as demais. */
  checkHeartbeats(now: number = Date.now()): RealtimeConnection[] {
    const dropped: RealtimeConnection[] = [];

    for (const connection of this.#connections.values()) {
      if (connection.isStale(now)) {
        dropped.push(connection);
        continue;
      }

      try {
        connection.socket.ping();
      } catch {
        dropped.push(connection);
      }
    }

    for (const connection of dropped) {
      connection.close(CLOSE_CODES.timeout, 'heartbeat timeout');
    }

    return dropped;
  }

  /**
   * Reavalia as inscrições de todas as conexões.
   *
   * Sem isto, quem foi removido do projeto continuaria recebendo os eventos dele
   * até desconectar — que é a diferença entre "autorizado na inscrição" e
   * "autorizado enquanto conectado".
   */
  async revalidateAccess(): Promise<void> {
    for (const connection of [...this.#connections.values()]) {
      if (!connection.ready || connection.closed) {
        continue;
      }

      if (!(await this.#service.principalStillValid(connection.principal))) {
        connection.sendError('TOKEN_INVALID', 'This credential is no longer valid.', false);
        connection.close(CLOSE_CODES.unauthorized, 'credential revoked');
        await this.#detach(connection);
        continue;
      }

      const decision = await this.#service.authorizeSubscriptions(
        connection.principal,
        connection.subscriptions.map((subscription) => ({
          organizationId: subscription.organizationId,
          projectId: subscription.projectId,
          eventTypes: [...subscription.eventTypes],
        })),
      );

      if (decision.denied.length === 0) {
        continue;
      }

      for (const denied of decision.denied) {
        connection.sendError('SUBSCRIPTION_DENIED', denied.reason, false);
      }

      if (decision.granted.length === 0) {
        connection.close(CLOSE_CODES.unauthorized, 'access revoked');
        await this.#detach(connection);
        continue;
      }

      connection.subscriptions = decision.granted;
      await this.activate(connection);
    }
  }

  #startTimers(): void {
    this.#heartbeatTimer = setInterval(() => {
      this.checkHeartbeats();
      void this.renewPresence().catch((error: unknown) => {
        logger.warn({ err: error }, 'realtime: falha ao renovar presença');
      });
    }, REALTIME_SETTINGS.heartbeatIntervalMs);

    this.#sweepTimer = setInterval(() => {
      void (async (): Promise<void> => {
        await this.sweepPresence();
        await this.sweepDevices();
      })().catch((error: unknown) => {
        logger.warn({ err: error }, 'realtime: falha na varredura de presença');
      });
    }, REALTIME_SETTINGS.presenceSweepIntervalMs);

    this.#revalidationTimer = setInterval(() => {
      void this.revalidateAccess().catch((error: unknown) => {
        logger.warn({ err: error }, 'realtime: falha ao revalidar acesso');
      });
    }, REALTIME_SETTINGS.accessRevalidationIntervalMs);

    // Os relógios não podem segurar o processo vivo no encerramento.
    this.#heartbeatTimer.unref();
    this.#sweepTimer.unref();
    this.#revalidationTimer.unref();
  }
}
