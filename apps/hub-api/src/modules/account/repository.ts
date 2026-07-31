/**
 * Acesso ao banco da gestão da própria conta.
 *
 * Só consultas, como em `modules/auth/repository.ts`: nenhuma decisão de
 * segurança mora aqui. O que este arquivo acrescenta ao repositório de
 * autenticação são as três leituras e escritas que só a conta precisa — listar
 * as sessões vivas, derrubar todas menos uma, e gravar o perfil.
 *
 * O que **não** está aqui de propósito: revogar uma sessão específica, que já é
 * `AuthRepository.revokeTokenFamily()`, e revogar dispositivos, que é
 * `AuthRepository.revokeDevices()` — usada tanto aqui quanto no reset de senha
 * por e-mail. Uma segunda implementação da mesma revogação seria a que ficaria
 * desatualizada, e uma revogação desatualizada é uma porta que continua aberta.
 */

import {
  deviceTokens,
  devices,
  refreshTokens,
  runInTransaction,
  userSessions,
  users,
  writable,
  type Database,
  type User,
} from '@prometheon/database';

import { applyKeyset } from '../../shared/query.js';
import type { CursorPayload } from '../../shared/cursor.js';

/** Uma sessão viva, já com o nome do dispositivo quando houver um. */
export interface SessionRow {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
}

/** Um dispositivo que ainda pode falar com o Hub em nome da pessoa. */
export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  client: string;
  clientVersion: string | null;
  lastIp: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  credentialExpiresAt: Date | null;
}

/** Campos do perfil que a pessoa edita. `email` não está aqui — ver o contrato. */
export interface ProfilePatch {
  displayName?: string;
  locale?: string;
  timezone?: string;
  avatarUrl?: string | null;
}

