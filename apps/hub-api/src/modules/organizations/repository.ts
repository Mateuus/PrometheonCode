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
  type Invitation,
  type OrganizationMember,
} from '@prometheon/database';
import type { SelectQueryBuilder } from 'typeorm';

import { decodeCursor } from '../../shared/cursor.js';
import { affectedRows, applyKeyset } from '../../shared/query.js';

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

    const query = this.db.manager
      .createQueryBuilder(organizationMembers, 'membership')
      .select('organization.id', 'id')
      .addSelect('organization.name', 'name')
      .addSelect('organization.slug', 'slug')
      .addSelect('plan.code', 'planCode')
      .addSelect('organization.createdAt', 'createdAt')
      .addSelect('organization.updatedAt', 'updatedAt')
      .addSelect('organization.createdBy', 'createdBy')
      .addSelect('organization.version', 'version')
      .addSelect('role.slug', 'roleSlug')
      .innerJoin(
        organizations.options.name,
        'organization',
        'organization.id = membership.organizationId',
      )
      .innerJoin(plans.options.name, 'plan', 'plan.id = organization.planId')
      .innerJoin(roles.options.name, 'role', 'role.id = membership.roleId')
      .where('membership.userId = :userId', { userId })
      .andWhere('organization.deletedAt IS NULL');

    applyKeyset(query, 'organization', { createdAt: 'createdAt', id: 'id' }, after);

    return query
      .orderBy('organization.createdAt', 'DESC')
      .addOrderBy('organization.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<OrganizationRow>();
  }

  async findById(organizationId: string): Promise<OrganizationRow | undefined> {
    const rows = await this.db.manager
      .createQueryBuilder(organizations, 'organization')
      .select('organization.id', 'id')
      .addSelect('organization.name', 'name')
      .addSelect('organization.slug', 'slug')
      .addSelect('plan.code', 'planCode')
      .addSelect('organization.createdAt', 'createdAt')
      .addSelect('organization.updatedAt', 'updatedAt')
      .addSelect('organization.createdBy', 'createdBy')
      .addSelect('organization.version', 'version')
      // A leitura por ID não passa por `organization_members`, então não há
      // papel a informar; a coluna existe só para o tipo da linha fechar, e
      // quem chama substitui pelo papel que já resolveu no guarda da rota.
      .addSelect("''", 'roleSlug')
      .innerJoin(plans.options.name, 'plan', 'plan.id = organization.planId')
      .where('organization.id = :organizationId', { organizationId })
      .andWhere('organization.deletedAt IS NULL')
      .limit(1)
      .getRawMany<OrganizationRow>();

    return rows[0];
  }

  async listMembers(
    organizationId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<MemberRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const query = this.memberQuery().where('member.organizationId = :organizationId', {
      organizationId,
    });

    applyKeyset(query, 'member', { createdAt: 'createdAt', id: 'id' }, after);

    return query
      .orderBy('member.createdAt', 'DESC')
      .addOrderBy('member.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<MemberRow>();
  }

  async findMemberById(memberId: string): Promise<MemberRow | undefined> {
    const rows = await this.memberQuery()
      .where('member.id = :memberId', { memberId })
      .limit(1)
      .getRawMany<MemberRow>();

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
    const result = await this.db.manager
      .createQueryBuilder()
      .update(organizationMembers)
      .set({
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        version: () => 'version + 1',
        updatedAt: new Date(),
      })
      .where('id = :memberId', { memberId: input.memberId })
      .andWhere('version = :version', { version: input.version })
      .execute();

    return affectedRows(result) > 0;
  }

  async countOwners(organizationId: string): Promise<number> {
    // Contagem no banco: o número decide se o último dono pode ser rebaixado,
    // e trazer as linhas para contar em memória só aumentaria a janela.
    const row = await this.db.manager
      .createQueryBuilder(organizationMembers, 'member')
      .select('count(*)', 'value')
      .innerJoin(roles.options.name, 'role', 'role.id = member.roleId')
      .where('member.organizationId = :organizationId', { organizationId })
      .andWhere("role.slug = 'owner'")
      .andWhere("member.status = 'active'")
      .getRawOne<{ value: number | string }>();

    return Number(row?.value ?? 0);
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
    return this.memberQuery()
      .where('member.organizationId = :organizationId', { organizationId })
      .andWhere('member.userId = :userId', { userId })
      .limit(1)
      .getRawMany<MemberRow>();
  }

  /**
   * Base das leituras de membro: vínculo + pessoa + papel.
   *
   * É `getRawMany` porque o resultado mistura colunas de três tabelas — o
   * contrato do membro carrega o slug do papel e o nome, o e-mail e o avatar de
   * quem foi convidado, e uma entidade hidratada não comportaria isso sem
   * declarar relações que o schema não tem.
   */
  private memberQuery(): SelectQueryBuilder<OrganizationMember> {
    return this.db.manager
      .createQueryBuilder(organizationMembers, 'member')
      .select('member.id', 'id')
      .addSelect('member.organizationId', 'organizationId')
      .addSelect('role.slug', 'roleSlug')
      .addSelect('member.status', 'status')
      .addSelect('member.invitedBy', 'invitedBy')
      .addSelect('member.joinedAt', 'joinedAt')
      .addSelect('member.createdAt', 'createdAt')
      .addSelect('member.updatedAt', 'updatedAt')
      .addSelect('member.version', 'version')
      .addSelect('account.id', 'userId')
      .addSelect('account.displayName', 'userName')
      .addSelect('account.email', 'userEmail')
      .addSelect('account.avatarUrl', 'userAvatarUrl')
      .innerJoin(users.options.name, 'account', 'account.id = member.userId')
      .innerJoin(roles.options.name, 'role', 'role.id = member.roleId');
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

    await this.db.manager.insert(invitations, {
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
  async findPendingInvitation(
    organizationId: string,
    email: string,
  ): Promise<Invitation | undefined> {
    const row = await this.db.manager.findOne(invitations, {
      where: { organizationId, email, status: 'pending' },
    });

    return row ?? undefined;
  }

  async expireInvitation(invitationId: string): Promise<void> {
    await this.db.manager.update(
      invitations,
      { id: invitationId },
      { status: 'expired', updatedAt: new Date() },
    );
  }

  async findRoleIdBySlug(slug: string): Promise<string | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(roles, 'role')
      .select('role.id')
      .where('role.organizationId IS NULL')
      .andWhere('role.slug = :slug', { slug })
      .getOne();

    return row?.id;
  }
}
