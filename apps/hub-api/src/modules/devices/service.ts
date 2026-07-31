/**
 * Registro, heartbeat e listas vivas de dispositivo (`Docs/06`).
 *
 * **O estado vivo mora no Redis, com TTL; o permanente mora no MySQL.** O
 * `devices.last_seen_at` do banco responde "quando esta máquina apareceu pela
 * última vez"; quem está aqui agora é uma pergunta com prazo de validade, e
 * guardá-la em coluna criaria exatamente o problema que o `Docs/08` manda
 * evitar: um dispositivo desligado que continua "ativo" porque ninguém rodou o
 * `UPDATE` de saída.
 *
 * `device.changed` **não passa pelo outbox**. Uma batida a cada trinta segundos
 * por dispositivo viraria milhões de linhas num evento cujo valor vence em
 * segundos. Ele é publicado direto no canal da organização, no mesmo envelope —
 * o que significa que ele não entra na retomada por cursor, e é o que se espera
 * de um estado que já está no Redis com prazo.
 */

import { newId } from '@prometheon/database';

import type { RedisClient } from '../../plugins/redis.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { RealtimeKeys } from '../realtime/keys.js';
import type { PresenceStore } from '../realtime/presence.js';
import type { RealtimeRepository } from '../realtime/repository.js';
import { deviceNotFound, deviceRevoked, projectAccessDenied, projectNotFound } from './errors.js';
import { type DeviceRepository, type DevicePlatform, type DeviceRow } from './repository.js';
import { DEVICE_SETTINGS } from './settings.js';

export type ContractDeviceStatus = 'online' | 'idle' | 'offline' | 'revoked';

/** Estado vivo de um dispositivo, como fica no Redis. */
export interface DeviceLiveState {
  readonly deviceId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly status: 'online' | 'idle';
  readonly projectIds: readonly string[];
  readonly activeAgentRunIds: readonly string[];
  readonly clientVersion: string | null;
  readonly lastSeenAt: string;
}

export interface PublicDevice {
  readonly id: string;
  readonly organizationId: string;
  readonly owner: { id: string; name: string; email: string; avatarUrl: string | null };
  readonly name: string;
  readonly kind: 'vscode' | 'cli' | 'ci' | 'other';
  readonly platform: string | null;
  readonly clientVersion: string | null;
  readonly status: ContractDeviceStatus;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ActiveAgent {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly kind: 'vscode' | 'cli' | 'ci' | 'other';
  readonly platform: string | null;
  readonly clientVersion: string | null;
  readonly status: 'online' | 'idle';
  readonly owner: { id: string; name: string; email: string; avatarUrl: string | null };
  readonly activeAgentRunIds: string[];
  readonly lastSeenAt: string;
}

export interface PresenceEntryView {
  readonly user: { id: string; name: string; email: string; avatarUrl: string | null };
  readonly projectId: string;
  readonly status: 'online' | 'idle' | 'offline';
  readonly deviceIds: string[];
  readonly activeAgentRuns: number;
  readonly lastSeenAt: string;
}

export interface RegisterInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: 'vscode' | 'cli' | 'ci' | 'other';
  readonly platform: string | undefined;
  readonly clientVersion: string | undefined;
  readonly installationId: string;
  readonly ip: string | null;
}

export interface HeartbeatInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly deviceId: string;
  readonly status: 'online' | 'idle';
  readonly projectIds: readonly string[];
  readonly activeAgentRunIds: readonly string[];
  readonly clientVersion: string | undefined;
  readonly ip: string | null;
}

export interface DeviceServiceOptions {
  readonly repository: DeviceRepository;
  readonly realtimeRepository: RealtimeRepository;
  readonly presence: PresenceStore;
  readonly redis: RedisClient;
  readonly keys: RealtimeKeys;
  readonly hub: RealtimeHub;
}

/** O enum do banco é mais estreito que o texto livre do contrato. */
function toPlatform(value: string | undefined): DevicePlatform {
  switch (value?.toLowerCase()) {
    case 'windows':
      return 'windows';
    case 'macos':
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    case 'web':
      return 'web';
    default:
      return 'other';
  }
}

