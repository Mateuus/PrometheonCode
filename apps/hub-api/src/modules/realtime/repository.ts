/**
 * Acesso ao banco do módulo de tempo real.
 *
 * Só consultas — nenhuma decisão de autorização acontece aqui; quem decide é
 * `service.ts`, com `authorize()` de `@prometheon/permissions`.
 */

import {
  devices,
  deviceTokens,
  organizationMembers,
  organizations,
  outboxMessages,
  projectMembers,
  projects,
  roles,
  users,
  type Database,
} from '@prometheon/database';

export interface RealtimeMembership {
  readonly organizationId: string;
  readonly roleSlug: string;
  readonly status: 'invited' | 'active' | 'suspended';
  readonly policy: Record<string, unknown> | null;
}

export interface RealtimeProject {
  readonly id: string;
  readonly organizationId: string;
  readonly visibility: 'private' | 'organization';
  readonly status: 'active' | 'paused' | 'archived';
}

export interface RealtimeUser {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly avatarUrl: string | null;
}

/** Linha do outbox convertida no envelope que o cliente recebe. */
export interface BacklogRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number | null;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface BacklogQuery {
  readonly organizationIds: readonly string[];
  /** Último cursor confirmado pelo cliente; a retomada é estritamente depois dele. */
  readonly afterCursor: string;
  /** Menor identificador dentro da janela (ver `ulidFloor`). */
  readonly sinceId: string;
  /** Teto de eventos; ler `limit + 1` denuncia janela estourada. */
  readonly limit: number;
}

export class RealtimeRepository {
  constructor(private readonly db: Database) {}

  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<RealtimeMembership | undefined> {
    const rows = await this.db.manager
      .createQueryBuilder(organizationMembers, 'member')
      .select('organization.id', 'organizationId')
      .addSelect('role.slug', 'roleSlug')
      .addSelect('member.status', 'status')
      .addSelect('organization.policy', 'policy')
      .innerJoin(organizations.options.name, 'organization', 'organization.id = member.organizationId')
      .innerJoin(roles.options.name, 'role', 'role.id = member.roleId')
      .where('member.organizationId = :organizationId', { organizationId })
      .andWhere('member.userId = :userId', { userId })
      .andWhere('organization.deleted_at IS NULL')
      .limit(1)
      .getRawMany<RealtimeMembership>();

    return rows[0];
  }

  async findProject(projectId: string): Promise<RealtimeProject | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(projects, 'project')
      .select(['project.id', 'project.organizationId', 'project.visibility', 'project.status'])
      .where('project.id = :projectId', { projectId })
      .andWhere('project.deletedAt IS NULL')
      .getOne();

