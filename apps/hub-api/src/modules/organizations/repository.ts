/**
 * Acesso ao banco do módulo de organizações.
 *
 * Listagens usam cursor `(created_at, id)` — o par que o `Docs/06` pede e que
 * os índices do `Docs/07` já cobrem.
 */

import {
  invitations,
  newId,
  organizationMembers,
  organizations,
  plans,
  roles,
  users,
  type Database,
} from '@prometheon/database';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { decodeCursor, type CursorPayload } from '../../shared/cursor.js';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  planCode: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  version: number;
  roleSlug: string;
}

export interface MemberRow {
  id: string;
  organizationId: string;
  roleSlug: string;
  status: 'invited' | 'active' | 'suspended';
  invitedBy: string | null;
  joinedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
}

export class OrganizationRepository {
  constructor(private readonly db: Database) {}

  /** Organizações em que o usuário é membro, paginadas por cursor. */
  async listForUser(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<OrganizationRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);

    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        planCode: plans.code,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        createdBy: organizations.createdBy,
        version: organizations.version,
        roleSlug: roles.slug,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(plans, eq(plans.id, organizations.planId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.userId, userId),
          isNull(organizations.deletedAt),
          keysetCondition(organizations.createdAt, organizations.id, after),
        ),
      )
      .orderBy(desc(organizations.createdAt), desc(organizations.id))
      .limit(limit + 1);

    return rows;
  }

  async findById(organizationId: string): Promise<OrganizationRow | undefined> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        planCode: plans.code,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
        createdBy: organizations.createdBy,
        version: organizations.version,
        roleSlug: sql<string>`''`,
      })
      .from(organizations)
      .innerJoin(plans, eq(plans.id, organizations.planId))
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .limit(1);

    return rows[0];
  }

  async listMembers(
    organizationId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<MemberRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);

    const rows = await this.db
      .select({
        id: organizationMembers.id,
        organizationId: organizationMembers.organizationId,
        roleSlug: roles.slug,
        status: organizationMembers.status,
        invitedBy: organizationMembers.invitedBy,
        joinedAt: organizationMembers.joinedAt,
        createdAt: organizationMembers.createdAt,
        updatedAt: organizationMembers.updatedAt,
        version: organizationMembers.version,
        userId: users.id,
        userName: users.displayName,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          keysetCondition(organizationMembers.createdAt, organizationMembers.id, after),
        ),
      )
      .orderBy(desc(organizationMembers.createdAt), desc(organizationMembers.id))
      .limit(limit + 1);

    return rows;
  }

  async findMemberById(memberId: string): Promise<MemberRow | undefined> {
    const rows = await this.db
      .select({
        id: organizationMembers.id,
        organizationId: organizationMembers.organizationId,
        roleSlug: roles.slug,
        status: organizationMembers.status,
        invitedBy: organizationMembers.invitedBy,
        joinedAt: organizationMembers.joinedAt,
        createdAt: organizationMembers.createdAt,
        updatedAt: organizationMembers.updatedAt,
        version: organizationMembers.version,
        userId: users.id,
        userName: users.displayName,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(eq(organizationMembers.id, memberId))
      .limit(1);

    return rows[0];
  }

  /**
   * Atualiza papel e situação com concorrência otimista (`Docs/06`).
   *
   * A `version` que o cliente leu entra no `WHERE`. Se outra escrita passou no
   * meio, nenhuma linha é afetada e quem chamou recebe `VERSION_CONFLICT` — em
   * vez de sobrescrever silenciosamente a decisão de outra pessoa.
   */
  async updateMember(input: {
    memberId: string;
    version: number;
    roleId?: string;
    status?: 'invited' | 'active' | 'suspended';
  }): Promise<boolean> {
    const result = await this.db
      .update(organizationMembers)
      .set({
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        version: sql`${organizationMembers.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(organizationMembers.id, input.memberId),
          eq(organizationMembers.version, input.version),
        ),
      );

    const affected = (result as unknown as [{ affectedRows?: number }])[0].affectedRows ?? 0;

    return affected > 0;
  }

  async countOwners(organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(organizationMembers)
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(roles.slug, 'owner'),
          eq(organizationMembers.status, 'active'),
        ),
      );

    return rows[0]?.count ?? 0;
  }

  async findMemberByUser(
    organizationId: string,
    userId: string,
  ): Promise<MemberRow | undefined> {
    const rows = await this.listMembersByUser(organizationId, userId);

    return rows[0];
  }

  private async listMembersByUser(
    organizationId: string,
    userId: string,
  ): Promise<MemberRow[]> {
    const rows = await this.db
      .select({
        id: organizationMembers.id,
        organizationId: organizationMembers.organizationId,
        roleSlug: roles.slug,
        status: organizationMembers.status,
        invitedBy: organizationMembers.invitedBy,
        joinedAt: organizationMembers.joinedAt,
        createdAt: organizationMembers.createdAt,
        updatedAt: organizationMembers.updatedAt,
        version: organizationMembers.version,
        userId: users.id,
        userName: users.displayName,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1);

    return rows;
  }

  // -------------------------------------------------------------------------
  // Convites
  // -------------------------------------------------------------------------

  async createInvitation(input: {
    organizationId: string;
    email: string;
    roleId: string;
    tokenHash: string;
    invitedBy: string;
    message: string | null;
    expiresAt: Date;
  }): Promise<{ id: string; createdAt: Date }> {
    const id = newId();
    const createdAt = new Date();

    await this.db.insert(invitations).values({
      id,
      organizationId: input.organizationId,
      email: input.email,
      roleId: input.roleId,
      tokenHash: input.tokenHash,
      status: 'pending',
      message: input.message,
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
      createdBy: input.invitedBy,
      createdAt,
    });

    return { id, createdAt };
  }

  /** Convite pendente para o mesmo e-mail, se houver. */
  async findPendingInvitation(organizationId: string, email: string) {
    const rows = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, organizationId),
          eq(invitations.email, email),
          eq(invitations.status, 'pending'),
        ),
      )
      .limit(1);

    return rows[0];
  }

  async expireInvitation(invitationId: string): Promise<void> {
    await this.db
      .update(invitations)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(invitations.id, invitationId));
  }

  async findRoleIdBySlug(slug: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.organizationId), eq(roles.slug, slug)))
      .limit(1);

    return rows[0]?.id;
  }
}

/**
 * Condição de keyset: `(created_at, id) < (cursor.at, cursor.id)`.
 *
 * O par completo é necessário porque `created_at` não é único; sem o desempate
 * por `id`, registros criados no mesmo milissegundo apareceriam duas vezes ou
 * sumiriam entre páginas.
 */
function keysetCondition(
  createdAtColumn: Parameters<typeof lt>[0],
  idColumn: Parameters<typeof lt>[0],
  after: CursorPayload | undefined,
) {
  if (after === undefined) {
    return undefined;
  }

  const at = new Date(after.at);

  return or(
    lt(createdAtColumn, at),
    and(eq(createdAtColumn, at), lt(idColumn, after.id)),
  );
}
