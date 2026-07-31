/**
 * Regras de organização, membros e convites.
 *
 * O que este módulo entrega nesta rodada é o mínimo para o RBAC ter o que
 * proteger: listar, criar, ver, listar membros, convidar e mudar papel. Projetos,
 * conversas e o resto do `Docs/06` vêm depois.
 */

import type { Database } from '@prometheon/database';
import { outranks, permissionsOf, type Permission, type Role } from '@prometheon/permissions';

import { AUTH_SETTINGS, type AppConfig } from '../../config/index.js';
import { hashToken, randomToken } from '../../shared/crypto.js';
import { buildPage, type CursorPage } from '../../shared/cursor.js';
import type { OutboxExecutor } from '../../shared/events.js';
import { addSeconds, toIso, toIsoOrNull } from '../../shared/time.js';
import {
  invitationAlreadyAccepted,
  invitationEmailMismatch,
  invitationExpired,
  invitationInvalid,
  invitationRevoked,
} from '../auth/errors.js';
import { createOrganizationFor } from '../auth/repository.js';
import type { AuthService } from '../auth/service.js';
import {
  cannotOutrankSelf,
  invitationAlreadyPending,
  lastOwnerCannotBeRemoved,
  memberAlreadyExists,
  memberNotFound,
  organizationNotFound,
  slugAlreadyTaken,
  slugConfirmationMismatch,
  versionConflict,
} from './errors.js';
import { OrganizationRepository, type MemberRow, type OrganizationRow } from './repository.js';

export interface OrganizationServiceDeps {
  readonly db: Database;
  readonly config: AppConfig;
  readonly authService: AuthService;
}

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  description: null;
  avatarUrl: null;
  planCode: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  version: number;
}

export class OrganizationService {
  private readonly repository: OrganizationRepository;

  constructor(private readonly deps: OrganizationServiceDeps) {
    this.repository = new OrganizationRepository(deps.db);
  }

