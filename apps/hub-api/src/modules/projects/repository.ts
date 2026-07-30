/**
 * Acesso ao banco do módulo de projetos.
 *
 * Listagem por cursor `(created_at, id)`, apoiada em
 * `idx_projects_org_created_at` (`Docs/07`). O par completo é necessário porque
 * `created_at` não é único: sem o desempate por `id`, dois projetos criados no
 * mesmo milissegundo apareceriam duas vezes ou sumiriam entre páginas.
 */

import {
  gitRepositories,
  newId,
  organizations,
  projectMembers,
  projectRepositories,
  projectSettings,
  projects,
  roles,
  users,
  type Database,
} from '@prometheon/database';
import { and, desc, eq, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor, type CursorPayload } from '../../shared/cursor.js';
import type { ProjectMemberRow, ProjectRow, ProjectSettingsRow } from './types.js';

/** Executor: o `Database` ou a transação aberta por quem chama. */
export type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

const projectColumns = {
  id: projects.id,
  organizationId: projects.organizationId,
  slug: projects.slug,
  name: projects.name,
  description: projects.description,
  status: projects.status,
  visibility: projects.visibility,
  tags: projects.tags,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  createdBy: projects.createdBy,
  version: projects.version,
} as const;

const settingsColumns = {
  defaultWorkMode: projectSettings.defaultWorkMode,
  defaultAutonomy: projectSettings.defaultAutonomy,
  contextBudgetTokens: projectSettings.contextBudgetTokens,
  allowRemoteAgents: projectSettings.allowRemoteAgents,
  requireReview: projectSettings.requireReview,
  retentionDays: projectSettings.retentionDays,
  policy: projectSettings.policy,
} as const;

export interface ProjectListFilters {
  readonly status?: 'active' | 'paused' | 'archived' | undefined;
  readonly search?: string | undefined;
  readonly tag?: string | undefined;
}

export interface ProjectRepositoryRow {
  id: string;
  provider: 'github' | 'gitlab' | 'bitbucket' | 'azure_devops';
  remoteUrl: string;
  defaultBranch: string;
  rootPath: string | null;
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  /**
   * Projetos da organização visíveis para o usuário.
   *
   * O `LEFT JOIN` com `project_members` é o que aplica a regra de visibilidade
   * na consulta em vez de filtrar depois de ler: quem não participa do projeto
   * e não é administrador do tenant nunca vê a linha, então não existe página
   * curta nem contagem inflada.
   */
  async listForOrganization(input: {
    organizationId: string;
    userId: string;
    canSeeEveryProject: boolean;
    limit: number;
    cursor: string | undefined;
    filters: ProjectListFilters;
  }): Promise<ProjectRow[]> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const conditions: (SQL | undefined)[] = [
      eq(projects.organizationId, input.organizationId),
      isNull(projects.deletedAt),
      keysetCondition(projects.createdAt, projects.id, after),
    ];

    if (input.filters.status !== undefined) {
      conditions.push(eq(projects.status, input.filters.status));
    }

    if (input.filters.search !== undefined && input.filters.search !== '') {
      conditions.push(like(projects.name, `%${escapeLike(input.filters.search)}%`));
    }

    if (input.filters.tag !== undefined && input.filters.tag !== '') {
      // `JSON_CONTAINS` casa com o elemento inteiro, não com um pedaço dele —
      // `?tag=api` não pode trazer o projeto etiquetado como `api-gateway`.
      conditions.push(
        sql`json_contains(${projects.tags}, ${JSON.stringify(input.filters.tag)})`,
      );
    }

    if (!input.canSeeEveryProject) {
      conditions.push(
        and(eq(projectMembers.userId, input.userId), eq(projectMembers.status, 'active')),
      );
    }

