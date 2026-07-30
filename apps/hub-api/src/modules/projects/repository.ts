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
  runInTransaction,
  users,
  writable,
  type Database,
  type Project,
} from '@prometheon/database';

import { decodeCursor } from '../../shared/cursor.js';
import { affectedRows, applyKeyset, escapeLike } from '../../shared/query.js';
import type { ProjectMemberRow, ProjectRow, ProjectSettingsRow } from './types.js';

/** Colunas que o contrato de projeto expõe. Lista explícita: nada de `SELECT *`. */
const PROJECT_COLUMNS = [
  'id',
  'organizationId',
  'slug',
  'name',
  'description',
  'status',
  'visibility',
  'tags',
  'createdAt',
  'updatedAt',
  'createdBy',
  'version',
] as const;

/** Colunas de `project_settings` que compõem `ProjectSettingsRow`. */
const SETTINGS_COLUMNS = [
  'defaultWorkMode',
  'defaultAutonomy',
  'contextBudgetTokens',
  'allowRemoteAgents',
  'requireReview',
  'retentionDays',
  'policy',
] as const;

/**
 * Colunas do projeto em SQL cru, com o alias que `ProjectRow` espera.
 *
 * As duas leituras que chegam ao projeto por outra tabela (conversa e tarefa)
 * são escritas à mão porque o schema não declara relação entre as entidades —
 * ver `findByConversation()`.
 */
const PROJECT_COLUMNS_SQL = `p.id, p.organization_id as organizationId, p.slug, p.name,
             p.description, p.status, p.visibility, p.tags,
             p.created_at as createdAt, p.updated_at as updatedAt,
             p.created_by as createdBy, p.version`;

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

/** Linha crua do join entre `project_repositories` e `git_repositories`. */
interface RepositoryLinkRow {
  id: string;
  provider: ProjectRepositoryRow['provider'];
  cloneUrl: string | null;
  htmlUrl: string | null;
  repositoryBranch: string;
  overrideBranch: string | null;
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
    const query = this.db.manager
      .createQueryBuilder(projects, 'project')
      .select(PROJECT_COLUMNS.map((column) => `project.${column}`))
      .leftJoin(
        projectMembers.options.name,
        'member',
        `member.projectId = project.id
           and member.userId = :userId
           and member.status = 'active'`,
        { userId: input.userId },
      )
      .where('project.organizationId = :organizationId', {
        organizationId: input.organizationId,
      })
      .andWhere('project.deletedAt IS NULL');

    applyKeyset(query, 'project', { createdAt: 'createdAt', id: 'id' }, after);

    if (input.filters.status !== undefined) {
      query.andWhere('project.status = :status', { status: input.filters.status });
    }

    if (input.filters.search !== undefined && input.filters.search !== '') {
      query.andWhere('project.name LIKE :search', {
        search: `%${escapeLike(input.filters.search)}%`,
      });
    }

    if (input.filters.tag !== undefined && input.filters.tag !== '') {
      // `JSON_CONTAINS` casa com o elemento inteiro, não com um pedaço dele —
      // `?tag=api` não pode trazer o projeto etiquetado como `api-gateway`.
      query.andWhere('json_contains(project.tags, :tag)', {
        tag: JSON.stringify(input.filters.tag),
      });
    }

    if (!input.canSeeEveryProject) {
      // Exigir a linha do `LEFT JOIN` transforma o join em filtro: sem
      // participação ativa, o projeto some da consulta — não da resposta.
      query.andWhere('member.id IS NOT NULL');
    }

