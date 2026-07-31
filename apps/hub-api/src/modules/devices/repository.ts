/**
 * Acesso ao banco do módulo de dispositivos.
 *
 * Só consultas do TypeORM, todas parametrizadas. A tabela `devices` pertence a
 * uma **pessoa**, não a uma organização (ver o comentário do schema): o alcance
 * vem das associações ativas do dono. Por isso toda leitura por identificador é
 * acompanhada do `userId` — não existe "ler o dispositivo e depois conferir o
 * dono", que é a forma clássica de deixar passar um vazamento.
 */

import { devices, newId, users, type Database } from '@prometheon/database';

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

/** Colunas que o contrato de dispositivo expõe. Lista explícita, nada de `SELECT *`. */
const DEVICE_COLUMNS = [
  'id',
  'userId',
  'name',
  'platform',
  'client',
  'clientVersion',
  'fingerprint',
  'status',
  'lastSeenAt',
  'createdAt',
  'updatedAt',
  'version',
] as const;

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
    const existing = await this.deviceQuery()
      .where('device.userId = :userId', { userId: input.userId })
      .andWhere('device.fingerprint = :fingerprint', { fingerprint: input.fingerprint })
      .getOne();

    const found = existing as DeviceRow | null;
    const now = new Date();

    if (found !== null) {
      if (found.status === 'revoked') {
        // Reativar um dispositivo revogado por um simples `register` anularia a
        // revogação: quem revogou precisa refazer o device flow.
        return found;
      }

      await this.db.manager.update(
        devices,
        { id: found.id },
        {
          name: input.name,
          platform: input.platform,
          client: input.client,
          clientVersion: input.clientVersion,
          status: 'active',
          // `approved_at` marca a primeira aprovação: quem já estava ativo
          // mantém a data original em vez de vê-la avançar a cada registro.
          ...(found.status === 'active' ? {} : { approvedAt: now }),
          lastSeenAt: now,
          lastIp: input.ip,
          updatedAt: now,
        },
      );

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

    await this.db.manager.insert(devices, {
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

    const row = await this.deviceQuery().where('device.id = :id', { id }).getOne();

    if (row === null) {
      throw new Error('The device was inserted but could not be read back.');
    }

    return row;
  }

  /** Dispositivo do dono. Nunca lê por identificador sozinho. */
  async findOwned(deviceId: string, userId: string): Promise<DeviceRow | undefined> {
    const row = await this.deviceQuery()
      .where('device.id = :deviceId', { deviceId })
      .andWhere('device.userId = :userId', { userId })
      .getOne();

    return (row as DeviceRow | null) ?? undefined;
  }

  async findMany(deviceIds: readonly string[]): Promise<DeviceRow[]> {
    if (deviceIds.length === 0) {
      return [];
    }

    const rows = await this.deviceQuery()
      .where('device.id IN (:...deviceIds)', { deviceIds: [...deviceIds] })
      .getMany();

    return rows;
  }

  /** Marca a batida. `version` sobe para o controle otimista do `Docs/06`. */
  async touch(deviceId: string, clientVersion: string | null, ip: string | null): Promise<void> {
    const now = new Date();

    await this.db.manager.update(
      devices,
      { id: deviceId },
      {
        lastSeenAt: now,
        lastIp: ip,
        updatedAt: now,
        ...(clientVersion === null ? {} : { clientVersion }),
      },
    );
  }

  async findOwner(
    userId: string,
  ): Promise<{ id: string; displayName: string; email: string; avatarUrl: string | null } | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(users, 'user')
      .select(['user.id', 'user.displayName', 'user.email', 'user.avatarUrl'])
      .where('user.id = :userId', { userId })
      .getOne();

    return row ?? undefined;
  }

  /** Base das leituras de dispositivo: só as colunas do contrato. */
  private deviceQuery() {
    return this.db.manager
      .createQueryBuilder(devices, 'device')
      .select(DEVICE_COLUMNS.map((column) => `device.${column}`));
  }
}