    return row ?? undefined;
  }

  /** `true` quando existe associação ativa da pessoa com o projeto. */
  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    const found = await this.db.manager
      .createQueryBuilder(projectMembers, 'member')
      .select('member.id')
      .where('member.projectId = :projectId', { projectId })
      .andWhere('member.userId = :userId', { userId })
      .andWhere("member.status = 'active'")
      .getOne();

    return found !== null;
  }

  /**
   * `true` quando o dispositivo continua servindo de credencial.
   *
   * Um token de realtime emitido para um dispositivo não pode sobreviver à
   * revogação dele (`Docs/09`); a conexão reconfere isto a cada revalidação.
   */
  async isDeviceUsable(deviceId: string): Promise<boolean> {
    const device = await this.db.manager
      .createQueryBuilder(devices, 'device')
      .select('device.status')
      .where('device.id = :deviceId', { deviceId })
      .getOne();

    if (device?.status !== 'active') {
      return false;
    }

    // Dispositivo ativo mas com todas as credenciais revogadas não vale mais:
    // a revogação acontece no token, não no dispositivo.
    const credential = await this.db.manager
      .createQueryBuilder(deviceTokens, 'token')
      .select('token.id')
      .where('token.deviceId = :deviceId', { deviceId })
      .andWhere("token.type = 'device_credential'")
      .andWhere('token.revokedAt IS NULL')
      .getOne();

    return credential !== null;
  }

  /**
   * Projetos da organização que esta pessoa pode ver.
   *
   * Existe por causa da inscrição de **organização inteira**: ela recebe tudo
   * que acontece na organização, e "tudo" incluiria os eventos de um projeto
   * privado de que a pessoa não participa. Conferir projeto a projeto no momento
   * da entrega significaria uma consulta por evento; conferir uma vez e guardar
   * o conjunto resolve com uma consulta por revalidação.
   *
   * O conjunto é de **permitidos**, não de negados, de propósito: um projeto
   * criado depois desta leitura fica de fora até a próxima revalidação. Atrasar
   * um evento por trinta segundos é aceitável; entregar por trinta segundos o
   * evento de um projeto privado não é.
   */
  async listAccessibleProjects(organizationId: string, userId: string): Promise<string[]> {
    const rows = await this.db.manager
      .createQueryBuilder(projects, 'project')
      .select('project.id', 'id')
      .leftJoin(
        projectMembers.options.name,
        'member',
        "member.project_id = project.id AND member.user_id = :userId AND member.status = 'active'",
        { userId },
      )
      .where('project.organizationId = :organizationId', { organizationId })
      .andWhere('project.deletedAt IS NULL')
      .andWhere("(project.visibility = 'organization' OR member.id IS NOT NULL)")
      .getRawMany<{ id: string }>();

    return rows.map((row) => row.id);
  }

  async findUser(userId: string): Promise<RealtimeUser | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(users, 'user')
      .select(['user.id', 'user.displayName', 'user.email', 'user.avatarUrl'])
      .where('user.id = :userId', { userId })
      .andWhere('user.deletedAt IS NULL')
      .getOne();

    return row ?? undefined;
  }

  /** Pessoas de um lote de identificadores, para montar a presença. */
  async findUsers(userIds: readonly string[]): Promise<RealtimeUser[]> {
    if (userIds.length === 0) {
      return [];
    }

    return this.db.manager
      .createQueryBuilder(users, 'user')
      .select(['user.id', 'user.displayName', 'user.email', 'user.avatarUrl'])
      .where('user.id IN (:...userIds)', { userIds: [...userIds] })
      .getMany();
  }

  /**
   * Eventos publicados depois de um cursor, dentro da janela de retomada.
   *
   * A fonte é o próprio outbox, e não um buffer paralelo no Redis, por três
   * motivos: é a fonte da verdade, o `id` já é o cursor (ULID ordena por tempo)
   * e não existe estado novo para manter sincronizado entre instâncias.
   *
   * **A janela é recortada por identificador, não por data.** `id >= sinceId`
   * parece redundante diante de `id > afterCursor`, e não é: ele é o piso da
   * janela, o que impede um cursor forjado com um instante antigo de arrastar a
   * varredura pela partição inteira da organização. Usar o `id` em vez de
   * `created_at` também evita depender do fuso do servidor MySQL, que é quem
   * preenche aquela coluna (`DEFAULT CURRENT_TIMESTAMP(3)`).
   */
  async fetchBacklog(query: BacklogQuery): Promise<BacklogRecord[]> {
    if (query.organizationIds.length === 0) {
      return [];
    }

    const rows = await this.db.manager
      .createQueryBuilder(outboxMessages, 'outbox')
      .select([
        'outbox.id',
        'outbox.organizationId',
        'outbox.projectId',
        'outbox.aggregateType',
        'outbox.aggregateId',
        'outbox.aggregateSequence',
        'outbox.eventType',
        'outbox.eventVersion',
        'outbox.payload',
        'outbox.occurredAt',
      ])
      .where('outbox.organizationId IN (:...organizationIds)', {
        organizationIds: [...query.organizationIds],
      })
      .andWhere('outbox.id >= :sinceId', { sinceId: query.sinceId })
      .andWhere('outbox.id > :afterCursor', { afterCursor: query.afterCursor })
      // Só o que o worker já publicou: entregar um evento ainda não publicado
      // furaria a ordem que o publicador garante por agregado.
      .andWhere('outbox.publishedAt IS NOT NULL')
      .orderBy('outbox.id', 'ASC')
      .limit(query.limit)
      .getMany();

    return rows;
  }
}
