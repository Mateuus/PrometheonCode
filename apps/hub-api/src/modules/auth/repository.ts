/**
 * Acesso ao banco do módulo de autenticação.
 *
 * Só consultas: nenhuma regra de negócio, nenhuma decisão de segurança. Tudo
 * passa pelo TypeORM, então tudo é query parametrizada — o `Docs/09` pede isso e
 * a forma mais segura de garantir é não haver SQL concatenado em lugar algum.
 */

import {
  devices,
  deviceTokens,
  invitations,
  newId,
  organizationMembers,
  organizations,
  plans,
  refreshTokens,
  roles,
  runInTransaction,
  securityEvents,
  userIdentities,
  userSessions,
  users,
  writable,
  type Database,
  type DeviceStatus,
  type Executor,
  type IdentityProvider,
  type Invitation,
  type OrganizationMember,
  type RefreshToken,
  type SecurityEvent,
  type User,
  type UserSession,
} from '@prometheon/database';
import type { SelectQueryBuilder } from 'typeorm';

import { affectedRows } from '../../shared/query.js';

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  status: 'pending' | 'active' | 'suspended' | 'disabled';
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
  /** Administra o Hub inteiro; concedido fora da aplicação. */
  isPlatformAdmin: boolean;
}

export interface MembershipRow {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  roleSlug: string;
  status: 'invited' | 'active' | 'suspended';
  policy: Record<string, unknown> | null;
}

/** Credencial de dispositivo com o estado da máquina que a apresentou. */
export interface DeviceCredentialRow {
  id: string;
  deviceId: string;
  userId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  scope: string | null;
  deviceStatus: DeviceStatus;
}

/** Colunas que o contrato de usuário expõe. Lista explícita: nada de `SELECT *`. */
const USER_COLUMNS = [
  'id',
  'email',
  'displayName',
  'passwordHash',
  'emailVerifiedAt',
  'status',
  'avatarUrl',
  'locale',
  'timezone',
  'createdAt',
  'updatedAt',
  'isPlatformAdmin',
] as const;

