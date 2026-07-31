/**
 * Regras do conhecimento: proposta, revisão e aprovação.
 *
 * Três invariantes mandam neste arquivo, e todas vêm do `Docs/10`:
 *
 * 1. **aprovar cria versão, não sobrescreve.** A versão vigente passa a
 *    `superseded` e a nova assume; nenhuma linha de conteúdo é apagada. É esse
 *    histórico que responde "de onde veio esta afirmação?" seis meses depois.
 * 2. **sem procedência não há aprovação.** Uma versão sem nenhuma linha em
 *    `knowledge_sources` não pode virar conhecimento oficial. O `Docs/10` exige
 *    que a fonte seja marcada como extraída ou inferida, e a diferença entre as
 *    duas é o que separa um fato de um palpite.
 * 3. **mudança e evento na mesma transação.** `knowledge.proposed` e
 *    `knowledge.reviewed` entram no outbox junto da escrita (`Docs/08`), para
 *    que não exista estado gravado sem o evento correspondente.
 */

import { createHash } from 'node:crypto';

import type {
  CreateKnowledgeProposal,
  KnowledgeDiff,
  KnowledgeItem,
  KnowledgeItemSummary,
  KnowledgeReview,
  KnowledgeReviewDecision,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeVersion,
} from '@prometheon/contracts';
import {
  enqueueOutboxMessage,
  knowledgeItems,
  knowledgeRelations,
  knowledgeReviews,
  knowledgeSources,
  knowledgeVersions,
  newId,
  runInTransaction,
  writable,
  type Database,
  type KnowledgeItem as KnowledgeItemEntity,
  type TransactionExecutor,
} from '@prometheon/database';

import { buildPage, type CursorPage } from '../../shared/cursor.js';
import { conflict } from '../../shared/errors.js';
import { affectedRows } from '../../shared/query.js';
import { toIso, toIsoOrNull } from '../../shared/time.js';
import { assertPlanLimit } from '../billing/limits.js';
import { diffLines } from './diff.js';
import {
  knowledgeNotFound,
  noPendingVersion,
  provenanceRequired,
  reviewConflict,
  selfApprovalDenied,
} from './errors.js';
import {
  KnowledgeRepository,
  type KnowledgeItemRow,
  type KnowledgeSourceRow,
  type KnowledgeVersionRow,
} from './repository.js';

/** Pastas do Vault Obsidian (`Docs/10`), por categoria. */
const VAULT_FOLDER: Readonly<Record<string, string>> = {
  architecture: 'Architecture',
  component: 'Components',
  decision: 'Decisions',
  problem: 'Problems',
  solution: 'Solutions',
  lesson: 'Lessons',
};

const DECISION_TO_REVIEW: Readonly<
  Record<KnowledgeReviewDecision, 'approved' | 'rejected' | 'changes_requested'>
> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};

function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    // NFD separa o acento da letra; o filtro seguinte descarta o acento e a
    // letra base sobrevive — `café` vira `cafe`, não `caf`.
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  return slug === '' ? 'knowledge' : slug;
}

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function publicUser(
  id: string | null,
  name: string | null,
  email: string | null,
  avatarUrl: string | null,
): KnowledgeItemSummary['proposedBy'] {
  if (id === null || name === null || email === null) {
    return null;
  }

  return { id, name, email, avatarUrl };
}

export function toVersionView(row: KnowledgeVersionRow): KnowledgeVersion {
  return {
    id: row.id,
    knowledgeId: row.knowledgeItemId,
    versionNumber: row.versionNumber,
    title: row.title,
    content: row.content,
    summary: row.summary,
    status: row.status,
    origin: row.origin,
    confidence: row.confidence,
    changeNote: row.changeNote,
    createdBy: publicUser(row.createdBy, row.authorName, row.authorEmail, row.authorAvatarUrl),
    createdAt: toIso(row.createdAt),
  };
}

export function toSourceView(row: KnowledgeSourceRow): KnowledgeSource {
  return {
    type: row.sourceType,
    reference: row.sourceRef,
    locator: row.locator,
    origin: row.origin,
    confidence: row.confidence,
  };
}