    return query
      .orderBy('project.createdAt', 'DESC')
      .addOrderBy('project.id', 'DESC')
      .limit(input.limit + 1)
      .getMany();
  }

  async findById(projectId: string): Promise<ProjectRow | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(projects, 'project')
      .select(PROJECT_COLUMNS.map((column) => `project.${column}`))
      .where('project.id = :projectId', { projectId })
      .andWhere('project.deletedAt IS NULL')
      .getOne();

    return row ?? undefined;
  }

  /**
   * Projeto dono de uma conversa. Usado pelo guarda das rotas de conversa.
   *
   * SQL cru: as entidades não declaram relação entre conversa e projeto (o
   * mapeamento é explícito, sem `relations`), então o join precisa ser escrito.
   */
  async findByConversation(conversationId: string): Promise<ProjectRow | undefined> {
    const rows: ProjectRow[] = await this.db.query(
      `select ${PROJECT_COLUMNS_SQL}
         from conversations c
         join projects p on p.id = c.project_id
        where c.id = ?
          and c.deleted_at is null
          and p.deleted_at is null
        limit 1`,
      [conversationId],
    );

    return rows[0];
  }

  /** Projeto dono de uma tarefa. Mesma razão para o SQL cru de `findByConversation()`. */
  async findByTask(taskId: string): Promise<ProjectRow | undefined> {
    const rows: ProjectRow[] = await this.db.query(
      `select ${PROJECT_COLUMNS_SQL}
         from tasks t
         join projects p on p.id = t.project_id
        where t.id = ?
          and p.deleted_at is null
        limit 1`,
      [taskId],
    );

    return rows[0];
  }

  /** Política da organização, para reavaliar uma permissão extra na mesma rota. */
  async findOrganizationPolicy(organizationId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.manager
      .createQueryBuilder(organizations, 'organization')
      .select('organization.policy')
      .where('organization.id = :organizationId', { organizationId })
      .getOne();

    return row?.policy ?? null;
  }

  async findSettings(projectId: string): Promise<ProjectSettingsRow | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(projectSettings, 'settings')
      .select(SETTINGS_COLUMNS.map((column) => `settings.${column}`))
      .where('settings.projectId = :projectId', { projectId })
      .getOne();

    return row ?? undefined;
  }

  /** Configuração de vários projetos de uma vez, para não repetir consulta na listagem. */
  async settingsByProject(projectIds: string[]): Promise<Map<string, ProjectSettingsRow>> {
    if (projectIds.length === 0) {
      return new Map();
    }

    const rows = await this.db.manager
      .createQueryBuilder(projectSettings, 'settings')
      .select([
        'settings.projectId',
        ...SETTINGS_COLUMNS.map((column) => `settings.${column}`),
      ])
      .where('settings.projectId IN (:...projectIds)', { projectIds })
      .getMany();

    return new Map(rows.map(({ projectId, ...settings }) => [projectId, settings]));
  }

  async findMember(projectId: string, userId: string): Promise<ProjectMemberRow | undefined> {
    // `getRawMany` porque o resultado mistura três tabelas — o contrato do
    // membro carrega o slug do papel e o nome, o e-mail e o avatar da pessoa.
    const rows = await this.db.manager
      .createQueryBuilder(projectMembers, 'member')
      .select('member.id', 'id')
      .addSelect('member.projectId', 'projectId')
      .addSelect('member.userId', 'userId')
      .addSelect('role.slug', 'roleSlug')
      .addSelect('member.status', 'status')
      .addSelect('member.createdAt', 'createdAt')
      .addSelect('account.displayName', 'userName')
      .addSelect('account.email', 'userEmail')
      .addSelect('account.avatarUrl', 'userAvatarUrl')
      .innerJoin(users.options.name, 'account', 'account.id = member.userId')
      .leftJoin(roles.options.name, 'role', 'role.id = member.roleId')
      .where('member.projectId = :projectId', { projectId })
      .andWhere('member.userId = :userId', { userId })
      .limit(1)
      .getRawMany<ProjectMemberRow>();

    return rows[0];
  }

  /** Repositórios ligados ao projeto, já no formato do contrato. */
  async listRepositories(projectId: string): Promise<ProjectRepositoryRow[]> {
    const rows = await this.db.manager
      .createQueryBuilder(projectRepositories, 'link')
      .select('link.id', 'id')
      .addSelect('repository.provider', 'provider')
      .addSelect('repository.cloneUrl', 'cloneUrl')
      .addSelect('repository.htmlUrl', 'htmlUrl')
      .addSelect('repository.defaultBranch', 'repositoryBranch')
      .addSelect('link.defaultBranch', 'overrideBranch')
      .addSelect('link.rootPath', 'rootPath')
      .innerJoin(
        gitRepositories.options.name,
        'repository',
        'repository.id = link.gitRepositoryId',
      )
      .where('link.projectId = :projectId', { projectId })
      .orderBy('link.isPrimary', 'DESC')
      .addOrderBy('link.createdAt', 'DESC')
      .getRawMany<RepositoryLinkRow>();

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
    const rows = await this.db.manager
      .createQueryBuilder(projects, 'project')
      .select('project.id')
      .where('project.organizationId = :organizationId', { organizationId })
      .andWhere('project.slug = :slug', { slug })
      .andWhere('project.deletedAt IS NULL')
      .limit(2)
      .getMany();

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

    await runInTransaction(this.db, async (tx) => {
      await tx.insert(
        projects,
        writable<Project>({
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
        }),
      );

      await tx.insert(projectSettings, {
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
      await tx.insert(projectMembers, {
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
    return runInTransaction(this.db, async (tx) => {
      const result = await tx
        .createQueryBuilder()
        .update(projects)
        .set({
          ...input.fields,
          ...(input.fields['status'] === 'archived' ? { archivedAt: new Date() } : {}),
          version: () => 'version + 1',
          updatedAt: new Date(),
        })
        .where('id = :id', { id: input.projectId })
        .andWhere('version = :version', { version: input.version })
        .execute();

      if (affectedRows(result) === 0) {
        return false;
      }

      if (Object.keys(input.settings).length > 0) {
        await tx
          .createQueryBuilder()
          .update(projectSettings)
          .set({ ...input.settings, updatedAt: new Date() })
          .where('project_id = :projectId', { projectId: input.projectId })
          .execute();
      }

      return true;
    });
  }
}
