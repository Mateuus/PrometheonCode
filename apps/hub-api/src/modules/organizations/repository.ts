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
  runInTransaction,
  users,
  type Database,
  type Invitation,
  type MembershipStatus,
  type OrganizationMember,
  type TransactionExecutor,
} from '@prometheon/database';
import type { SelectQueryBuilder } from 'typeorm';

import { decodeCursor } from '../../shared/cursor.js';
import { affectedRows, applyKeyset } from '../../shared/query.js';

/**
 * Desfecho de `acceptInvitation()`.
 *
 * Cada variante é um caso que o usuário precisa distinguir — "expirado",
 * "cancelado" e "já usado" pedem ações diferentes de quem recebeu o link, e
 * juntá-los num erro genérico deixaria a pessoa sem saber o que fazer.
 */
export type AcceptInvitationOutcome =
  | { readonly kind: 'accepted'; readonly memberId: string }
  /** O convite era para esta conta, que já é membro ativo. Idempotente. */
  | { readonly kind: 'already-member'; readonly memberId: string }
  /** Existe vínculo, mas suspenso ou apenas convidado. */
  | { readonly kind: 'membership-not-active'; readonly status: MembershipStatus }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'revoked' }
  | {
      readonly kind: 'already-accepted';
      readonly acceptedByUserId: string | null;
      readonly organizationId: string;
    }
  | { readonly kind: 'email-mismatch' };

/**
 * Compara endereços de e-mail para efeito de autorização.
 *
 * Só a caixa das letras é normalizada. Nada de remover pontos ou o sufixo
 * `+etiqueta`: são convenções de alguns provedores, não regra do protocolo, e
 * aplicá-las faria `a.b@dominio.com` e `ab@dominio.com` valerem um pelo outro em
 * servidores onde são caixas diferentes — exatamente o tipo de equivalência
 * inventada que vira escalada de privilégio.
 */