function toSummary(
  row: KnowledgeItemRow,
  versions: readonly KnowledgeVersionRow[],
  sourceCount: number,
): KnowledgeItemSummary {
  const current = versions.find((version) => version.id === row.currentVersionId);
  const pending = versions.find((version) => version.status === 'proposed');

  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    slug: row.slug,
    title: row.title,
    category: row.category,
    status: row.status,
    origin: row.origin,
    confidence: row.confidence,
    scope: row.scope,
    tags: row.tags ?? [],
    currentVersionNumber: current?.versionNumber ?? null,
    pendingVersionNumber: pending?.versionNumber ?? null,
    sourceCount,
    proposedBy: publicUser(
      row.createdBy,
      row.proposedByName,
      row.proposedByEmail,
      row.proposedByAvatarUrl,
    ),
    approvedAt: toIsoOrNull(row.approvedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    version: row.version,
  };
}

export interface ProposeInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly payload: CreateKnowledgeProposal;
}

export interface ReviewInput {
  readonly knowledgeId: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly decision: KnowledgeReviewDecision;
  readonly comment: string | undefined;
  readonly version: number;
  /**
   * Resolve `knowledge.approve` pelo caminho oficial de autorização.
   *
   * É uma função, e não um booleano, porque só interessa quando o revisor é o
   * próprio autor: assim o guard — que audita a negação — não roda, nem
   * registra recusa, para quem está apenas revisando o trabalho de outra
   * pessoa.
   */
  readonly canApprove: () => Promise<boolean>;
}

export interface ReviewResult {
  readonly review: KnowledgeReview;
  readonly item: KnowledgeItem;
  /** Número da versão que passou a valer; nulo quando não houve aprovação. */
  readonly approvedVersionNumber: number | null;
}

export class KnowledgeService {
  private readonly repository: KnowledgeRepository;

  constructor(private readonly db: Database) {
    this.repository = new KnowledgeRepository(this.db);
  }

