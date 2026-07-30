/**
 * Leitura do conhecimento.
 *
 * O item é a identidade estável e o conteúdo vive em `knowledge_versions`, então
 * quase toda consulta aqui é "item + versão vigente + versão pendente". A
 * listagem resolve isso em duas idas ao banco em vez de uma subconsulta por
 * linha: a página tem no máximo cem itens, e duas consultas com `IN (…)` são
 * previsíveis, enquanto uma correlacionada degrada silenciosamente quando a
 * tabela cresce.
 */

import {
  knowledgeItems,
  knowledgeRelations,
  knowledgeSources,
  knowledgeVersions,
  projects,
  users,
  type Database,
} from '@prometheon/database';
import { and, count, desc, eq, inArray, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor } from '../../shared/cursor.js';

export type KnowledgeItemRow = typeof knowledgeItems.$inferSelect & {
  proposedByName: string | null;
  proposedByEmail: string | null;
  proposedByAvatarUrl: string | null;
};

export type KnowledgeVersionRow = typeof knowledgeVersions.$inferSelect & {
  authorName: string | null;
  authorEmail: string | null;
  authorAvatarUrl: string | null;
};

export type KnowledgeSourceRow = typeof knowledgeSources.$inferSelect;

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

const itemColumns = {
  id: knowledgeItems.id,
  organizationId: knowledgeItems.organizationId,
  projectId: knowledgeItems.projectId,
  slug: knowledgeItems.slug,
  title: knowledgeItems.title,
  category: knowledgeItems.category,
  status: knowledgeItems.status,
  origin: knowledgeItems.origin,
  confidence: knowledgeItems.confidence,
  scope: knowledgeItems.scope,
  path: knowledgeItems.path,
  currentVersionId: knowledgeItems.currentVersionId,
  supersededById: knowledgeItems.supersededById,
  tags: knowledgeItems.tags,
  approvedAt: knowledgeItems.approvedAt,
  scopeKey: knowledgeItems.scopeKey,
  createdAt: knowledgeItems.createdAt,
  updatedAt: knowledgeItems.updatedAt,
  createdBy: knowledgeItems.createdBy,
  version: knowledgeItems.version,
  deletedAt: knowledgeItems.deletedAt,
  proposedByName: users.displayName,
  proposedByEmail: users.email,
  proposedByAvatarUrl: users.avatarUrl,
} as const;

