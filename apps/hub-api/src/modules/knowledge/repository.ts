/**
 * Leitura do conhecimento.
 *
 * O item é a identidade estável e o conteúdo vive em `knowledge_versions`, então
 * quase toda consulta aqui é "item + versão vigente + versão pendente". A
 * listagem resolve isso em duas idas ao banco em vez de uma subconsulta por
 * linha: a página tem no máximo cem itens, e duas consultas com `IN (…)` são
 * previsíveis, enquanto uma correlacionada degrada silenciosamente quando a
 * tabela cresce.
 *
 * Item e versão trazem nome, e-mail e avatar de quem propôs, que vivem em
 * `users`. Como o resultado mistura colunas de duas tabelas, as leituras são
 * `getRawMany` com alias explícito — uma entidade hidratada não comporta isso
 * sem inventar uma relação que o schema não tem.
 */

import {
  knowledgeItems,
  knowledgeRelations,
  knowledgeSources,
  knowledgeVersions,
  projects,
  users,
  type Database,
  type KnowledgeItem,
  type KnowledgeSource,
  type KnowledgeVersion,
} from '@prometheon/database';
import type { SelectQueryBuilder } from 'typeorm';

import { decodeCursor } from '../../shared/cursor.js';
import { applyKeyset, escapeLike } from '../../shared/query.js';

export type KnowledgeItemRow = KnowledgeItem & {
  proposedByName: string | null;
  proposedByEmail: string | null;
  proposedByAvatarUrl: string | null;
};

export type KnowledgeVersionRow = KnowledgeVersion & {
  authorName: string | null;
  authorEmail: string | null;
  authorAvatarUrl: string | null;
};

export type KnowledgeSourceRow = KnowledgeSource;

export interface KnowledgeListFilter {
  readonly organizationId: string;
  readonly projectId: string;
  /** `true` traz também o conhecimento sem projeto, válido para a organização. */
  readonly includeOrganization?: boolean | undefined;
  readonly status?: string | undefined;
  readonly category?: string | undefined;
  readonly origin?: string | undefined;
  readonly tag?: string | undefined;
  readonly search?: string | undefined;
}

/**
 * Colunas do item, com o alias que o contrato espera.
 *
 * `scope_key` entra apenas na leitura. Ela é gerada pelo banco
 * (`coalesce(project_id, '')`) e sustenta o unique
 * `(organization_id, scope_key, slug)`; a entidade a declara como
 * `insert: false, update: false` justamente para que nenhuma escrita a alcance.
 */
const ITEM_COLUMNS: readonly (readonly [string, string])[] = [
  ['item.id', 'id'],
  ['item.organizationId', 'organizationId'],
  ['item.projectId', 'projectId'],
  ['item.slug', 'slug'],
  ['item.title', 'title'],
  ['item.category', 'category'],
  ['item.status', 'status'],
  ['item.origin', 'origin'],
  ['item.confidence', 'confidence'],
  ['item.scope', 'scope'],
  ['item.path', 'path'],
  ['item.currentVersionId', 'currentVersionId'],
  ['item.supersededById', 'supersededById'],
  ['item.tags', 'tags'],
  ['item.approvedAt', 'approvedAt'],
  ['item.scopeKey', 'scopeKey'],
  ['item.createdAt', 'createdAt'],
  ['item.updatedAt', 'updatedAt'],
  ['item.createdBy', 'createdBy'],
  ['item.version', 'version'],
  ['item.deletedAt', 'deletedAt'],
  ['author.displayName', 'proposedByName'],
  ['author.email', 'proposedByEmail'],
  ['author.avatarUrl', 'proposedByAvatarUrl'],
];