  async list(
    filter: Parameters<KnowledgeRepository['listItems']>[0],
    limit: number,
    cursor: string | undefined,
  ): Promise<CursorPage<KnowledgeItemSummary>> {
    const rows = await this.repository.listItems(filter, limit, cursor);
    const page = buildPage(rows, limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    const ids = page.items.map((row) => row.id);
    const [versions, counts] = await Promise.all([
      this.repository.versionsForItems(ids),
      this.repository.sourceCounts(ids),
    ]);

    const byItem = new Map<string, KnowledgeVersionRow[]>();

    for (const version of versions) {
      const bucket = byItem.get(version.knowledgeItemId);

      if (bucket === undefined) {
        byItem.set(version.knowledgeItemId, [version]);
      } else {
        bucket.push(version);
      }
    }

    return {
      items: page.items.map((row) =>
        toSummary(row, byItem.get(row.id) ?? [], counts.get(row.id) ?? 0),
      ),
      pageInfo: page.pageInfo,
    };
  }

  /** Item com versão vigente, versão pendente, fontes e relações. */
  async get(knowledgeId: string, organizationId: string): Promise<KnowledgeItem> {
    const row = await this.repository.findItem(knowledgeId);

    if (row?.organizationId !== organizationId) {
      throw knowledgeNotFound();
    }

    const [versions, sources, relations] = await Promise.all([
      this.repository.versionsOf(knowledgeId),
      this.repository.sourcesOfItem(knowledgeId),
      this.repository.relationsOf(knowledgeId),
    ]);

    const current = versions.find((version) => version.id === row.currentVersionId);
    const pending = versions.find((version) => version.status === 'proposed');

    return {
      ...toSummary(row, versions, sources.length),
      currentVersion: current === undefined ? null : toVersionView(current),
      pendingVersion: pending === undefined ? null : toVersionView(pending),
      sources: sources.map(toSourceView),
      relations: relations.map((relation) => ({
        relation: relation.relation as KnowledgeItem['relations'][number]['relation'],
        knowledgeId: relation.knowledgeId,
      })),
    };
  }

  /**
   * Diferença entre a versão pendente e a vigente, com as fontes declaradas.
   *
   * As fontes vêm junto porque são metade da revisão: um diff bonito sem
   * procedência ainda leva a aprovar um palpite.
   */
  async diff(knowledgeId: string, organizationId: string): Promise<KnowledgeDiff> {
    const row = await this.repository.findItem(knowledgeId);

    if (row?.organizationId !== organizationId) {
      throw knowledgeNotFound();
    }

    const versions = await this.repository.versionsOf(knowledgeId);
    const pending = versions.find((version) => version.status === 'proposed');

    if (pending === undefined) {
      throw noPendingVersion();
    }

    const base = versions.find((version) => version.id === row.currentVersionId);
    const sources = await this.repository.sourcesOfVersion(pending.id);
    const result = diffLines(base?.content ?? '', pending.content);

    return {
      knowledgeId,
      base: base === undefined ? null : toVersionView(base),
      proposed: toVersionView(pending),
      added: result.added,
      removed: result.removed,
      lines: result.lines,
      sources: sources.map(toSourceView),
    };
  }

  /**
   * Cria uma proposta.
   *
   * Sem `knowledgeId` nasce um item novo em `proposed`; com ele, a proposta é
   * mais uma versão do item existente — e é isso que permite aprovar depois sem
   * perder a versão anterior.
   */
  async propose(input: ProposeInput): Promise<KnowledgeItem> {
    const { payload } = input;
    const existing =
      payload.knowledgeId === undefined
        ? undefined
        : await this.repository.findItem(payload.knowledgeId);

    if (payload.knowledgeId !== undefined) {
      if (
        existing?.organizationId !== input.organizationId ||
        (existing.projectId !== null && existing.projectId !== input.projectId)
      ) {
        throw knowledgeNotFound();
      }

      const versions = await this.repository.versionsOf(existing.id);

      // Uma proposta por vez: duas versões pendentes no mesmo item deixariam o
      // revisor decidindo sobre um alvo móvel.
      if (versions.some((version) => version.status === 'proposed')) {
        throw conflict(
          'CONFLICT',
          'This knowledge item already has a version awaiting review. Review it before proposing another.',
        );
      }
    } else {
      // Item novo consome uma vaga do plano; versão nova de item existente, não.
      await assertPlanLimit(this.db, {
        organizationId: input.organizationId,
        limit: 'maxKnowledgeItems',
      });
    }

    const itemId = existing?.id ?? newId();
    const versionId = newId();

    const slug = existing?.slug ?? (await this.uniqueSlug(input, payload.title));
    const now = new Date();

    await runInTransaction(this.db, async (tx) => {
      if (existing === undefined) {
        await tx.insert(
          knowledgeItems,
          writable<KnowledgeItemEntity>({
            id: itemId,
            organizationId: input.organizationId,
            projectId: input.projectId,
            slug,
            title: payload.title,
            category: payload.category,
            status: 'proposed',
            origin: payload.origin,
            confidence: payload.confidence,
            scope: payload.scope ?? null,
            path: `${VAULT_FOLDER[payload.category] ?? 'Home'}/${slug}.md`,
            currentVersionId: null,
            tags: payload.tags,
            createdBy: input.actorId,
          }),
        );
      } else {
        // O item continua apontando para a versão vigente: a proposta ainda não
        // vale nada. Só o estado muda, para a listagem mostrar que há revisão
        // pendente.
        await tx
          .createQueryBuilder()
          .update(knowledgeItems)
          .set({
            status: 'proposed',
            updatedAt: now,
            version: () => 'version + 1',
          })
          .where('id = :itemId', { itemId })
          .execute();
      }

      const nextNumber = await nextVersionNumber(tx, itemId);

      await tx.insert(knowledgeVersions, {
        id: versionId,
        organizationId: input.organizationId,
        knowledgeItemId: itemId,
        versionNumber: nextNumber,
        title: payload.title,
        content: payload.content,
        contentFormat: 'markdown',
        summary: payload.summary ?? null,
        checksumSha256: checksum(payload.content),
        status: 'proposed',
        origin: payload.origin,
        confidence: payload.confidence,
        changeNote: payload.changeNote ?? null,
        createdBy: input.actorId,
      });

      if (payload.sources.length > 0) {
        await tx.insert(
          knowledgeSources,
          payload.sources.map((source) => ({
            id: newId(),
            organizationId: input.organizationId,
            knowledgeItemId: itemId,
            knowledgeVersionId: versionId,
            sourceType: source.type,
            sourceRef: source.reference,
            locator: source.locator,
            origin: source.origin,
            confidence: source.confidence,
            extractedAt: now,
            createdBy: input.actorId,
          })),
        );
      }

      if (payload.relations.length > 0) {
        for (const relation of payload.relations) {
          // A relação tem unique natural, e repetir uma que já existe não é erro
          // do usuário: o `ON DUPLICATE KEY UPDATE relation_type =
          // VALUES(relation_type)` reescreve a linha com o mesmo valor, ou seja,
          // não muda nada e não falha.
          await tx
            .createQueryBuilder()
            .insert()
            .into(knowledgeRelations)
            .values({
              id: newId(),
              organizationId: input.organizationId,
              fromItemId: itemId,
              toItemId: relation.knowledgeId,
              relationType: relation.relation,
              createdBy: input.actorId,
            })
            .orUpdate(['relation_type'])
            .execute();
        }
      }

      // Evento na mesma transação da mudança (`Docs/08`): não existe conhecimento
      // proposto sem o evento correspondente.
      await enqueueOutboxMessage(tx, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        aggregateType: 'knowledge_item',
        aggregateId: itemId,
        aggregateSequence: nextNumber,
        eventType: 'knowledge.proposed',
        payload: {
          knowledgeId: itemId,
          knowledgeVersionId: versionId,
          versionNumber: nextNumber,
          category: payload.category,
          origin: payload.origin,
          sourceCount: payload.sources.length,
          proposedBy: input.actorId,
        },
        occurredAt: now,
      });
    });

    return this.get(itemId, input.organizationId);
  }

