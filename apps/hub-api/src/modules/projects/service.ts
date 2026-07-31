/**
 * Regras de projeto.
 *
 * O projeto é a unidade de trabalho dentro da organização: conversas, tarefas e
 * conhecimento pendem dele. Por isso duas coisas nascem junto com ele — a
 * configuração (`project_settings`, segunda camada da precedência do `Docs/09`)
 * e o primeiro membro (`project_members`, sem o qual quem criou não enxergaria
 * o que acabou de criar).
 */

import type {
  CreateProjectRequest,
  Project,
  ProjectSettings,
} from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { buildPage, type CursorPage } from '../../shared/cursor.js';
import { toIso } from '../../shared/time.js';
import { projectNotFound, projectSlugTaken, projectVersionConflict } from './errors.js';
import { ProjectRepository, type ProjectListFilters } from './repository.js';
import type { ProjectRow, ProjectSettingsRow } from './types.js';

/**
 * Configuração de um projeto recém-criado.
 *
 * `requireReview` nasce ligado e `allowRemoteAgents` desligado: o padrão de um
 * projeto novo é o mais conservador, e afrouxá-lo é uma decisão explícita de
 * quem tem `project.configure`.
 */
const DEFAULT_SETTINGS: Omit<ProjectSettingsRow, 'policy'> = {
  defaultWorkMode: 'plan',
  defaultAutonomy: 'manual',
  contextBudgetTokens: 120_000,
  allowRemoteAgents: false,
  requireReview: true,
  retentionDays: null,
};

export interface ProjectServiceDeps {
  readonly db: Database;
}

/**
 * Configuração parcial vinda do `PATCH`.
 *
 * Escrito por extenso em vez de `Partial<ProjectSettings>` porque o projeto
 * roda com `exactOptionalPropertyTypes`: ali, "opcional" e "pode ser undefined"
 * são coisas diferentes, e o corpo validado pelo Zod é a segunda.
 */
export interface PartialProjectSettings {
  defaultWorkMode?: ProjectSettings['defaultWorkMode'] | undefined;
  defaultAutonomy?: ProjectSettings['defaultAutonomy'] | undefined;
  requireReview?: boolean | undefined;
  allowRemoteAgents?: boolean | undefined;
  contextBudgetTokens?: number | undefined;
  conversationRetentionDays?: number | null | undefined;
}

export class ProjectService {
  private readonly repository: ProjectRepository;

  constructor(deps: ProjectServiceDeps) {
    this.repository = new ProjectRepository(deps.db);
  }