  async list(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<CursorPage<OrganizationView & { role: Role; permissions: Permission[] }>> {
    const rows = await this.repository.listForUser(userId, limit, cursor);
    const page = buildPage(rows, limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return {
      items: page.items.map((row) => ({
        ...toOrganizationView(row),
        role: row.roleSlug as Role,
        // O que a interface desenha; a decisão continua sendo do servidor.
        permissions: [...permissionsOf(row.roleSlug as Role)],
      })),
      pageInfo: page.pageInfo,
    };
  }

  async create(userId: string, name: string): Promise<OrganizationView> {
    const organizationId = await createOrganizationFor(this.deps.db, userId, name);
    const row = await this.repository.findById(organizationId);

    if (row === undefined) {
      throw organizationNotFound();
    }

    return toOrganizationView(row);
  }

  async get(
    organizationId: string,
    role: Role,
  ): Promise<OrganizationView & { role: Role; permissions: Permission[] }> {
    const row = await this.repository.findById(organizationId);

    if (row === undefined) {
      throw organizationNotFound();
    }

    return { ...toOrganizationView(row), role, permissions: [...permissionsOf(role)] };
  }

  /**
   * Renomeia a organização e, se pedido, troca o endereço dela.
   *
   * O slug é o que aparece em `/app/<slug>`: trocá-lo quebra o link que as
   * pessoas têm salvo, e por isso ele só muda quando vem explicitamente no
   * corpo. O conflito é verificado antes de escrever, para a resposta dizer
   * "este endereço já é de outra organização" em vez de devolver um erro de
   * chave duplicada do banco.
   */
  async update(input: {
    organizationId: string;
    version: number;
    name?: string | undefined;
    slug?: string | undefined;
    role: Role;
  }): Promise<OrganizationView & { role: Role; permissions: Permission[] }> {
    const current = await this.repository.findById(input.organizationId);

    if (current === undefined) {
      throw organizationNotFound();
    }

    if (input.slug !== undefined && input.slug !== current.slug) {
      if (await this.repository.slugTaken(input.slug, input.organizationId)) {
        throw slugAlreadyTaken(input.slug);
      }
    }

    const updated = await this.repository.updateOrganization({
      organizationId: input.organizationId,
      version: input.version,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
    });

    if (!updated) {
      throw versionConflict();
    }

    return this.get(input.organizationId, input.role);
  }

  /**
   * Exclui a organização.
   *
   * Exige o slug digitado de novo e a versão lida: é a última porta antes de
   * uma ação que leva junto projetos, conversas e o conhecimento da equipe. A
   * exclusão é lógica — o worker de retenção apaga de vez depois da janela, e
   * até lá o estrago é reversível.
   */
  async remove(input: {
    organizationId: string;
    version: number;
    slug: string;
  }): Promise<{ id: string; slug: string; name: string }> {
    const current = await this.repository.findById(input.organizationId);

    if (current === undefined) {
      throw organizationNotFound();
    }

    if (current.slug !== input.slug) {
      throw slugConfirmationMismatch();
    }

    const removed = await this.repository.softDeleteOrganization({
      organizationId: input.organizationId,
      version: input.version,
      slug: current.slug,
    });

    if (!removed) {
      throw versionConflict();
    }

    return { id: current.id, slug: current.slug, name: current.name };
  }

  async listMembers(
    organizationId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<CursorPage<ReturnType<typeof toMemberView>>> {
    const rows = await this.repository.listMembers(organizationId, limit, cursor);
    const page = buildPage(rows, limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return { items: page.items.map(toMemberView), pageInfo: page.pageInfo };
  }

  /**
   * Convida alguém para a organização.
   *
   * O convite guarda apenas o hash do token; o valor puro existe uma vez, no
   * link do e-mail. Convidar para um papel igual ou acima do próprio é negado —
   * caso contrário `members.invite` viraria uma escada para virar dono.
   */
  async invite(input: {
    organizationId: string;
    organizationName: string;
    actorId: string;
    actorName: string;
    actorRole: Role;
    email: string;
    role: Role;
    message: string | null;
  }): Promise<{ id: string; expiresAt: Date; createdAt: Date }> {
    if (!outranks(input.actorRole, input.role)) {
      throw cannotOutrankSelf();
    }

    const existingMember = await this.repository.findMemberByUser(
      input.organizationId,
      input.actorId,
    );

    if (existingMember?.userEmail === input.email) {
      throw memberAlreadyExists();
    }

    const pending = await this.repository.findPendingInvitation(
      input.organizationId,
      input.email,
    );

    if (pending !== undefined) {
      if (pending.expiresAt.getTime() > Date.now()) {
        throw invitationAlreadyPending();
      }

      // Convite vencido não bloqueia um novo; ele é marcado como expirado para
      // liberar o índice único de "um convite pendente por e-mail".
      await this.repository.expireInvitation(pending.id);
    }

    const roleId = await this.repository.findRoleIdBySlug(input.role);

    if (roleId === undefined) {
      throw organizationNotFound();
    }

    const token = randomToken();
    const expiresAt = addSeconds(new Date(), AUTH_SETTINGS.invitationTtlSeconds);
    const created = await this.repository.createInvitation({
      organizationId: input.organizationId,
      email: input.email,
      roleId,
      tokenHash: hashToken(token),
      invitedBy: input.actorId,
      message: input.message,
      expiresAt,
    });

    this.deps.authService.sendInvitationEmail({
      email: input.email,
      organizationName: input.organizationName,
      inviterName: input.actorName,
      role: input.role,
      token,
    });

    return { id: created.id, expiresAt, createdAt: created.createdAt };
  }

  /**
   * Aceita um convite com uma conta que já existe.
   *
   * O caminho de cadastro (`POST /v1/auth/register` com `invitationToken`) cobre
   * quem ainda não tem conta. Este cobre quem já tem — sem ele, participar de
   * uma segunda organização só era possível criando um segundo cadastro.
   *
   * Três decisões de segurança, todas verificadas no servidor:
   *
   * 1. **O endereço tem que bater.** Ver `invitationEmailMismatch()` para o
   *    raciocínio completo. Em resumo: o convite autoriza uma pessoa, não quem
   *    estiver com o link na mão.
   * 2. **O endereço tem que estar confirmado.** Sem isso, bastaria cadastrar-se
   *    com o e-mail de outra pessoa — que ninguém precisa provar que é seu no
   *    cadastro — e usar o convite dela. É a confirmação que transforma "digitei
   *    este endereço" em "recebo o que é enviado para ele".
   * 3. **Cada desfecho tem um código próprio.** Vencido, cancelado e já usado
   *    pedem ações diferentes de quem recebeu o link; um erro genérico deixaria
   *    a pessoa sem saber se insiste, se pede outro convite ou se já entrou.
   */
  async acceptInvitation(input: {
    token: string;
    userId: string;
    userEmail: string;
    onAccepted: (
      tx: OutboxExecutor,
      accepted: { memberId: string; organizationId: string; roleSlug: string; invitationId: string },
    ) => Promise<void>;
  }): Promise<{
    organization: OrganizationView & { role: Role; permissions: Permission[] };
    member: ReturnType<typeof toMemberView>;
    /** Falso quando a associação já existia; a rota usa isso na auditoria. */
    created: boolean;
  }> {
    const outcome = await this.repository.acceptInvitation({
      tokenHash: hashToken(input.token),
      userId: input.userId,
      expectedEmail: input.userEmail,
      onCommitted: input.onAccepted,
    });

    switch (outcome.kind) {
      case 'accepted':
        return { ...(await this.describeMembership(outcome.memberId)), created: true };

      case 'already-member':
        // Repetir a chamada com o mesmo token não é erro: o estado desejado já
        // vale. Devolver o vínculo é mais útil que um conflito, e o token foi
        // consumido de qualquer modo.
        return { ...(await this.describeMembership(outcome.memberId)), created: false };

      case 'already-accepted': {
        // Quem perdeu a corrida entre duas aceitações **da mesma pessoa** vê o
        // resultado que pediu, não um 500 nem um conflito enigmático.
        if (outcome.acceptedByUserId === input.userId) {
          const member = await this.repository.findMemberByUser(
            outcome.organizationId,
            input.userId,
          );

          if (member !== undefined) {
            return { ...(await this.describeMembership(member.id)), created: false };
          }
        }

        throw invitationAlreadyAccepted();
      }

      case 'membership-not-active':
        // Vínculo suspenso não é reativado por convite: suspender é decisão da
        // organização, e desfazê-la exige `organization.manage`.
        throw memberAlreadyExists();

      case 'expired':
        throw invitationExpired();

      case 'revoked':
        throw invitationRevoked();

      case 'email-mismatch':
        throw invitationEmailMismatch();

      case 'not-found':
      default:
        throw invitationInvalid();
    }
  }

  /** Monta a resposta da aceitação a partir do vínculo recém-resolvido. */
  private async describeMembership(memberId: string): Promise<{
    organization: OrganizationView & { role: Role; permissions: Permission[] };
    member: ReturnType<typeof toMemberView>;
  }> {
    const member = await this.repository.findMemberById(memberId);

    if (member === undefined) {
      throw memberNotFound();
    }

    const organization = await this.repository.findById(member.organizationId);

    if (organization === undefined) {
      throw organizationNotFound();
    }

    const role = member.roleSlug as Role;

    return {
      organization: {
        ...toOrganizationView(organization),
        role,
        permissions: [...permissionsOf(role)],
      },
      member: toMemberView(member),
    };
  }

  /** Muda papel ou situação de um membro, com concorrência otimista. */
  async updateMember(input: {
    organizationId: string;
    memberId: string;
    actorRole: Role;
    version: number;
    role?: Role | undefined;
    status?: 'invited' | 'active' | 'suspended' | undefined;
  }): Promise<ReturnType<typeof toMemberView>> {
    const member = await this.repository.findMemberById(input.memberId);

    if (member?.organizationId !== input.organizationId) {
      throw memberNotFound();
    }

    // Só se administra quem está estritamente abaixo — a mesma regra que
    // `outranks()` aplica no pacote de permissões.
    if (!outranks(input.actorRole, member.roleSlug as Role)) {
      throw cannotOutrankSelf();
    }

    if (input.role !== undefined && !outranks(input.actorRole, input.role)) {
      throw cannotOutrankSelf();
    }

    const losingOwner =
      member.roleSlug === 'owner' &&
      ((input.role !== undefined && input.role !== 'owner') ||
        (input.status !== undefined && input.status !== 'active'));

    if (losingOwner && (await this.repository.countOwners(input.organizationId)) <= 1) {
      throw lastOwnerCannotBeRemoved();
    }

    const roleId =
      input.role === undefined ? undefined : await this.repository.findRoleIdBySlug(input.role);

    const updated = await this.repository.updateMember({
      memberId: input.memberId,
      version: input.version,
      ...(roleId === undefined ? {} : { roleId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });

    if (!updated) {
      throw versionConflict();
    }

    const refreshed = await this.repository.findMemberById(input.memberId);

    if (refreshed === undefined) {
      throw memberNotFound();
    }

    return toMemberView(refreshed);
  }
}

export function toOrganizationView(row: OrganizationRow): OrganizationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: null,
    avatarUrl: null,
    planCode: row.planCode,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    // `created_by` é nulo em organizações criadas pelo seed; o contrato pede
    // um ULID, e o dono é a resposta mais próxima da verdade.
    createdBy: row.createdBy ?? row.id,
    version: row.version,
  };
}

export function toMemberView(row: MemberRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    user: {
      id: row.userId,
      name: row.userName,
      email: row.userEmail,
      avatarUrl: row.userAvatarUrl,
    },
    role: row.roleSlug as Role,
    status: row.status,
    invitedBy: row.invitedBy,
    joinedAt: toIsoOrNull(row.joinedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    version: row.version,
  };
}