  /**
   * Registra a revisão e aplica a decisão.
   *
   * A primeira escrita da transação é o `UPDATE` do item com a versão que o
   * revisor leu. Se ela não afetar nenhuma linha, alguém mexeu no item nesse
   * meio-tempo e a revisão inteira é abortada — é o controle otimista do
   * `Docs/06` aplicado ao ponto onde ele importa.
   */
  async review(input: ReviewInput): Promise<ReviewResult> {
    const row = await this.repository.findItem(input.knowledgeId);

    if (row?.organizationId !== input.organizationId) {
      throw knowledgeNotFound();
    }

    const versions = await this.repository.versionsOf(input.knowledgeId);
    const pending = versions.find((version) => version.status === 'proposed');

    if (pending === undefined) {
      throw noPendingVersion();
    }

    const approving = input.decision === 'approve';

    if (approving) {
      const sources = await this.repository.sourcesOfVersion(pending.id);

      if (sources.length === 0) {
        throw provenanceRequired();
      }

      // Quem propõe não carimba a própria proposta: só passa quem tem
      // `knowledge.approve` de verdade, decidido pelo pacote de permissões.
      if (pending.createdBy === input.actorId && !(await input.canApprove())) {
        throw selfApprovalDenied();
      }
    }

    const current = versions.find((version) => version.id === row.currentVersionId);
    const reviewId = newId();
    const now = new Date();

    await runInTransaction(this.db, async (tx) => {
      const claimed = await this.applyDecision(tx, {
        row,
        pending,
        currentVersionId: current?.id ?? null,
        decision: input.decision,
        version: input.version,
        now,
      });

      if (!claimed) {
        throw reviewConflict();
      }

      await tx.insert(knowledgeReviews, {
        id: reviewId,
        organizationId: input.organizationId,
        knowledgeItemId: row.id,
        knowledgeVersionId: pending.id,
        reviewerUserId: input.actorId,
        decision: DECISION_TO_REVIEW[input.decision],
        rationale: input.comment ?? null,
        reviewedAt: now,
        createdBy: input.actorId,
      });

      await enqueueOutboxMessage(tx, {
        organizationId: input.organizationId,
        projectId: row.projectId,
        aggregateType: 'knowledge_item',
        aggregateId: row.id,
        aggregateSequence: pending.versionNumber,
        eventType: 'knowledge.reviewed',
        payload: {
          knowledgeId: row.id,
          knowledgeVersionId: pending.id,
          versionNumber: pending.versionNumber,
          decision: DECISION_TO_REVIEW[input.decision],
          reviewedBy: input.actorId,
          selfReview: pending.createdBy === input.actorId,
        },
        occurredAt: now,
      });
    });

    const item = await this.get(row.id, input.organizationId);

    return {
      review: {
        id: reviewId,
        knowledgeId: row.id,
        knowledgeVersionId: pending.id,
        decision: DECISION_TO_REVIEW[input.decision],
        comment: input.comment ?? null,
        reviewer: null,
        createdAt: toIso(now),
      },
      item,
      approvedVersionNumber: approving ? pending.versionNumber : null,
    };
  }