const VERSION_COLUMNS: readonly (readonly [string, string])[] = [
  ['version.id', 'id'],
  ['version.organizationId', 'organizationId'],
  ['version.knowledgeItemId', 'knowledgeItemId'],
  ['version.versionNumber', 'versionNumber'],
  ['version.title', 'title'],
  ['version.content', 'content'],
  ['version.contentFormat', 'contentFormat'],
  ['version.summary', 'summary'],
  ['version.checksumSha256', 'checksumSha256'],
  ['version.status', 'status'],
  ['version.origin', 'origin'],
  ['version.confidence', 'confidence'],
  ['version.evidence', 'evidence'],
  ['version.changeNote', 'changeNote'],
  ['version.createdAt', 'createdAt'],
  ['version.updatedAt', 'updatedAt'],
  ['version.createdBy', 'createdBy'],
  ['version.version', 'version'],
  ['author.displayName', 'authorName'],
  ['author.email', 'authorEmail'],
  ['author.avatarUrl', 'authorAvatarUrl'],
];

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  /** Projeto e a organização dona dele, para a autorização da rota. */
  async findProject(
    projectId: string,
  ): Promise<{ id: string; organizationId: string } | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(projects, 'project')
      .select(['project.id', 'project.organizationId'])
      .where('project.id = :projectId', { projectId })
      .andWhere('project.deletedAt IS NULL')
      .getOne();

    return row ?? undefined;
  }

  async listItems(
    filter: KnowledgeListFilter,
    limit: number,
    cursor: string | undefined,
  ): Promise<KnowledgeItemRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const query = this.itemQuery().andWhere('item.organizationId = :organizationId', {
      organizationId: filter.organizationId,
    });

    if (filter.includeOrganization === true) {
      query.andWhere('(item.projectId = :projectId OR item.projectId IS NULL)', {
        projectId: filter.projectId,
      });
    } else {
      query.andWhere('item.projectId = :projectId', { projectId: filter.projectId });
    }

    if (filter.status !== undefined) {
      query.andWhere('item.status = :status', { status: filter.status });
    }

    if (filter.category !== undefined) {
      query.andWhere('item.category = :category', { category: filter.category });
    }

    if (filter.origin !== undefined) {
      query.andWhere('item.origin = :origin', { origin: filter.origin });
    }

    if (filter.tag !== undefined) {
      // `JSON_CONTAINS` compara o valor inteiro; o parâmetro entra como JSON
      // ligado, nunca concatenado na consulta.
      query.andWhere('json_contains(item.tags, :tag)', { tag: JSON.stringify(filter.tag) });
    }

    if (filter.search !== undefined && filter.search !== '') {
      // `LIKE` com escape do que o próprio `LIKE` interpreta: sem isto, um `%`
      // digitado na busca viraria coringa.
      query.andWhere('item.title LIKE :search', {
        search: `%${escapeLike(filter.search)}%`,
      });
    }

    applyKeyset(query, 'item', { createdAt: 'createdAt', id: 'id' }, after);

    return query
      .orderBy('item.createdAt', 'DESC')
      .addOrderBy('item.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<KnowledgeItemRow>();
  }

  async findItem(knowledgeId: string): Promise<KnowledgeItemRow | undefined> {
    const rows = await this.itemQuery()
      .andWhere('item.id = :knowledgeId', { knowledgeId })
      .limit(1)
      .getRawMany<KnowledgeItemRow>();

    return rows[0];
  }

  /** Todas as versões de um item, da mais nova para a mais antiga. */
  async versionsOf(knowledgeItemId: string): Promise<KnowledgeVersionRow[]> {
    return this.versionQuery()
      .where('version.knowledgeItemId = :knowledgeItemId', { knowledgeItemId })
      .orderBy('version.versionNumber', 'DESC')
      .getRawMany<KnowledgeVersionRow>();
  }

  /** Versões vigentes e pendentes de vários itens, para montar a listagem. */
  async versionsForItems(itemIds: readonly string[]): Promise<KnowledgeVersionRow[]> {
    if (itemIds.length === 0) {
      return [];
    }

    return this.versionQuery()
      .where('version.knowledgeItemId IN (:...itemIds)', { itemIds: [...itemIds] })
      .orderBy('version.versionNumber', 'DESC')
      .getRawMany<KnowledgeVersionRow>();
  }

  async sourceCounts(itemIds: readonly string[]): Promise<Map<string, number>> {
    if (itemIds.length === 0) {
      return new Map();
    }

    const rows = await this.db.manager
      .createQueryBuilder(knowledgeSources, 'source')
      .select('source.knowledgeItemId', 'itemId')
      .addSelect('count(*)', 'value')
      .where('source.knowledgeItemId IN (:...itemIds)', { itemIds: [...itemIds] })
      .groupBy('source.knowledgeItemId')
      .getRawMany<{ itemId: string; value: number | string }>();

    // `count(*)` é `BIGINT`: a consulta é crua e não passa pelo conversor de
    // coluna, então a normalização para número acontece aqui.
    return new Map(rows.map((row) => [row.itemId, Number(row.value)]));
  }

  /** Fontes de uma versão. É o que decide se ela pode ser aprovada. */
  async sourcesOfVersion(knowledgeVersionId: string): Promise<KnowledgeSourceRow[]> {
    return this.db.manager.find(knowledgeSources, { where: { knowledgeVersionId } });
  }

  async sourcesOfItem(knowledgeItemId: string): Promise<KnowledgeSourceRow[]> {
    return this.db.manager.find(knowledgeSources, { where: { knowledgeItemId } });
  }

  async relationsOf(
    knowledgeItemId: string,
  ): Promise<{ relation: string; knowledgeId: string }[]> {
    return this.db.manager
      .createQueryBuilder(knowledgeRelations, 'link')
      .select('link.relationType', 'relation')
      .addSelect('link.toItemId', 'knowledgeId')
      .where('link.fromItemId = :knowledgeItemId', { knowledgeItemId })
      .getRawMany<{ relation: string; knowledgeId: string }>();
  }

  /** Slugs já usados no mesmo escopo, para desambiguar um slug novo. */
  async slugsLike(
    organizationId: string,
    projectId: string | null,
    prefix: string,
  ): Promise<string[]> {
    const query = this.db.manager
      .createQueryBuilder(knowledgeItems, 'item')
      .select(['item.slug'])
      .where('item.organizationId = :organizationId', { organizationId })
      .andWhere('item.slug LIKE :prefix', { prefix: `${escapeLike(prefix)}%` });

    if (projectId === null) {
      query.andWhere('item.projectId IS NULL');
    } else {
      query.andWhere('item.projectId = :projectId', { projectId });
    }

    const rows = await query.getMany();

    return rows.map((row) => row.slug);
  }

  /** Base das leituras de item: item + quem propôs. */
  private itemQuery(): SelectQueryBuilder<KnowledgeItem> {
    return withColumns(
      this.db.manager
        .createQueryBuilder(knowledgeItems, 'item')
        .select([])
        .leftJoin(users.options.name, 'author', 'author.id = item.createdBy')
        .where('item.deletedAt IS NULL'),
      ITEM_COLUMNS,
    );
  }

  /** Base das leituras de versão: versão + quem escreveu. */
  private versionQuery(): SelectQueryBuilder<KnowledgeVersion> {
    return withColumns(
      this.db.manager
        .createQueryBuilder(knowledgeVersions, 'version')
        .select([])
        .leftJoin(users.options.name, 'author', 'author.id = version.createdBy'),
      VERSION_COLUMNS,
    );
  }
}

/** Acrescenta a lista de colunas com os alias que o contrato espera. */
function withColumns<T extends object>(
  query: SelectQueryBuilder<T>,
  columns: readonly (readonly [string, string])[],
): SelectQueryBuilder<T> {
  for (const [column, alias] of columns) {
    query.addSelect(column, alias);
  }

  return query;
}