  async list(input: {
    organizationId: string;
    userId: string;
    /** `owner` e `admin` enxergam todo projeto de visibilidade `organization`. */
    canSeeEveryProject: boolean;
    limit: number;
    cursor: string | undefined;
    filters: ProjectListFilters;
  }): Promise<CursorPage<Project>> {
    const rows = await this.repository.listForOrganization(input);
    const page = buildPage(rows, input.limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    // Uma consulta para a configuração da página inteira, em vez de uma por
    // projeto: a listagem tem no máximo cem itens, e cem idas ao banco por
    // página é o jeito mais fácil de transformar uma lista em um incidente.
    const settings = await this.repository.settingsByProject(page.items.map((row) => row.id));

    return {
      items: page.items.map((row) => toProjectView(row, settings.get(row.id), [])),
      pageInfo: page.pageInfo,
    };
  }

  async get(projectId: string): Promise<Project> {
    const [project, settings, repositories] = await Promise.all([
      this.repository.findById(projectId),
      this.repository.findSettings(projectId),
      this.repository.listRepositories(projectId),
    ]);

    if (project === undefined) {
      throw projectNotFound();
    }

    return toProjectView(project, settings, repositories);
  }

  async create(input: {
    organizationId: string;
    createdBy: string;
    request: CreateProjectRequest;
  }): Promise<Project> {
    const slug = input.request.slug ?? slugify(input.request.name);

    if (await this.repository.slugExists(input.organizationId, slug)) {
      throw projectSlugTaken();
    }

    const projectId = await this.repository.create({
      organizationId: input.organizationId,
      slug,
      name: input.request.name,
      description: input.request.description ?? null,
      visibility: input.request.visibility,
      tags: input.request.tags,
      settings: mergeSettings(DEFAULT_SETTINGS, input.request.settings),
      createdBy: input.createdBy,
    });

    return this.get(projectId);
  }

  /** Atualiza projeto e configuração com concorrência otimista. */
  async update(input: {
    project: ProjectRow;
    version: number;
    fields: {
      name?: string | undefined;
      slug?: string | undefined;
      description?: string | null | undefined;
      status?: 'active' | 'paused' | 'archived' | undefined;
      visibility?: 'private' | 'organization' | undefined;
      tags?: string[] | undefined;
    };
    settings: PartialProjectSettings | undefined;
  }): Promise<Project> {
    if (input.fields.slug !== undefined && input.fields.slug !== input.project.slug) {
      const taken = await this.repository.slugExists(
        input.project.organizationId,
        input.fields.slug,
        input.project.id,
      );

      if (taken) {
        throw projectSlugTaken();
      }
    }

    const current = await this.repository.findSettings(input.project.id);
    const updated = await this.repository.update({
      projectId: input.project.id,
      version: input.version,
      fields: definedOnly(input.fields),
      settings: definedOnly(mergeSettings(current ?? DEFAULT_SETTINGS, input.settings, true)),
    });

    if (!updated) {
      throw projectVersionConflict();
    }

    return this.get(input.project.id);
  }
}

/** Remove as chaves ausentes para que `undefined` não vire `NULL` no `SET`. */
function definedOnly(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * Traduz a configuração do contrato para a coluna correspondente.
 *
 * `onlyProvided` distingue criação de atualização: na criação todos os campos
 * têm valor (o padrão preenche o que faltou); na atualização, campo ausente
 * precisa continuar ausente, para o `UPDATE` não reescrever o que ninguém pediu.
 */
function mergeSettings(
  base: Omit<ProjectSettingsRow, 'policy'>,
  requested: PartialProjectSettings | undefined,
  onlyProvided = false,
): Omit<ProjectSettingsRow, 'policy'> {
  const pick = <K extends keyof Omit<ProjectSettingsRow, 'policy'>>(
    key: K,
    value: Omit<ProjectSettingsRow, 'policy'>[K] | undefined,
  ): Omit<ProjectSettingsRow, 'policy'>[K] | undefined => {
    // `??` não serve aqui: `conversationRetentionDays: null` é uma decisão
    // ("volte a seguir a política da organização"), não ausência de valor.
    if (value !== undefined) {
      return value;
    }

    return onlyProvided ? undefined : base[key];
  };

  return {
    defaultWorkMode: pick('defaultWorkMode', requested?.defaultWorkMode),
    defaultAutonomy: pick('defaultAutonomy', requested?.defaultAutonomy),
    contextBudgetTokens: pick('contextBudgetTokens', requested?.contextBudgetTokens),
    allowRemoteAgents: pick('allowRemoteAgents', requested?.allowRemoteAgents),
    requireReview: pick('requireReview', requested?.requireReview),
    retentionDays: pick('retentionDays', requested?.conversationRetentionDays),
  } as Omit<ProjectSettingsRow, 'policy'>;
}

export function toProjectSettingsView(
  settings: ProjectSettingsRow | undefined,
): ProjectSettings {
  const source = settings ?? DEFAULT_SETTINGS;

  return {
    defaultWorkMode: source.defaultWorkMode,
    // A coluna aceita `bypass` porque o enum é o mesmo em todo o schema; o
    // contrato não. Um projeto que de alguma forma tenha `bypass` gravado é
    // lido como `manual`, que é o que o `Docs/09` diz que ele deve ser fora da
    // janela local e temporária.
    defaultAutonomy: source.defaultAutonomy === 'auto' ? 'auto' : 'manual',
    requireReview: source.requireReview,
    allowRemoteAgents: source.allowRemoteAgents,
    contextBudgetTokens: source.contextBudgetTokens,
    conversationRetentionDays: source.retentionDays,
  };
}

export function toProjectView(
  row: ProjectRow,
  settings: ProjectSettingsRow | undefined,
  repositories: Project['repositories'],
): Project {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    visibility: row.visibility,
    tags: row.tags ?? [],
    repositories,
    settings: toProjectSettingsView(settings),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    // `created_by` é nulo em projeto criado pelo seed; o contrato pede um ULID,
    // e o próprio projeto é a resposta mais próxima da verdade.
    createdBy: row.createdBy ?? row.id,
    version: row.version,
  };
}

/**
 * Slug a partir do nome, quando o cliente não manda um.
 *
 * Acento vira a letra sem acento (`Ação` → `acao`) em vez de sumir: `acao` é
 * localizável na URL, `ao` não é.
 */
export function slugify(name: string): string {
  const normalized = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');

  // Nome inteiramente fora do alfabeto latino não produz slug utilizável; o
  // contrato exige pelo menos dois caracteres.
  return normalized.length >= 2 ? normalized : `project-${Date.now().toString(36)}`;
}