  /**
   * Aplica a decisão nas duas tabelas.
   *
   * Aprovar aposenta a versão anterior como `superseded` em vez de apagá-la:
   * quem auditar uma decisão daqui a um ano precisa do texto que valia naquele
   * momento, não só do que vale hoje.
   */
  private async applyDecision(
    tx: TransactionExecutor,
    input: {
      row: KnowledgeItemRow;
      pending: KnowledgeVersionRow;
      currentVersionId: string | null;
      decision: KnowledgeReviewDecision;
      version: number;
      now: Date;
    },
  ): Promise<boolean> {
    const { row, pending, decision, now } = input;

    const nextStatus: KnowledgeStatus =
      decision === 'approve'
        ? 'approved'
        : decision === 'reject'
          ? input.currentVersionId === null
            ? 'rejected'
            : 'approved'
          : 'proposed';

    const claim = await tx
      .createQueryBuilder()
      .update(knowledgeItems)
      .set({
        ...writable<KnowledgeItemEntity>({
          status: nextStatus,
          ...(decision === 'approve'
            ? {
                currentVersionId: pending.id,
                title: pending.title,
                origin: pending.origin,
                confidence: pending.confidence,
                approvedAt: now,
              }
            : {}),
          updatedAt: now,
        }),
        version: () => 'version + 1',
      })
      .where('id = :id', { id: row.id })
      .andWhere('version = :version', { version: input.version })
      .execute();

    if (affectedRows(claim) === 0) {
      return false;
    }

    if (decision === 'approve') {
      if (input.currentVersionId !== null) {
        await tx
          .createQueryBuilder()
          .update(knowledgeVersions)
          .set({ status: 'superseded', updatedAt: now })
          .where('id = :id', { id: input.currentVersionId })
          .execute();
      }

      await tx
        .createQueryBuilder()
        .update(knowledgeVersions)
        .set({ status: 'approved', updatedAt: now })
        .where('id = :id', { id: pending.id })
        .execute();
    }

    if (decision === 'reject') {
      // Conhecimento rejeitado continua gravado (histórico) mas não volta a ser
      // injetado nos agentes — a consulta do contexto filtra por `status`.
      await tx
        .createQueryBuilder()
        .update(knowledgeVersions)
        .set({ status: 'rejected', updatedAt: now })
        .where('id = :id', { id: pending.id })
        .execute();
    }

    return true;
  }

  /** Slug único no escopo, desambiguado por sufixo numérico. */
  private async uniqueSlug(input: ProposeInput, title: string): Promise<string> {
    const base = slugify(title);
    const taken = new Set(
      await this.repository.slugsLike(input.organizationId, input.projectId, base),
    );

    if (!taken.has(base)) {
      return base;
    }

    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = `${base}-${String(suffix)}`;

      if (!taken.has(candidate)) {
        return candidate;
      }
    }

    return `${base}-${newId().slice(-8).toLowerCase()}`;
  }
}

/**
 * Reserva o próximo número de versão do item, dentro da transação.
 *
 * `(knowledge_item_id, version_number)` tem unique natural, então o número não
 * pode sair de um `MAX(...) + 1` lido fora de lock: duas propostas simultâneas
 * para o mesmo item leriam o mesmo máximo e a segunda viraria erro 500 em vez
 * de simplesmente receber o número seguinte. O `FOR UPDATE` segura a faixa do
 * índice único até o commit — a segunda transação só lê depois que a primeira
 * gravou.
 *
 * É SQL cru porque o que interessa é o agregado com o lock, e o query builder
 * só aplica `FOR UPDATE` a consultas de entidade.
 */
async function nextVersionNumber(
  tx: TransactionExecutor,
  knowledgeItemId: string,
): Promise<number> {
  const rows: { next: number | string | null }[] = await tx.query(
    `select coalesce(max(version_number), 0) + 1 as next
       from knowledge_versions
      where knowledge_item_id = ?
      for update`,
    [knowledgeItemId],
  );

  return Number(rows[0]?.next ?? 1);
}
