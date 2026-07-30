/**
 * Acesso ao banco do módulo de autenticação.
 *
 * Só consultas: nenhuma regra de negócio, nenhuma decisão de segurança. Tudo é
 * Drizzle, então tudo é query parametrizada — o `Docs/09` pede isso e a forma
 * mais segura de garantir é não haver SQL concatenado em lugar algum.
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
  securityEvents,
  userSessions,
  users,
  type Database,
} from '@prometheon/database';
import { and, eq, isNull } from 'drizzle-orm';

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
}

export interface MembershipRow {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  roleSlug: string;
  status: 'invited' | 'active' | 'suspended';
  policy: Record<string, unknown> | null;
}

export class AuthRepository {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Usuários
  // -------------------------------------------------------------------------

  async findUserByEmail(email: string): Promise<UserRow | undefined> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);

    return rows[0];
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);

    return rows[0];
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

    return this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        passwordUpdatedAt: new Date(),
        locale: input.locale ?? 'en',
        timezone: input.timezone ?? 'UTC',
        // `pending` até a verificação de e-mail; o login já funciona, o que a
        // conta não verificada não faz é entrar em organização de terceiro.
        status: 'pending',
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

  async markEmailVerified(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ emailVerifiedAt: new Date(), status: 'active', updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ passwordHash, passwordUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, userId));
  }

  // -------------------------------------------------------------------------
  // Organizações e papéis
  // -------------------------------------------------------------------------

  async listMemberships(userId: string): Promise<MembershipRow[]> {
    const rows = await this.db
      .select({
        organizationId: organizations.id,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        roleSlug: roles.slug,
        status: organizationMembers.status,
        policy: organizations.policy,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
      .orderBy(organizations.createdAt);

    return rows;
  }

  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<MembershipRow | undefined> {
    const rows = await this.db
      .select({
        organizationId: organizations.id,
        organizationName: organizations.name,
        organizationSlug: organizations.slug,
        roleSlug: roles.slug,
        status: organizationMembers.status,
        policy: organizations.policy,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
          isNull(organizations.deletedAt),
        ),
      )
      .limit(1);

    return rows[0];
  }

  async findInvitationByHash(tokenHash: string) {
    const rows = await this.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);

    return rows[0];
  }

  async acceptInvitation(input: {
    invitationId: string;
    organizationId: string;
    roleId: string;
    userId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(invitations)
        .set({
          status: 'accepted',
          acceptedAt: new Date(),
          acceptedByUserId: input.userId,
          updatedAt: new Date(),
        })
        .where(eq(invitations.id, input.invitationId));

      await tx.insert(organizationMembers).values({
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

    await this.db.insert(userSessions).values({
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

  async findSession(sessionId: string) {
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .limit(1);

    return rows[0];
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(userSessions.id, sessionId));
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db
      .update(userSessions)
      .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
  }

  async listActiveSessionIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));

    return rows.map((row) => row.id);
  }

  async revokeAllSessions(userId: string, reason: string): Promise<string[]> {
    const ids = await this.listActiveSessionIds(userId);

    if (ids.length === 0) {
      return [];
    }

    await this.db
      .update(userSessions)
      .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));

    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

    return ids;
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

    await this.db.insert(refreshTokens).values({
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

  async findRefreshTokenByHash(tokenHash: string) {
    const rows = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    return rows[0];
  }

  /**
   * Marca o token como usado **e** garante que ele ainda não estava.
   *
   * A condição `used_at IS NULL` no `WHERE` é o que impede dois refreshes
   * simultâneos de rotacionar o mesmo token: o segundo `UPDATE` afeta zero
   * linhas, e quem chamou trata isso como reuso.
   */
  async consumeRefreshToken(tokenId: string): Promise<boolean> {
    const result = await this.db
      .update(refreshTokens)
      .set({ usedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(refreshTokens.id, tokenId), isNull(refreshTokens.usedAt)));

    // O driver do mysql2 devolve `affectedRows` no primeiro elemento.
    const affected = (result as unknown as [{ affectedRows?: number }])[0].affectedRows ?? 0;

    return affected > 0;
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
    await this.db.transaction(async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
        .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));

      await tx
        .update(userSessions)
        .set({ revokedAt: new Date(), revokedReason: reason, updatedAt: new Date() })
        .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
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
      const existing = await this.db
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(eq(devices.userId, input.userId), eq(devices.fingerprint, input.fingerprint)),
        )
        .limit(1);

      const found = existing[0];

      if (found !== undefined) {
        await this.db
          .update(devices)
          .set({
            name: input.name,
            platform: input.platform,
            clientVersion: input.clientVersion,
            status: 'active',
            approvedAt: new Date(),
            revokedAt: null,
            lastSeenAt: new Date(),
            lastIp: input.ip,
            updatedAt: new Date(),
          })
          .where(eq(devices.id, found.id));

        return found.id;
      }
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

    await this.db.insert(deviceTokens).values({
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

  async findDeviceCredential(tokenHash: string) {
    const rows = await this.db
      .select({
        id: deviceTokens.id,
        deviceId: deviceTokens.deviceId,
        userId: deviceTokens.userId,
        expiresAt: deviceTokens.expiresAt,
        revokedAt: deviceTokens.revokedAt,
        scope: deviceTokens.scope,
        deviceStatus: devices.status,
      })
      .from(deviceTokens)
      .innerJoin(devices, eq(devices.id, deviceTokens.deviceId))
      .where(
        and(eq(deviceTokens.tokenHash, tokenHash), eq(deviceTokens.type, 'device_credential')),
      )
      .limit(1);

    return rows[0];
  }

  async touchDeviceCredential(tokenId: string, deviceId: string): Promise<void> {
    await this.db
      .update(deviceTokens)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(deviceTokens.id, tokenId));

    await this.db
      .update(devices)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(devices.id, deviceId));
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
    await this.db.insert(securityEvents).values({
      id: newId(),
      type: input.type,
      severity: input.severity,
      userId: input.userId ?? null,
      organizationId: input.organizationId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      details: input.details ?? null,
      occurredAt: new Date(),
    });
  }
}

/**
 * Cria uma organização com o usuário como dono.
 *
 * Fica fora da classe porque o registro e o módulo de organizações usam a mesma
 * sequência: plano padrão, slug livre, papel `owner`.
 */
export async function createOrganizationFor(
  db: Database,
  userId: string,
  name: string,
): Promise<string> {
  const planRows = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.isDefault, true), eq(plans.isActive, true)))
    .limit(1);

  const planId = planRows[0]?.id;

  if (planId === undefined) {
    throw new Error('No default plan is configured. Run the database seed first.');
  }

  const ownerRoleRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.organizationId), eq(roles.slug, 'owner')))
    .limit(1);

  const ownerRoleId = ownerRoleRows[0]?.id;

  if (ownerRoleId === undefined) {
    throw new Error('The system roles are missing. Run the database seed first.');
  }

  const organizationId = newId();
  const slug = await uniqueSlug(db, name);

  await db.insert(organizations).values({
    id: organizationId,
    slug,
    name,
    planId,
    ownerUserId: userId,
    status: 'active',
    createdBy: userId,
  });

  await db.insert(organizationMembers).values({
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
export async function uniqueSlug(db: Database, name: string): Promise<string> {
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
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);

    if (rows.length === 0) {
      return candidate;
    }
  }

  // Depois de 50 colisões, desiste de ser bonito e usa um sufixo aleatório.
  return `${base}-${newId().slice(-6).toLowerCase()}`;
}