function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

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

  /** Verdadeiro quando o slug já pertence a outra organização viva. */
  async slugTaken(slug: string, exceptOrganizationId: string): Promise<boolean> {
    const count = await this.db.manager
      .createQueryBuilder(organizations, 'organization')
      .where('organization.slug = :slug', { slug })
      .andWhere('organization.id <> :exceptOrganizationId', { exceptOrganizationId })
      .getCount();

    return count > 0;
  }

  /**
   * Renomeia a organização, com concorrência otimista.
   *
   * Devolve `false` quando a versão não confere — o mesmo contrato de
   * `updateMember`, para quem chama traduzir em `VERSION_CONFLICT` em vez de
   * sobrescrever a edição de outra pessoa.
   */
  async updateOrganization(input: {
    organizationId: string;
    version: number;
    name?: string | undefined;
    slug?: string | undefined;
  }): Promise<boolean> {
    const changes: { name?: string; slug?: string } = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
    };

    if (Object.keys(changes).length === 0) {
      return true;
    }

    const result = await this.db.manager
      .createQueryBuilder()
      .update(organizations)
      .set({ ...changes, version: () => 'version + 1', updatedAt: new Date() })
      .where('id = :organizationId', { organizationId: input.organizationId })
      .andWhere('version = :version', { version: input.version })
      .andWhere('deleted_at IS NULL')
      .execute();

    return affectedRows(result) > 0;
  }

  /**
   * Marca a organização como excluída.
   *
   * Exclusão lógica, e a situação vai junto: `deleted_at` tira a organização de
   * todas as listagens, e `pending_deletion` é o que o worker de retenção
   * enxerga para apagar de vez depois da janela. Apagar a linha aqui levaria
   * junto conversas, projetos e a auditoria que explica o que aconteceu.
   *
   * O slug é liberado no mesmo movimento: ele é único na tabela inteira, e uma
   * organização apagada não pode segurar um endereço para sempre. O valor
   * antigo continua legível no sufixo.
   */
  async softDeleteOrganization(input: {
    organizationId: string;
    version: number;
    slug: string;
  }): Promise<boolean> {
    const now = new Date();
    const result = await this.db.manager
      .createQueryBuilder()
      .update(organizations)
      .set({
        deletedAt: now,
        status: 'pending_deletion',
        slug: `${input.slug.slice(0, 40)}-deleted-${now.getTime().toString(36)}`,
        version: () => 'version + 1',
        updatedAt: now,
      })
      .where('id = :organizationId', { organizationId: input.organizationId })
      .andWhere('version = :version', { version: input.version })
      .andWhere('deleted_at IS NULL')
      .execute();

    return affectedRows(result) > 0;
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

  /**
   * Aceita um convite, ligando uma conta **já existente** à organização.
   *
   * Tudo acontece numa transação só, aberta com `SELECT … FOR UPDATE` sobre a
   * linha do convite. O lock não é zelo excessivo: sem ele, duas requisições
   * simultâneas com o mesmo token leem `pending` ao mesmo tempo, e uma das duas
   * só descobre o problema ao bater no índice único de `organization_members` —
   * o que chega ao usuário como erro do servidor. Com o lock, a segunda
   * transação espera o commit da primeira e enxerga o estado final: convite
   * aceito e associação já criada. A resposta que ela devolve é uma decisão de
   * produto, não o resto de uma corrida perdida.
   *
   * `expectedEmail` entra aqui porque a comparação precisa acontecer sob o mesmo
   * lock que o resto; **a regra** de que endereço divergente é recusado está no
   * serviço, junto do porquê.
   */
  async acceptInvitation(input: {
    tokenHash: string;
    userId: string;
    expectedEmail: string;
    onCommitted: (
      tx: TransactionExecutor,
      accepted: { memberId: string; organizationId: string; roleSlug: string; invitationId: string },
    ) => Promise<void>;
  }): Promise<AcceptInvitationOutcome> {
    return runInTransaction(this.db, async (tx) => {
      const invitation = await tx
        .createQueryBuilder(invitations, 'invitation')
        .setLock('pessimistic_write')
        .where('invitation.tokenHash = :tokenHash', { tokenHash: input.tokenHash })
        .getOne();

      if (invitation === null) {
        return { kind: 'not-found' } as const;
      }

      if (invitation.status === 'revoked') {
        return { kind: 'revoked' } as const;
      }

      if (invitation.status === 'expired') {
        return { kind: 'expired' } as const;
      }

      if (invitation.status === 'accepted') {
        return {
          kind: 'already-accepted',
          acceptedByUserId: invitation.acceptedByUserId,
          organizationId: invitation.organizationId,
        } as const;
      }

      // Convite vencido que ninguém marcou ainda: o estado é corrigido agora,
      // o que também libera o índice único de "um convite pendente por e-mail"
      // para um convite novo.
      if (invitation.expiresAt.getTime() <= Date.now()) {
        await tx.update(
          invitations,
          { id: invitation.id },
          { status: 'expired', updatedAt: new Date() },
        );

        return { kind: 'expired' } as const;
      }

      if (!sameEmail(invitation.email, input.expectedEmail)) {
        return { kind: 'email-mismatch' } as const;
      }

      // A associação existente é lida sob lock pelo mesmo motivo do convite: é
      // ela que o `INSERT` abaixo pode colidir.
      const existing = await tx
        .createQueryBuilder(organizationMembers, 'member')
        .setLock('pessimistic_write')
        .where('member.organizationId = :organizationId', {
          organizationId: invitation.organizationId,
        })
        .andWhere('member.userId = :userId', { userId: input.userId })
        .getOne();

      const now = new Date();

      if (existing !== null) {
        // Já é membro ativo: o convite é consumido — o token não pode continuar
        // valendo — e a resposta descreve o vínculo que existe. Reativar um
        // vínculo suspenso, não: suspender alguém é uma decisão da organização,
        // e um convite antigo não pode desfazê-la.
        await tx.update(
          invitations,
          { id: invitation.id },
          {
            status: 'accepted',
            acceptedAt: now,
            acceptedByUserId: input.userId,
            updatedAt: now,
          },
        );

        return existing.status === 'active'
          ? ({ kind: 'already-member', memberId: existing.id } as const)
          : ({ kind: 'membership-not-active', status: existing.status } as const);
      }

      const memberId = newId();

      await tx.update(
        invitations,
        { id: invitation.id },
        {
          status: 'accepted',
          acceptedAt: now,
          acceptedByUserId: input.userId,
          updatedAt: now,
        },
      );

      await tx.insert(organizationMembers, {
        id: memberId,
        organizationId: invitation.organizationId,
        userId: input.userId,
        roleId: invitation.roleId,
        status: 'active',
        invitedBy: invitation.invitedBy,
        joinedAt: now,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      });

      const role = await tx
        .createQueryBuilder(roles, 'role')
        .select('role.slug')
        .where('role.id = :roleId', { roleId: invitation.roleId })
        .getOne();

      // O evento entra na mesma transação da escrita (`Docs/08`): se o commit
      // falhar, a associação e o evento somem juntos.
      await input.onCommitted(tx, {
        memberId,
        organizationId: invitation.organizationId,
        roleSlug: role?.slug ?? '',
        invitationId: invitation.id,
      });

      return { kind: 'accepted', memberId } as const;
    });
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