const versionColumns = {
  id: knowledgeVersions.id,
  organizationId: knowledgeVersions.organizationId,
  knowledgeItemId: knowledgeVersions.knowledgeItemId,
  versionNumber: knowledgeVersions.versionNumber,
  title: knowledgeVersions.title,
  content: knowledgeVersions.content,
  contentFormat: knowledgeVersions.contentFormat,
  summary: knowledgeVersions.summary,
  checksumSha256: knowledgeVersions.checksumSha256,
  status: knowledgeVersions.status,
  origin: knowledgeVersions.origin,
  confidence: knowledgeVersions.confidence,
  evidence: knowledgeVersions.evidence,
  changeNote: knowledgeVersions.changeNote,
  createdAt: knowledgeVersions.createdAt,
  updatedAt: knowledgeVersions.updatedAt,
  createdBy: knowledgeVersions.createdBy,
  version: knowledgeVersions.version,
  authorName: users.displayName,
  authorEmail: users.email,
  authorAvatarUrl: users.avatarUrl,
} as const;

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  /** Projeto e a organização dona dele, para a autorização da rota. */
  async findProject(
    projectId: string,
  ): Promise<{ id: string; organizationId: string } | undefined> {
    const [row] = await this.db
      .select({ id: projects.id, organizationId: projects.organizationId })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);

    return row;
  }

  async listItems(
    filter: KnowledgeListFilter,
    limit: number,
    cursor: string | undefined,
  ): Promise<KnowledgeItemRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const conditions: (SQL | undefined)[] = [
      eq(knowledgeItems.organizationId, filter.organizationId),
      isNull(knowledgeItems.deletedAt),
      filter.includeOrganization === true
        ? or(eq(knowledgeItems.projectId, filter.projectId), isNull(knowledgeItems.projectId))
        : eq(knowledgeItems.projectId, filter.projectId),
    ];

    if (filter.status !== undefined) {
      conditions.push(
        eq(knowledgeItems.status, filter.status as typeof knowledgeItems.$inferSelect.status),
      );
    }

    if (filter.category !== undefined) {
      conditions.push(
        eq(knowledgeItems.category, filter.category as typeof knowledgeItems.$inferSelect.category),
      );
    }

    if (filter.origin !== undefined) {
      conditions.push(
        eq(knowledgeItems.origin, filter.origin as typeof knowledgeItems.$inferSelect.origin),
      );
    }

    if (filter.tag !== undefined) {
      // `JSON_CONTAINS` compara o valor inteiro; o parâmetro entra como JSON
      // ligado, nunca concatenado na consulta.
      conditions.push(sql`json_contains(${knowledgeItems.tags}, ${JSON.stringify(filter.tag)})`);
    }

    if (filter.search !== undefined && filter.search !== '') {
      // `LIKE` com escape do que o próprio `LIKE` interpreta: sem isto, um `%`
      // digitado na busca viraria coringa.
      const escaped = filter.search.replace(/[\\%_]/g, (match) => `\\${match}`);

      conditions.push(like(knowledgeItems.title, `%${escaped}%`));
    }

    if (after !== undefined) {
      const at = new Date(after.at);

      conditions.push(
        or(
          lt(knowledgeItems.createdAt, at),
          and(eq(knowledgeItems.createdAt, at), lt(knowledgeItems.id, after.id)),
        ),
      );
    }

    return this.db
      .select(itemColumns)
      .from(knowledgeItems)
      .leftJoin(users, eq(users.id, knowledgeItems.createdBy))
      .where(and(...conditions))
      .orderBy(desc(knowledgeItems.createdAt), desc(knowledgeItems.id))
      .limit(limit + 1);
  }

  async findItem(knowledgeId: string): Promise<KnowledgeItemRow | undefined> {
    const [row] = await this.db
      .select(itemColumns)
      .from(knowledgeItems)
      .leftJoin(users, eq(users.id, knowledgeItems.createdBy))
      .where(and(eq(knowledgeItems.id, knowledgeId), isNull(knowledgeItems.deletedAt)))
      .limit(1);

    return row;
  }

  /** Todas as versões de um item, da mais nova para a mais antiga. */
  async versionsOf(knowledgeItemId: string): Promise<KnowledgeVersionRow[]> {
    return this.db
      .select(versionColumns)
      .from(knowledgeVersions)
      .leftJoin(users, eq(users.id, knowledgeVersions.createdBy))
      .where(eq(knowledgeVersions.knowledgeItemId, knowledgeItemId))
      .orderBy(desc(knowledgeVersions.versionNumber));
  }

  /** Versões vigentes e pendentes de vários itens, para montar a listagem. */
  async versionsForItems(itemIds: readonly string[]): Promise<KnowledgeVersionRow[]> {
    if (itemIds.length === 0) {
      return [];
    }

    return this.db
      .select(versionColumns)
      .from(knowledgeVersions)
      .leftJoin(users, eq(users.id, knowledgeVersions.createdBy))
      .where(inArray(knowledgeVersions.knowledgeItemId, [...itemIds]))
      .orderBy(desc(knowledgeVersions.versionNumber));
  }

  async sourceCounts(itemIds: readonly string[]): Promise<Map<string, number>> {
    if (itemIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({ itemId: knowledgeSources.knowledgeItemId, value: count() })
      .from(knowledgeSources)
      .where(inArray(knowledgeSources.knowledgeItemId, [...itemIds]))
      .groupBy(knowledgeSources.knowledgeItemId);

    return new Map(rows.map((row) => [row.itemId, row.value]));
  }

  /** Fontes de uma versão. É o que decide se ela pode ser aprovada. */
  async sourcesOfVersion(knowledgeVersionId: string): Promise<KnowledgeSourceRow[]> {
    return this.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.knowledgeVersionId, knowledgeVersionId));
  }

  async sourcesOfItem(knowledgeItemId: string): Promise<KnowledgeSourceRow[]> {
    return this.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.knowledgeItemId, knowledgeItemId));
  }

  async relationsOf(
    knowledgeItemId: string,
  ): Promise<{ relation: string; knowledgeId: string }[]> {
    const rows = await this.db
      .select({
        relation: knowledgeRelations.relationType,
        knowledgeId: knowledgeRelations.toItemId,
      })
      .from(knowledgeRelations)
      .where(eq(knowledgeRelations.fromItemId, knowledgeItemId));

    return rows;
  }

  /** Slugs já usados no mesmo escopo, para desambiguar um slug novo. */
  async slugsLike(
    organizationId: string,
    projectId: string | null,
    prefix: string,
  ): Promise<string[]> {
    const escaped = prefix.replace(/[\\%_]/g, (match) => `\\${match}`);
    const rows = await this.db
      .select({ slug: knowledgeItems.slug })
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.organizationId, organizationId),
          projectId === null
            ? isNull(knowledgeItems.projectId)
            : eq(knowledgeItems.projectId, projectId),
          like(knowledgeItems.slug, `${escaped}%`),
        ),
      );

    return rows.map((row) => row.slug);
  }
}
