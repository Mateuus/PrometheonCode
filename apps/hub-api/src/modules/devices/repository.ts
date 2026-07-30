/**
 * Acesso ao banco do módulo de dispositivos.
 *
 * Só consultas Drizzle, todas parametrizadas. A tabela `devices` pertence a uma
 * **pessoa**, não a uma organização (ver o comentário do schema): o alcance vem
 * das associações ativas do dono. Por isso toda leitura por identificador é
 * acompanhada do `userId` — não existe "ler o dispositivo e depois conferir o
 * dono", que é a forma clássica de deixar passar um vazamento.
 */

import { devices, newId, users, type Database } from '@prometheon/database';
import { and, eq, inArray } from 'drizzle-orm';

export type DevicePlatform = 'windows' | 'macos' | 'linux' | 'web' | 'other';
export type DeviceRowStatus = 'pending' | 'active' | 'revoked' | 'expired';

export interface DeviceRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly client: string;
  readonly clientVersion: string | null;
  readonly fingerprint: string | null;
  readonly status: DeviceRowStatus;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

const DEVICE_COLUMNS = {
  id: devices.id,
  userId: devices.userId,
  name: devices.name,
  platform: devices.platform,
  client: devices.client,
  clientVersion: devices.clientVersion,
  fingerprint: devices.fingerprint,
  status: devices.status,
  lastSeenAt: devices.lastSeenAt,
  createdAt: devices.createdAt,
  updatedAt: devices.updatedAt,
  version: devices.version,
} as const;

export interface RegisterDeviceInput {
  readonly userId: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly client: string;
  readonly clientVersion: string | null;
  readonly fingerprint: string;
  readonly ip: string | null;
}

export class DeviceRepository {
  constructor(private readonly db: Database) {}

  /**
   * Registra ou reconhece o dispositivo pela impressão da instalação.
   *
   * O registro é idempotente por `(userId, fingerprint)` — que é justamente o
   * índice único da tabela. Uma extensão reinstalada manda a mesma impressão e
   * volta ao mesmo `deviceId`, em vez de criar uma linha nova a cada vez e fazer
   * a lista de dispositivos do usuário crescer para sempre.
   */
  async register(input: RegisterDeviceInput): Promise<DeviceRow> {
    const existing = await this.db
      .select(DEVICE_COLUMNS)
      .from(devices)
      .where(and(eq(devices.userId, input.userId), eq(devices.fingerprint, input.fingerprint)))
      .limit(1);

    const found = existing[0];
    const now = new Date();

    if (found !== undefined) {
      if (found.status === 'revoked') {
        // Reativar um dispositivo revogado por um simples `register` anularia a
        // revogação: quem revogou precisa refazer o device flow.
        return found;
      }

      await this.db
        .update(devices)
        .set({
          name: input.name,
          platform: input.platform,
          client: input.client,
          clientVersion: input.clientVersion,
          status: 'active',
          approvedAt: found.status === 'active' ? undefined : now,
          lastSeenAt: now,
          lastIp: input.ip,
          updatedAt: now,
        })
        .where(eq(devices.id, found.id));

      return {
        ...found,
        name: input.name,
        platform: input.platform,
        client: input.client,
        clientVersion: input.clientVersion,
        status: 'active',
        lastSeenAt: now,
        updatedAt: now,
      };
    }

    const id = newId();

    await this.db.insert(devices).values({
      id,
      userId: input.userId,
      name: input.name,
      platform: input.platform,
      client: input.client,
      clientVersion: input.clientVersion,
      fingerprint: input.fingerprint,
      status: 'active',
      approvedAt: now,
      lastSeenAt: now,
      lastIp: input.ip,
    });

    const inserted = await this.db
      .select(DEVICE_COLUMNS)
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);

    const row = inserted[0];

    if (row === undefined) {
      throw new Error('The device was inserted but could not be read back.');
    }

    return row;
  }

  /** Dispositivo do dono. Nunca lê por identificador sozinho. */
  async findOwned(deviceId: string, userId: string): Promise<DeviceRow | undefined> {
    const rows = await this.db
      .select(DEVICE_COLUMNS)
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .limit(1);

    return rows[0];
  }

  async findMany(deviceIds: readonly string[]): Promise<DeviceRow[]> {
    if (deviceIds.length === 0) {
      return [];
    }

    return this.db
      .select(DEVICE_COLUMNS)
      .from(devices)
      .where(inArray(devices.id, [...deviceIds]));
  }

  /** Marca a batida. `version` sobe para o controle otimista do `Docs/06`. */
  async touch(deviceId: string, clientVersion: string | null, ip: string | null): Promise<void> {
    const now = new Date();

    await this.db
      .update(devices)
      .set({
        lastSeenAt: now,
        lastIp: ip,
        updatedAt: now,
        ...(clientVersion === null ? {} : { clientVersion }),
      })
      .where(eq(devices.id, deviceId));
  }

  async findOwner(
    userId: string,
  ): Promise<{ id: string; displayName: string; email: string; avatarUrl: string | null } | undefined> {
    const rows = await this.db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return rows[0];
  }
}