export class AuthRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Usuários
  // -------------------------------------------------------------------------

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    const row = await this.userQuery()
      .where('user.email = :email', { email })
      .andWhere('user.deletedAt IS NULL')
      .getOne();

    return (row as UserRow | null) ?? undefined;
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    const row = await this.userQuery()
      .where('user.id = :id', { id })
      .andWhere('user.deletedAt IS NULL')
      .getOne();

    return (row as UserRow | null) ?? undefined;
  }

  /**
   * Cria a conta e, opcionalmente, a primeira organização — numa transação só.
   *
   * Metade disso feito seria pior que nada: uma conta sem organização não
   * consegue fazer nada, e uma organização sem dono fica órfã.
   */
  async createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    organizationName?: string | undefined;
    locale?: string;
    timezone?: string;
  }): Promise<{ userId: string; organizationId: string | null }> {
    const userId = newId();

    return runInTransaction(this.db, async (tx) => {
      const now = new Date();

      await tx.insert(users, {
        id: userId,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        passwordUpdatedAt: now,
        locale: input.locale ?? 'en',
        timezone: input.timezone ?? 'UTC',
        // `pending` até a verificação de e-mail; o login já funciona, o que a
        // conta não verificada não faz é entrar em organização de terceiro.
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });

      if (input.organizationName === undefined) {
        return { userId, organizationId: null };
      }

      const organizationId = await createOrganizationFor(
        tx,
        userId,
        input.organizationName,
      );

      return { userId, organizationId };
    });
  }

  /** Identidade externa já vinculada, se houver. */
  async findIdentity(
    provider: IdentityProvider,
    providerAccountId: string,
  ): Promise<{ id: string; userId: string } | undefined> {
    const rows = await this.db.manager
      .createQueryBuilder(userIdentities, 'identity')
      .select('identity.id', 'id')
      .addSelect('identity.userId', 'userId')
      .where('identity.provider = :provider', { provider })
      .andWhere('identity.providerAccountId = :providerAccountId', { providerAccountId })
      .limit(1)
      .getRawMany<{ id: string; userId: string }>();

    return rows[0];
  }

  async touchIdentity(identityId: string): Promise<void> {
    await this.db.manager.update(
      userIdentities,
      { id: identityId },
      { lastAuthenticatedAt: new Date(), updatedAt: new Date() },
    );
  }

  /**
   * Liga uma conta do provedor a um usuário do Hub.
   *
   * Não guarda token do provedor — a coluna nem existe. O que a identidade
   * responde é "esta conta do GitHub é daquela pessoa"; agir no GitHub em nome
   * dela é outro consentimento, com credencial cifrada em `git_connections`.
   */
  async linkIdentity(input: {
    userId: string;
    provider: IdentityProvider;
    providerAccountId: string;
    email: string | null;
    displayName: string | null;
  }): Promise<string> {
    const id = newId();
    const now = new Date();

    await this.db.manager.insert(userIdentities, {
      id,
      userId: input.userId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      email: input.email,
      displayName: input.displayName,
      lastAuthenticatedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return id;
  }

  /**
   * Cria a conta de quem chegou por um provedor externo.
   *
   * Nasce **sem senha** e já verificada: o provedor confirmou o endereço, e
   * exigir que a pessoa confirme de novo um e-mail que ela acabou de provar
   * possuir seria cerimônia. Quem quiser senha depois usa a recuperação, que já
   * exige acesso à caixa postal.
   *
   * A identidade entra na mesma transação que o usuário. Separadas, uma falha no
   * meio deixaria uma conta órfã que ninguém consegue acessar — nem por senha,
   * que não existe, nem pelo provedor, que não está vinculado.
   */
  async createUserFromProvider(input: {
    email: string;
    displayName: string;
    provider: IdentityProvider;
    providerAccountId: string;
    avatarUrl: string | null;
  }): Promise<{ userId: string; organizationId: string | null }> {
    const userId = newId();

    return runInTransaction(this.db, async (tx) => {
      const now = new Date();

      await tx.insert(users, {
        id: userId,
        email: input.email,
        displayName: input.displayName,
        passwordHash: null,
        avatarUrl: input.avatarUrl,
        emailVerifiedAt: now,
        locale: 'en',
        timezone: 'UTC',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(userIdentities, {
        id: newId(),
        userId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        email: input.email,
        displayName: input.displayName,
        lastAuthenticatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const organizationId = await createOrganizationFor(
        tx,
        userId,
        `${input.displayName}'s workspace`,
      );

      return { userId, organizationId };
    });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.db.manager.update(
      users,
      { id: userId },
      { emailVerifiedAt: new Date(), status: 'active', updatedAt: new Date() },
    );
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.manager.update(
      users,
      { id: userId },
      { passwordHash, passwordUpdatedAt: new Date(), updatedAt: new Date() },
    );
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db.manager.update(users, { id: userId }, { lastLoginAt: new Date() });
  }

  // -------------------------------------------------------------------------
  // Organizações e papéis
  // -------------------------------------------------------------------------

  async listMemberships(userId: string): Promise<MembershipRow[]> {
    return this.membershipQuery()
      .where('member.userId = :userId', { userId })
      .andWhere('organization.deletedAt IS NULL')
      .orderBy('organization.createdAt', 'ASC')
      .getRawMany<MembershipRow>();
  }

  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<MembershipRow | undefined> {
    const rows = await this.membershipQuery()
      .where('member.organizationId = :organizationId', { organizationId })
      .andWhere('member.userId = :userId', { userId })
      .andWhere('organization.deletedAt IS NULL')
      .limit(1)
      .getRawMany<MembershipRow>();

    return rows[0];
  }

  async findInvitationByHash(tokenHash: string): Promise<Invitation | undefined> {
    const row = await this.db.manager.findOne(invitations, { where: { tokenHash } });

    return row ?? undefined;
  }

  async acceptInvitation(input: {
    invitationId: string;
    organizationId: string;
    roleId: string;
    userId: string;
  }): Promise<void> {
    await runInTransaction(this.db, async (tx) => {
      await tx.update(
        invitations,
        { id: input.invitationId },
        {
          status: 'accepted',
          acceptedAt: new Date(),
          acceptedByUserId: input.userId,
          updatedAt: new Date(),
        },
      );

      await tx.insert(organizationMembers, {
        id: newId(),
        organizationId: input.organizationId,
        userId: input.userId,
        roleId: input.roleId,
        status: 'active',
        joinedAt: new Date(),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Sessões e refresh tokens
  // -------------------------------------------------------------------------

  async createSession(input: {
    userId: string;
    organizationId: string | null;
    deviceId: string | null;
    ip: string | null;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<string> {
    const id = newId();

    await this.db.manager.insert(userSessions, {
      id,
      userId: input.userId,
      organizationId: input.organizationId,
      deviceId: input.deviceId,
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt: input.expiresAt,
      lastSeenAt: new Date(),
    });

    return id;
  }

  async findSession(sessionId: string): Promise<UserSession | undefined> {
    const row = await this.db.manager.findOne(userSessions, { where: { id: sessionId } });

    return row ?? undefined;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db.manager.update(
      userSessions,
      { id: sessionId },
      { lastSeenAt: new Date(), updatedAt: new Date() },
    );
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    // `revoked_at IS NULL` preserva o instante e o motivo da primeira revogação:
    // uma segunda chamada não reescreve o que já ficou registrado.
    await this.db.manager
      .createQueryBuilder()
      .update(userSessions)
      .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
      .where('id = :sessionId', { sessionId })
      .andWhere('revoked_at IS NULL')
      .execute();
  }

  async listActiveSessionIds(userId: string): Promise<string[]> {
    const rows = await this.db.manager
      .createQueryBuilder(userSessions, 'session')
      .select('session.id')
      .where('session.userId = :userId', { userId })
      .andWhere('session.revokedAt IS NULL')
      .getMany();

    return rows.map((row) => row.id);
  }

  async revokeAllSessions(userId: string, reason: string): Promise<string[]> {
    const ids = await this.listActiveSessionIds(userId);

    if (ids.length === 0) {
      return [];
    }

    await this.db.manager
      .createQueryBuilder()
      .update(userSessions)
      .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL')
      .execute();

    await this.db.manager
      .createQueryBuilder()
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('revoked_at IS NULL')
      .execute();

    return ids;
  }

  /**
   * Revoga dispositivos do usuário e as credenciais deles.
   *
   * Sem `deviceId`, derruba todos — é o que a troca de senha e o reset por
   * e-mail fazem. Com `deviceId`, derruba um só, e o `user_id` no `WHERE` do
   * `SELECT` é o que impede alguém de desconectar dispositivo alheio: a consulta
   * não encontra linha, em vez de depender de uma conferência posterior que
   * alguém pode esquecer de escrever na próxima chamada.
   *
   * Dispositivo e credencial caem na **mesma transação**, pelo mesmo motivo que
   * sessão e refresh token: entre um `UPDATE` e o outro existe uma janela, e é
   * nela que quem está sendo expulso ainda passaria.
   *
   * Não precisa de denylist no Redis. A credencial de dispositivo é conferida no
   * banco a cada requisição (ver `resolveDeviceCredential` em `plugins/auth.ts`),
   * então a revogação vale na chamada seguinte — diferente do access token de
   * sessão, que é assinado e sobrevive até expirar.
   */
  async revokeDevices(input: {
    userId: string;
    deviceId?: string;
    reason: string;
  }): Promise<string[]> {
    return runInTransaction(this.db, async (tx) => {
      const doomed = tx
        .createQueryBuilder(devices, 'device')
        .select('device.id')
        .where('device.userId = :userId', { userId: input.userId })
        .andWhere('device.revokedAt IS NULL');

      if (input.deviceId !== undefined) {
        doomed.andWhere('device.id = :deviceId', { deviceId: input.deviceId });
      }

      const ids = (await doomed.getMany()).map((row) => row.id);

      if (ids.length === 0) {
        return [];
      }

      const now = new Date();

      await tx
        .createQueryBuilder()
        .update(devices)
        .set({ status: 'revoked', revokedAt: now, updatedAt: now })
        .where('id IN (:...ids)', { ids })
        .andWhere('revoked_at IS NULL')
        .execute();

      // A credencial é o que a extensão manda a cada chamada. Sem derrubá-la, o
      // status `revoked` do dispositivo seria a única barreira — e bastaria uma
      // consulta nova que esquecesse de conferi-lo para o acesso voltar.
      await tx
        .createQueryBuilder()
        .update(deviceTokens)
        .set({ revokedAt: now, revokedReason: input.reason, updatedAt: now })
        .where('device_id IN (:...ids)', { ids })
        .andWhere('revoked_at IS NULL')
        .execute();

      return ids;
    });
  }

  async insertRefreshToken(input: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    previousTokenId: string | null;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
  }): Promise<string> {
    const id = newId();

    await this.db.manager.insert(refreshTokens, {
      id,
      sessionId: input.sessionId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      previousTokenId: input.previousTokenId,
      expiresAt: input.expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    return id;
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined> {
    const row = await this.db.manager.findOne(refreshTokens, { where: { tokenHash } });

    return row ?? undefined;
  }

  /**
   * Marca o token como usado **e** garante que ele ainda não estava.
   *
   * A condição `used_at IS NULL` no `WHERE` é o que impede dois refreshes
   * simultâneos de rotacionar o mesmo token: o segundo `UPDATE` afeta zero
   * linhas, e quem chamou trata isso como reuso.
   */
  async consumeRefreshToken(tokenId: string): Promise<boolean> {
    const result = await this.db.manager
      .createQueryBuilder()
      .update(refreshTokens)
      .set({ usedAt: new Date(), updatedAt: new Date() })
      .where('id = :tokenId', { tokenId })
      .andWhere('used_at IS NULL')
      .execute();

    // Zero linhas não é falha da consulta: é o banco dizendo que outro refresh
    // chegou primeiro.
    return affectedRows(result) > 0;
  }

  /**
   * Revoga a família inteira de refresh tokens de uma sessão.
   *
   * Reuso de refresh token significa que o valor vazou: ou o legítimo está com
   * o atacante, ou o do atacante está com o legítimo. Não dá para saber qual, e
   * por isso a resposta é derrubar a sessão inteira — é o comportamento que a
   * RFC 6749bis descreve e o que o `Docs/09` chama de rotação.
   */
  async revokeTokenFamily(sessionId: string, reason: string): Promise<void> {
    await runInTransaction(this.db, async (tx) => {
      await tx
        .createQueryBuilder()
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
        .where('session_id = :sessionId', { sessionId })
        .andWhere('revoked_at IS NULL')
        .execute();

      await tx
        .createQueryBuilder()
        .update(userSessions)
        .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
        .where('id = :sessionId', { sessionId })
        .andWhere('revoked_at IS NULL')
        .execute();
    });
  }

  // -------------------------------------------------------------------------
  // Dispositivos
  // -------------------------------------------------------------------------

  async upsertDevice(input: {
    userId: string;
    name: string;
    platform: 'windows' | 'macos' | 'linux' | 'web' | 'other';
    client: string;
    clientVersion: string | null;
    fingerprint: string | null;
    ip: string | null;
  }): Promise<string> {
    if (input.fingerprint !== null) {
      const found = await this.db.manager
        .createQueryBuilder(devices, 'device')
        .select('device.id')
        .where('device.userId = :userId', { userId: input.userId })
        .andWhere('device.fingerprint = :fingerprint', { fingerprint: input.fingerprint })
        .getOne();

      if (found !== null) {
        await this.db.manager.update(
          devices,
          { id: found.id },
          {
            name: input.name,
            platform: input.platform,
            clientVersion: input.clientVersion,
            status: 'active',
            approvedAt: new Date(),
            revokedAt: null,
            lastSeenAt: new Date(),
            lastIp: input.ip,
            updatedAt: new Date(),
          },
        );

        return found.id;
      }
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
      approvedAt: new Date(),
      lastSeenAt: new Date(),
      lastIp: input.ip,
    });

    return id;
  }

  async insertDeviceCredential(input: {
    deviceId: string;
    userId: string;
    tokenHash: string;
    scope: string | null;
    expiresAt: Date;
  }): Promise<string> {
    const id = newId();

    await this.db.manager.insert(deviceTokens, {
      id,
      deviceId: input.deviceId,
      userId: input.userId,
      type: 'device_credential',
      tokenHash: input.tokenHash,
      scope: input.scope,
      expiresAt: input.expiresAt,
      approvedAt: new Date(),
    });

    return id;
  }

  /**
   * Credencial de dispositivo pelo hash apresentado.
   *
   * O `status` do dispositivo vem no mesmo `SELECT` porque quem autentica
   * precisa das duas coisas: a credencial pode estar válida e a máquina já ter
   * sido revogada. São colunas de tabelas diferentes, então o resultado é linha
   * crua, não entidade hidratada.
   */
  async findDeviceCredential(tokenHash: string): Promise<DeviceCredentialRow | undefined> {
    const rows = await this.db.manager
      .createQueryBuilder(deviceTokens, 'token')
      .select('token.id', 'id')
      .addSelect('token.deviceId', 'deviceId')
      .addSelect('token.userId', 'userId')
      .addSelect('token.expiresAt', 'expiresAt')
      .addSelect('token.revokedAt', 'revokedAt')
      .addSelect('token.scope', 'scope')
      .addSelect('device.status', 'deviceStatus')
      .innerJoin(devices.options.name, 'device', 'device.id = token.deviceId')
      .where('token.tokenHash = :tokenHash', { tokenHash })
      .andWhere('token.type = :type', { type: 'device_credential' })
      .limit(1)
      .getRawMany<DeviceCredentialRow>();

    return rows[0];
  }

  async touchDeviceCredential(tokenId: string, deviceId: string): Promise<void> {
    await this.db.manager.update(
      deviceTokens,
      { id: tokenId },
      { lastUsedAt: new Date(), updatedAt: new Date() },
    );

    await this.db.manager.update(
      devices,
      { id: deviceId },
      { lastSeenAt: new Date(), updatedAt: new Date() },
    );
  }

  // -------------------------------------------------------------------------
  // Eventos de segurança
  // -------------------------------------------------------------------------

  /**
   * Registra um evento de segurança (`Docs/09`).
   *
   * `details` é livre, mas nunca recebe token, senha ou hash — a redaction do
   * logger não alcança o que vai para o banco.
   */
  async recordSecurityEvent(input: {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    userId?: string | null;
    organizationId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.manager.insert(
      securityEvents,
      writable<SecurityEvent>({
        id: newId(),
        type: input.type,
        severity: input.severity,
        userId: input.userId ?? null,
        organizationId: input.organizationId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        details: input.details ?? null,
        occurredAt: new Date(),
      }),
    );
  }

  /** Base das leituras de usuário: só as colunas do contrato. */
  private userQuery(): SelectQueryBuilder<User> {
    return this.db.manager
      .createQueryBuilder(users, 'user')
      .select(USER_COLUMNS.map((column) => `user.${column}`));
  }

  /**
   * Base das leituras de associação: organização, papel e situação.
   *
   * Mistura colunas de três tabelas, então o resultado é linha crua — uma
   * entidade hidratada precisaria de relações que o schema não declara.
   */
  private membershipQuery(): SelectQueryBuilder<OrganizationMember> {
    return this.db.manager
      .createQueryBuilder(organizationMembers, 'member')
      .select('organization.id', 'organizationId')
      .addSelect('organization.name', 'organizationName')
      .addSelect('organization.slug', 'organizationSlug')
      .addSelect('role.slug', 'roleSlug')
      .addSelect('member.status', 'status')
      .addSelect('organization.policy', 'policy')
      .innerJoin(
        organizations.options.name,
        'organization',
        'organization.id = member.organizationId',
      )
      .innerJoin(roles.options.name, 'role', 'role.id = member.roleId');
  }
}

/**
 * Cria uma organização com o usuário como dono.
 *
 * Fica fora da classe porque o registro e o módulo de organizações usam a mesma
 * sequência: plano padrão, slug livre, papel `owner`. Aceita tanto o
 * `DataSource` quanto o gerenciador de uma transação já aberta — o registro
 * precisa que a organização nasça junto com a conta.
 */
export async function createOrganizationFor(
  db: Database | Executor,
  userId: string,
  name: string,
): Promise<string> {
  const executor = manager(db);

  const plan = await executor
    .createQueryBuilder(plans, 'plan')
    .select('plan.id')
    .where('plan.isDefault = :isDefault', { isDefault: true })
    .andWhere('plan.isActive = :isActive', { isActive: true })
    .getOne();

  const planId = plan?.id;

  if (planId === undefined) {
    throw new Error('No default plan is configured. Run the database seed first.');
  }

  const ownerRole = await executor
    .createQueryBuilder(roles, 'role')
    .select('role.id')
    .where('role.organizationId IS NULL')
    .andWhere('role.slug = :slug', { slug: 'owner' })
    .getOne();

  const ownerRoleId = ownerRole?.id;

  if (ownerRoleId === undefined) {
    throw new Error('The system roles are missing. Run the database seed first.');
  }

  const organizationId = newId();
  const slug = await uniqueSlug(executor, name);

  await executor.insert(organizations, {
    id: organizationId,
    slug,
    name,
    planId,
    ownerUserId: userId,
    status: 'active',
    createdBy: userId,
  });

  await executor.insert(organizationMembers, {
    id: newId(),
    organizationId,
    userId,
    roleId: ownerRoleId,
    status: 'active',
    joinedAt: new Date(),
    createdBy: userId,
  });

  return organizationId;
}

/** Slug a partir do nome, com sufixo numérico quando já existir. */
export async function uniqueSlug(db: Database | Executor, name: string): Promise<string> {
  const executor = manager(db);
  const base =
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'organization';

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${String(attempt + 1)}`;
    const taken = await executor
      .createQueryBuilder(organizations, 'organization')
      .select('organization.id')
      .where('organization.slug = :candidate', { candidate })
      .getOne();

    if (taken === null) {
      return candidate;
    }
  }

  // Depois de 50 colisões, desiste de ser bonito e usa um sufixo aleatório.
  return `${base}-${newId().slice(-6).toLowerCase()}`;
}

/** Aceita tanto o `DataSource` quanto um `EntityManager` já aberto. */
function manager(db: Database | Executor): Executor {
  return 'manager' in db ? db.manager : db;
}