    return this.db
      .select(projectColumns)
      .from(projects)
      .leftJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, input.userId),
          eq(projectMembers.status, 'active'),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt), desc(projects.id))
      .limit(input.limit + 1);
  }

  async findById(projectId: string): Promise<ProjectRow | undefined> {
    const rows = await this.db
      .select(projectColumns)
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);

    return rows[0];
  }

  /** Projeto dono de uma conversa. Usado pelo guarda das rotas de conversa. */
  async findByConversation(conversationId: string): Promise<ProjectRow | undefined> {
    const rows = await this.db.execute<ProjectRow>(sql`
      select p.id, p.organization_id as organizationId, p.slug, p.name, p.description,
             p.status, p.visibility, p.tags, p.created_at as createdAt,
             p.updated_at as updatedAt, p.created_by as createdBy, p.version
        from conversations c
        join projects p on p.id = c.project_id
       where c.id = ${conversationId}
         and c.deleted_at is null
         and p.deleted_at is null
       limit 1
    `);

    return firstRow(rows);
  }

  /** Projeto dono de uma tarefa. */
  async findByTask(taskId: string): Promise<ProjectRow | undefined> {
    const rows = await this.db.execute<ProjectRow>(sql`
      select p.id, p.organization_id as organizationId, p.slug, p.name, p.description,
             p.status, p.visibility, p.tags, p.created_at as createdAt,
             p.updated_at as updatedAt, p.created_by as createdBy, p.version
        from tasks t
        join projects p on p.id = t.project_id
       where t.id = ${taskId}
         and p.deleted_at is null
       limit 1
    `);

    return firstRow(rows);
  }

  /** Política da organização, para reavaliar uma permissão extra na mesma rota. */
  async findOrganizationPolicy(organizationId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .select({ policy: organizations.policy })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    return rows[0]?.policy ?? null;
  }

  async findSettings(projectId: string): Promise<ProjectSettingsRow | undefined> {
    const rows = await this.db
      .select(settingsColumns)
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .limit(1);

    return rows[0];
  }

  /** Configuração de vários projetos de uma vez, para não repetir consulta na listagem. */
  async settingsByProject(projectIds: string[]): Promise<Map<string, ProjectSettingsRow>> {
    if (projectIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({ projectId: projectSettings.projectId, ...settingsColumns })
      .from(projectSettings)
      .where(
        or(...projectIds.map((projectId) => eq(projectSettings.projectId, projectId))),
      );

    return new Map(rows.map(({ projectId, ...settings }) => [projectId, settings]));
  }

  async findMember(projectId: string, userId: string): Promise<ProjectMemberRow | undefined> {
    const rows = await this.db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        userId: projectMembers.userId,
        roleSlug: roles.slug,
        status: projectMembers.status,
        createdAt: projectMembers.createdAt,
        userName: users.displayName,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(roles, eq(roles.id, projectMembers.roleId))
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);

    return rows[0];
  }

  /** Repositórios ligados ao projeto, já no formato do contrato. */
  async listRepositories(projectId: string): Promise<ProjectRepositoryRow[]> {
    const rows = await this.db
      .select({
        id: projectRepositories.id,
        provider: gitRepositories.provider,
        cloneUrl: gitRepositories.cloneUrl,
        htmlUrl: gitRepositories.htmlUrl,
        repositoryBranch: gitRepositories.defaultBranch,
        overrideBranch: projectRepositories.defaultBranch,
        rootPath: projectRepositories.rootPath,
      })
      .from(projectRepositories)
      .innerJoin(gitRepositories, eq(gitRepositories.id, projectRepositories.gitRepositoryId))
      .where(eq(projectRepositories.projectId, projectId))
      .orderBy(desc(projectRepositories.isPrimary), desc(projectRepositories.createdAt));

    return rows.flatMap((row) => {
      const remoteUrl = row.cloneUrl ?? row.htmlUrl;

      // Repositório sem URL utilizável não vira item do contrato: `remoteUrl`
      // é obrigatório lá, e inventar um valor seria pior que omitir a linha.
      if (remoteUrl === null) {
        return [];
      }

      return [
        {
          id: row.id,
          provider: row.provider,
          remoteUrl,
          defaultBranch: row.overrideBranch ?? row.repositoryBranch,
          rootPath: row.rootPath,
        },
      ];
    });
  }

  async slugExists(organizationId: string, slug: string, exceptId?: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(projects.slug, slug),
          isNull(projects.deletedAt),
        ),
      )
      .limit(2);

    return rows.some((row) => row.id !== exceptId);
  }

  /**
   * Cria projeto, configuração e o primeiro membro em uma transação.
   *
   * Os três nascem juntos porque um projeto sem configuração ou sem nenhum
   * membro não é um estado que alguma rota saiba consertar — quem criou ficaria
   * sem acesso ao que acabou de criar.
   */
  async create(input: {
    organizationId: string;
    slug: string;
    name: string;
    description: string | null;
    visibility: 'private' | 'organization';
    tags: string[];
    settings: Omit<ProjectSettingsRow, 'policy'>;
    createdBy: string;
  }): Promise<string> {
    const projectId = newId();
    const createdAt = new Date();

    await this.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: projectId,
        organizationId: input.organizationId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        tags: input.tags,
        createdBy: input.createdBy,
        createdAt,
        updatedAt: createdAt,
      });

      await tx.insert(projectSettings).values({
        id: newId(),
        organizationId: input.organizationId,
        projectId,
        defaultWorkMode: input.settings.defaultWorkMode,
        defaultAutonomy: input.settings.defaultAutonomy,
        contextBudgetTokens: input.settings.contextBudgetTokens,
        allowRemoteAgents: input.settings.allowRemoteAgents,
        requireReview: input.settings.requireReview,
        retentionDays: input.settings.retentionDays,
        createdBy: input.createdBy,
      });

      // `role_id` nulo: quem cria participa do projeto com o papel que já tem
      // na organização. Fixar um papel aqui congelaria a permissão do criador
      // no momento da criação, e uma mudança de papel na organização deixaria
      // de valer dentro do projeto.
      await tx.insert(projectMembers).values({
        id: newId(),
        organizationId: input.organizationId,
        projectId,
        userId: input.createdBy,
        roleId: null,
        status: 'active',
        addedBy: input.createdBy,
        createdBy: input.createdBy,
      });
    });

    return projectId;
  }

  /**
   * Atualiza com concorrência otimista (`Docs/06`).
   *
   * A `version` lida pelo cliente entra no `WHERE`. Se outra escrita passou no
   * meio, nenhuma linha é afetada e quem chamou recebe `VERSION_CONFLICT` em
   * vez de sobrescrever em silêncio a decisão de outra pessoa.
   */
  async update(input: {
    projectId: string;
    version: number;
    fields: Record<string, unknown>;
    settings: Record<string, unknown>;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx
        .update(projects)
        .set({
          ...input.fields,
          ...(input.fields['status'] === 'archived' ? { archivedAt: new Date() } : {}),
          version: sql`${projects.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, input.projectId), eq(projects.version, input.version)));

      if (affectedRows(result) === 0) {
        return false;
      }

      if (Object.keys(input.settings).length > 0) {
        await tx
          .update(projectSettings)
          .set({ ...input.settings, updatedAt: new Date() })
          .where(eq(projectSettings.projectId, input.projectId));
      }

      return true;
    });
  }
}

/** Linhas afetadas por um `UPDATE` do Drizzle no driver do MySQL. */
export function affectedRows(result: unknown): number {
  const header = (result as [{ affectedRows?: number }])[0];

  return header.affectedRows ?? 0;
}

/**
 * Todas as linhas de um `db.execute()` cru.
 *
 * O driver do MySQL devolve `[linhas, campos]`; o Drizzle repassa isso sem
 * tipar, então a conversão acontece uma vez, aqui.
 */
export function allRows<T>(result: unknown): T[] {
  const rows = (result as [T[]])[0];

  return Array.isArray(rows) ? rows : [];
}

/**
 * Primeira linha de um `db.execute()` cru.
 *
 * O parâmetro de tipo existe para quem chama dizer o que espera
 * (`firstRow<ProjectRow>(…)`); não há como inferi-lo de `unknown`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function firstRow<T>(result: unknown): T | undefined {
  return allRows<T>(result)[0];
}

/** Escapa os curingas do `LIKE` para que a busca trate `%` como texto. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Condição de keyset: `(created_at, id) < (cursor.at, cursor.id)`.
 *
 * O par completo é necessário porque `created_at` não é único; sem o desempate
 * por `id`, registros criados no mesmo milissegundo apareceriam duas vezes ou
 * sumiriam entre páginas.
 */
export function keysetCondition(
  createdAtColumn: Parameters<typeof lt>[0],
  idColumn: Parameters<typeof lt>[0],
  after: CursorPayload | undefined,
): SQL | undefined {
  if (after === undefined) {
    return undefined;
  }

  const at = new Date(after.at);

  return or(lt(createdAtColumn, at), and(eq(createdAtColumn, at), lt(idColumn, after.id)));
}
