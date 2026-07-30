/**
 * Acesso ao banco do módulo de tempo real.
 *
 * Só consultas, todas por Drizzle — nenhuma decisão de autorização acontece
 * aqui; quem decide é `service.ts`, com `authorize()` de `@prometheon/permissions`.
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
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';

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
    const rows = await this.db
      .select({
        organizationId: organizations.id,
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

  async findProject(projectId: string): Promise<RealtimeProject | undefined> {
    const rows = await this.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        visibility: projects.visibility,
        status: projects.status,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);

    return rows[0];
  }

  /** `true` quando existe associação ativa da pessoa com o projeto. */
  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.status, 'active'),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  /**
   * `true` quando o dispositivo continua servindo de credencial.
   *
   * Um token de realtime emitido para um dispositivo não pode sobreviver à
   * revogação dele (`Docs/09`); a conexão reconfere isto a cada revalidação.
   */
  async isDeviceUsable(deviceId: string): Promise<boolean> {
    const rows = await this.db
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    const status = rows[0]?.status;

    if (status !== 'active') {
      return false;
    }

    // Dispositivo ativo mas com todas as credenciais revogadas não vale mais:
    // a revogação acontece no token, não no dispositivo.
    const credentials = await this.db
      .select({ id: deviceTokens.id })
      .from(deviceTokens)
      .where(
        and(
          eq(deviceTokens.deviceId, deviceId),
          eq(deviceTokens.type, 'device_credential'),
          isNull(deviceTokens.revokedAt),
        ),
      )
      .limit(1);

    return credentials.length > 0;
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
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId),
          eq(projectMembers.status, 'active'),
        ),
      )
      .where(
        and(
          eq(projects.organizationId, organizationId),
          isNull(projects.deletedAt),
          or(eq(projects.visibility, 'organization'), isNotNull(projectMembers.id)),
        ),
      );

    return rows.map((row) => row.id);
  }

  async findUser(userId: string): Promise<RealtimeUser | undefined> {
    const rows = await this.db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    return rows[0];
  }

  /** Pessoas de um lote de identificadores, para montar a presença. */
  async findUsers(userIds: readonly string[]): Promise<RealtimeUser[]> {
    if (userIds.length === 0) {
      return [];
    }

    return this.db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, [...userIds]));
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

    return this.db
      .select({
        id: outboxMessages.id,
        organizationId: outboxMessages.organizationId,
        projectId: outboxMessages.projectId,
        aggregateType: outboxMessages.aggregateType,
        aggregateId: outboxMessages.aggregateId,
        aggregateSequence: outboxMessages.aggregateSequence,
        eventType: outboxMessages.eventType,
        eventVersion: outboxMessages.eventVersion,
        payload: outboxMessages.payload,
        occurredAt: outboxMessages.occurredAt,
      })
      .from(outboxMessages)
      .where(
        and(
          inArray(outboxMessages.organizationId, [...query.organizationIds]),
          gte(outboxMessages.id, query.sinceId),
          gt(outboxMessages.id, query.afterCursor),
          // Só o que o worker já publicou: entregar um evento ainda não
          // publicado furaria a ordem que o publicador garante por agregado.
          isNotNull(outboxMessages.publishedAt),
        ),
      )
      .orderBy(asc(outboxMessages.id))
      .limit(query.limit);
  }
}