function toKind(client: string): 'vscode' | 'cli' | 'ci' | 'other' {
  switch (client) {
    case 'vscode':
    case 'cli':
    case 'ci':
      return client;
    default:
      return 'other';
  }
}

export class DeviceService {
  readonly #repository: DeviceRepository;
  readonly #realtime: RealtimeRepository;
  readonly #presence: PresenceStore;
  readonly #redis: RedisClient;
  readonly #keys: RealtimeKeys;
  readonly #hub: RealtimeHub;

  constructor(options: DeviceServiceOptions) {
    this.#repository = options.repository;
    this.#realtime = options.realtimeRepository;
    this.#presence = options.presence;
    this.#redis = options.redis;
    this.#keys = options.keys;
    this.#hub = options.hub;
  }

  async register(input: RegisterInput): Promise<PublicDevice> {
    const row = await this.#repository.register({
      userId: input.userId,
      name: input.name,
      platform: toPlatform(input.platform),
      client: input.kind,
      clientVersion: input.clientVersion ?? null,
      fingerprint: input.installationId,
      ip: input.ip,
    });

    if (row.status === 'revoked') {
      throw deviceRevoked();
    }

    const device = await this.#toPublicDevice(row, input.organizationId);

    await this.#publishDeviceChanged(input.organizationId, null, row.id, device.status);

    return device;
  }

  /**
   * Uma batida.
   *
   * Confere o acesso a **cada** projeto declarado antes de escrever qualquer
   * coisa: um dispositivo não pode se anunciar num projeto que o dono não
   * alcança, ou a lista de agentes ativos viraria um oráculo de existência de
   * projeto para quem tem uma credencial de dispositivo qualquer.
   */
  async heartbeat(input: HeartbeatInput): Promise<{ nextHeartbeatIn: number; shouldStop: boolean }> {
    const row = await this.#repository.findOwned(input.deviceId, input.userId);

    if (row === undefined) {
      throw deviceNotFound();
    }

    if (row.status !== 'active') {
      // O dispositivo continua batendo com uma credencial que não vale mais:
      // responder `shouldStop` é mais útil que um erro, porque o cliente sabe
      // parar em vez de repetir a cada trinta segundos.
      return { nextHeartbeatIn: DEVICE_SETTINGS.heartbeatIntervalSeconds, shouldStop: true };
    }

    const projectIds = [...new Set(input.projectIds)];

    for (const projectId of projectIds) {
      await this.#assertProjectAccess(projectId, input.organizationId, input.userId);
    }

    await this.#repository.touch(input.deviceId, input.clientVersion ?? null, input.ip);

    const now = Date.now();
    const expiresAt = now + DEVICE_SETTINGS.presenceTtlMs;
    const state: DeviceLiveState = {
      deviceId: input.deviceId,
      userId: input.userId,
      organizationId: input.organizationId,
      status: input.status,
      projectIds,
      activeAgentRunIds: [...new Set(input.activeAgentRunIds)],
      clientVersion: input.clientVersion ?? row.clientVersion,
      lastSeenAt: new Date(now).toISOString(),
    };

    const previous = await this.#readState(input.deviceId);

    await this.#redis.set(
      this.#keys.deviceState(input.deviceId),
      JSON.stringify(state),
      'PX',
      DEVICE_SETTINGS.presenceTtlMs,
    );

    // Projetos que saíram do heartbeat não podem continuar mostrando o
    // dispositivo: fechar um projeto é tão informativo quanto abrir outro.
    for (const projectId of previous?.projectIds ?? []) {
      if (!projectIds.includes(projectId)) {
        await this.#redis.zrem(this.#keys.deviceProject(projectId), input.deviceId);
        await this.#publishDeviceChanged(
          input.organizationId,
          projectId,
          input.deviceId,
          'offline',
        );
      }
    }

    for (const projectId of projectIds) {
      const key = this.#keys.deviceProject(projectId);

      await this.#redis
        .multi()
        .zremrangebyscore(key, '-inf', now)
        .zadd(key, expiresAt, input.deviceId)
        .expire(key, Math.ceil(DEVICE_SETTINGS.presenceTtlMs / 1_000))
        .exec();
    }

    // Um evento por projeto declarado, mais um da organização: assim tanto quem
    // assina o projeto quanto quem assina a organização recebem a mudança.
    await this.#publishDeviceChanged(input.organizationId, null, input.deviceId, input.status);

    for (const projectId of projectIds) {
      await this.#publishDeviceChanged(
        input.organizationId,
        projectId,
        input.deviceId,
        input.status,
      );
    }

    return { nextHeartbeatIn: DEVICE_SETTINGS.heartbeatIntervalSeconds, shouldStop: false };
  }

  /** Dispositivos que bateram dentro da janela naquele projeto. */
  async activeAgents(projectId: string): Promise<ActiveAgent[]> {
    const states = await this.#liveStates(projectId);

    if (states.length === 0) {
      return [];
    }

    const rows = await this.#repository.findMany(states.map((state) => state.deviceId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const owners = await this.#realtime.findUsers([
      ...new Set(states.map((state) => state.userId)),
    ]);
    const ownerById = new Map(owners.map((owner) => [owner.id, owner]));

    const agents: ActiveAgent[] = [];

    for (const state of states) {
      const row = byId.get(state.deviceId);
      const owner = ownerById.get(state.userId);

      if (row === undefined || owner === undefined || row.status !== 'active') {
        continue;
      }

      agents.push({
        deviceId: row.id,
        deviceName: row.name,
        kind: toKind(row.client),
        platform: row.platform,
        clientVersion: state.clientVersion,
        status: state.status,
        owner: {
          id: owner.id,
          name: owner.displayName,
          email: owner.email,
          avatarUrl: owner.avatarUrl,
        },
        activeAgentRunIds: [...state.activeAgentRunIds],
        lastSeenAt: state.lastSeenAt,
      });
    }

    return agents;
  }

  /**
   * Snapshot REST da presença de um projeto.
   *
   * É o "snapshot REST após perda de janela" do `Docs/08` aplicado à presença:
   * o cliente que recebeu `resumeGap` recarrega daqui em vez de deduzir o estado
   * a partir de eventos que não recebeu. Junta as duas fontes vivas — conexões
   * WebSocket e heartbeat de dispositivo — porque uma pessoa pode estar presente
   * por qualquer uma das duas.
   */
  async projectPresence(projectId: string): Promise<PresenceEntryView[]> {
    const connected = await this.#presence.list(this.#keys.presenceProject(projectId));
    const states = await this.#liveStates(projectId);

    const byUser = new Map<
      string,
      { deviceIds: Set<string>; runs: number; lastSeenAt: number; idleOnly: boolean }
    >();

    for (const member of connected) {
      byUser.set(member.userId, {
        deviceIds: new Set(),
        runs: 0,
        lastSeenAt: member.expiresAt - this.#presence.ttlMs,
        idleOnly: false,
      });
    }

    for (const state of states) {
      const entry = byUser.get(state.userId) ?? {
        deviceIds: new Set<string>(),
        runs: 0,
        lastSeenAt: 0,
        idleOnly: true,
      };

      entry.deviceIds.add(state.deviceId);
      entry.runs += state.activeAgentRunIds.length;
      entry.lastSeenAt = Math.max(entry.lastSeenAt, Date.parse(state.lastSeenAt));

      if (state.status === 'online') {
        entry.idleOnly = false;
      }

      byUser.set(state.userId, entry);
    }

    if (byUser.size === 0) {
      return [];
    }

    const users = await this.#realtime.findUsers([...byUser.keys()]);

    return users.map((user) => {
      const entry = byUser.get(user.id);

      return {
        user: {
          id: user.id,
          name: user.displayName,
          email: user.email,
          avatarUrl: user.avatarUrl,
        },
        projectId,
        status: entry?.idleOnly === true ? ('idle' as const) : ('online' as const),
        deviceIds: [...(entry?.deviceIds ?? [])],
        activeAgentRuns: entry?.runs ?? 0,
        lastSeenAt: new Date(entry?.lastSeenAt === undefined || entry.lastSeenAt === 0 ? Date.now() : entry.lastSeenAt).toISOString(),
      };
    });
  }

  /** Organização dona do projeto, para `requirePermission` resolver a rota. */
  async organizationOfProject(projectId: string): Promise<string> {
    const project = await this.#realtime.findProject(projectId);

    if (project === undefined) {
      throw projectNotFound();
    }

    return project.organizationId;
  }

  async #assertProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const project = await this.#realtime.findProject(projectId);

    if (project?.organizationId !== organizationId) {
      throw projectAccessDenied();
    }

    if (project.visibility === 'organization') {
      return;
    }

    if (!(await this.#realtime.isProjectMember(projectId, userId))) {
      throw projectAccessDenied();
    }
  }

  /**
   * Estados vivos de um projeto, já sem os vencidos.
   *
   * O `ZREMRANGEBYSCORE` antes da leitura é o mesmo truque da presença de
   * pessoas: quem parou de bater nunca chega a ser lido, mesmo que nenhuma
   * varredura tenha passado por ali ainda.
   */
  async #liveStates(projectId: string): Promise<DeviceLiveState[]> {
    const key = this.#keys.deviceProject(projectId);
    const now = Date.now();

    await this.#redis.zremrangebyscore(key, '-inf', now);

    const deviceIds = await this.#redis.zrange(key, 0, -1);

    if (deviceIds.length === 0) {
      return [];
    }

    const states: DeviceLiveState[] = [];

    for (const deviceId of deviceIds) {
      const state = await this.#readState(deviceId);

      if (state === undefined) {
        // A chave de estado venceu antes do índice: o índice é quem está
        // errado, e limpá-lo aqui evita repetir a leitura na próxima chamada.
        await this.#redis.zrem(key, deviceId);
        continue;
      }

      states.push(state);
    }

    return states;
  }

  async #readState(deviceId: string): Promise<DeviceLiveState | undefined> {
    const raw = await this.#redis.get(this.#keys.deviceState(deviceId));

    if (raw === null) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as DeviceLiveState;
    } catch {
      return undefined;
    }
  }

  async #toPublicDevice(row: DeviceRow, organizationId: string): Promise<PublicDevice> {
    const owner = await this.#repository.findOwner(row.userId);
    const state = await this.#readState(row.id);

    return {
      id: row.id,
      organizationId,
      owner: {
        id: owner?.id ?? row.userId,
        name: owner?.displayName ?? 'unknown',
        email: owner?.email ?? 'unknown@example.invalid',
        avatarUrl: owner?.avatarUrl ?? null,
      },
      name: row.name,
      kind: toKind(row.client),
      platform: row.platform,
      clientVersion: row.clientVersion,
      status: toContractStatus(row, state),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }

  async #publishDeviceChanged(
    organizationId: string,
    projectId: string | null,
    deviceId: string,
    status: ContractDeviceStatus,
  ): Promise<void> {
    await this.#hub.publish({
      id: newId(),
      type: 'device.changed',
      version: 1,
      organizationId,
      projectId,
      occurredAt: new Date().toISOString(),
      cursor: newId(),
      data: { deviceId, status },
    });
  }
}

/**
 * Status do contrato a partir da linha e do estado vivo.
 *
 * Os dois enums não coincidem de propósito: o banco descreve o **ciclo de vida**
 * (`pending`, `active`, `revoked`, `expired`) e o contrato descreve a
 * **disponibilidade** (`online`, `idle`, `offline`, `revoked`). Só o Redis sabe
 * a segunda, e a ausência de estado lá significa exatamente `offline`.
 */
export function toContractStatus(
  row: Pick<DeviceRow, 'status'>,
  state: DeviceLiveState | undefined,
): ContractDeviceStatus {
  if (row.status === 'revoked' || row.status === 'expired') {
    return 'revoked';
  }

  if (state === undefined) {
    return 'offline';
  }

  return state.status;
}