export class AccountRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Sessões
  // -------------------------------------------------------------------------

  /**
   * Sessões vivas do usuário, da mais recente para a mais antiga.
   *
   * "Viva" é não revogada e ainda dentro da validade. Sessão morta não entra na
   * lista: ela não é uma porta que ainda dá para fechar, e mostrá-la só faria a
   * pessoa procurar um botão que não existe.
   *
   * Lê `limit + 1` linhas para responder `hasMore` sem um `COUNT(*)`.
   */
  async listSessions(input: {
    userId: string;
    limit: number;
    after: CursorPayload | undefined;
  }): Promise<SessionRow[]> {
    const query = this.db.manager
      .createQueryBuilder(userSessions, 'session')
      .select('session.id', 'id')
      .addSelect('session.deviceId', 'deviceId')
      .addSelect('session.ip', 'ip')
      .addSelect('session.userAgent', 'userAgent')
      .addSelect('session.createdAt', 'createdAt')
      .addSelect('session.lastSeenAt', 'lastSeenAt')
      .addSelect('session.expiresAt', 'expiresAt')
      .addSelect('device.name', 'deviceName')
      // `leftJoin`: a maioria das sessões é de navegador e não tem dispositivo
      // registrado. Um `innerJoin` sumiria justamente com elas.
      .leftJoin(devices.options.name, 'device', 'device.id = session.deviceId')
      .where('session.userId = :userId', { userId: input.userId })
      .andWhere('session.revokedAt IS NULL')
      .andWhere('session.expiresAt > :now', { now: new Date() })
      .orderBy('session.createdAt', 'DESC')
      .addOrderBy('session.id', 'DESC')
      .limit(input.limit + 1);

    return applyKeyset(query, 'session', { createdAt: 'createdAt', id: 'id' }, input.after)
      .getRawMany<SessionRow>();
  }

  /**
   * Uma sessão viva **do usuário informado**.
   *
   * O `user_id` entra no `WHERE`, e não numa conferência depois da leitura: quem
   * escrever uma chamada nova não consegue esquecer de comparar o dono.
   */
  async findSessionOfUser(sessionId: string, userId: string): Promise<SessionRow | undefined> {
    const rows = await this.db.manager
      .createQueryBuilder(userSessions, 'session')
      .select('session.id', 'id')
      .addSelect('session.deviceId', 'deviceId')
      .addSelect('session.ip', 'ip')
      .addSelect('session.userAgent', 'userAgent')
      .addSelect('session.createdAt', 'createdAt')
      .addSelect('session.lastSeenAt', 'lastSeenAt')
      .addSelect('session.expiresAt', 'expiresAt')
      .addSelect('device.name', 'deviceName')
      .leftJoin(devices.options.name, 'device', 'device.id = session.deviceId')
      .where('session.id = :sessionId', { sessionId })
      .andWhere('session.userId = :userId', { userId })
      .andWhere('session.revokedAt IS NULL')
      .limit(1)
      .getRawMany<SessionRow>();

    return rows[0];
  }

  /**
   * Revoga todas as sessões do usuário menos uma, com os refresh tokens delas.
   *
   * Sessão e token caem na **mesma transação**: entre um `UPDATE` e o outro há
   * uma janela em que a sessão já está revogada mas o refresh ainda não, e é
   * exatamente nessa janela que quem está sendo expulso poderia rotacionar o
   * token e continuar dentro.
   *
   * `keepSessionId` nulo derruba tudo — é o caso de quem trocou a senha usando
   * uma credencial de dispositivo, que não tem sessão para preservar.
   */
  async revokeSessionsExcept(input: {
    userId: string;
    keepSessionId: string | null;
    reason: string;
  }): Promise<string[]> {
    return runInTransaction(this.db, async (tx) => {
      const doomed = tx
        .createQueryBuilder(userSessions, 'session')
        .select('session.id')
        .where('session.userId = :userId', { userId: input.userId })
        .andWhere('session.revokedAt IS NULL');

      if (input.keepSessionId !== null) {
        doomed.andWhere('session.id <> :keep', { keep: input.keepSessionId });
      }

      const ids = (await doomed.getMany()).map((row) => row.id);

      if (ids.length === 0) {
        return [];
      }

      const now = new Date();

      await tx
        .createQueryBuilder()
        .update(userSessions)
        .set({ revokedAt: now, revokedReason: input.reason, updatedAt: now })
        .where('id IN (:...ids)', { ids })
        .andWhere('revoked_at IS NULL')
        .execute();

      // Os refresh tokens são selecionados pelas sessões que acabaram de cair, e
      // não por `user_id`: filtrar pelo usuário derrubaria também o token da
      // sessão preservada.
      await tx
        .createQueryBuilder()
        .update(refreshTokens)
        .set({ revokedAt: now, revokedReason: input.reason, updatedAt: now })
        .where('session_id IN (:...ids)', { ids })
        .andWhere('revoked_at IS NULL')
        .execute();

      return ids;
    });
  }

  // -------------------------------------------------------------------------
  // Dispositivos
  // -------------------------------------------------------------------------

  /**
   * Dispositivos que ainda conseguem agir em nome da pessoa.
   *
   * O critério é ter credencial viva, não ter status bonito: um dispositivo
   * `active` cuja credencial já expirou não abre porta nenhuma, e listá-lo
   * levaria alguém a revogar o que já estava fechado — enquanto a porta de
   * verdade continuaria aberta em outro lugar da tela.
   *
   * `credentialExpiresAt` é o máximo entre as credenciais vivas do dispositivo,
   * que é quando ele efetivamente deixa de conseguir entrar.
   */
  async listDevices(userId: string): Promise<DeviceRow[]> {
    return this.db.manager
      .createQueryBuilder(devices, 'device')
      .select('device.id', 'id')
      .addSelect('device.name', 'name')
      .addSelect('device.platform', 'platform')
      .addSelect('device.client', 'client')
      .addSelect('device.clientVersion', 'clientVersion')
      .addSelect('device.lastIp', 'lastIp')
      .addSelect('device.lastSeenAt', 'lastSeenAt')
      .addSelect('device.createdAt', 'createdAt')
      .addSelect('MAX(token.expiresAt)', 'credentialExpiresAt')
      .innerJoin(
        deviceTokens.options.name,
        'token',
        `token.device_id = device.id
           and token.type = :type
           and token.revoked_at is null
           and token.expires_at > :now`,
        { type: 'device_credential', now: new Date() },
      )
      .where('device.userId = :userId', { userId })
      .andWhere('device.revokedAt IS NULL')
      .andWhere('device.status <> :revoked', { revoked: 'revoked' })
      .groupBy('device.id')
      .orderBy('device.lastSeenAt', 'DESC')
      .addOrderBy('device.id', 'DESC')
      .getRawMany<DeviceRow>();
  }

  // -------------------------------------------------------------------------
  // Perfil
  // -------------------------------------------------------------------------

  async updateProfile(userId: string, patch: ProfilePatch): Promise<void> {
    await this.db.manager.update(
      users,
      { id: userId },
      writable<User>({ ...patch, updatedAt: new Date() }),
    );
  }
}
