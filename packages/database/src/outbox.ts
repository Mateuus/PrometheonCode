// Consultas do Transactional Outbox usadas pelo worker (`Docs/08`).
//
// A gravação acontece dentro da transação do domínio — é isso que garante que
// não exista mudança sem evento. A publicação é um segundo passo, do worker,
// que varre os não publicados, publica e marca. Consumidor deduplica pelo `id`.

import { and, asc, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { newId } from './id.js';
import { outboxMessages } from './schema/outbox.js';

export type OutboxMessage = typeof outboxMessages.$inferSelect;

export interface EnqueueOutboxInput {
  id?: string;
  organizationId: string;
  projectId?: string | null;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence?: number | null;
  eventType: string;
  eventVersion?: number;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  occurredAt?: Date;
  availableAt?: Date;
}

/**
 * Grava o evento. Recebe `executor` em vez de abrir conexão própria justamente
 * para poder rodar dentro da transação do domínio:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await tx.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId));
 *   await enqueueOutboxMessage(tx, { … });
 * });
 * ```
 */
export async function enqueueOutboxMessage(
  executor: Pick<Database, 'insert'>,
  input: EnqueueOutboxInput,
): Promise<string> {
  const id = input.id ?? newId();
  const occurredAt = input.occurredAt ?? new Date();
  await executor.insert(outboxMessages).values({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateSequence: input.aggregateSequence ?? null,
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    payload: input.payload,
    dedupeKey: input.dedupeKey ?? null,
    occurredAt,
    availableAt: input.availableAt ?? occurredAt,
  });
  return id;
}

export interface FetchUnpublishedOptions {
  /** Tamanho do lote. */
  limit?: number;
  /** Instante de referência; existe para o teste não depender do relógio. */
  now?: Date;
  /**
   * `true` acrescenta `FOR UPDATE SKIP LOCKED`, o que permite vários workers
   * varrendo a mesma tabela sem pegar a mesma linha. Só faz sentido dentro de
   * uma transação — fora dela o MySQL solta o lock imediatamente.
   */
  lockForUpdate?: boolean;
}

/**
 * A consulta que o worker roda em laço:
 *
 * ```sql
 * SELECT * FROM outbox_messages
 *  WHERE published_at IS NULL AND available_at <= ?
 *  ORDER BY available_at, id
 *  LIMIT ?
 * ```
 *
 * Ela existe para casar com `idx_outbox_unpublished (published_at,
 * available_at, id)`: o filtro por `published_at IS NULL` corta o índice no
 * bloco dos pendentes e a ordenação sai do próprio índice, sem `filesort`.
 */
export async function fetchUnpublishedOutboxMessages(
  db: Database,
  options: FetchUnpublishedOptions = {},
): Promise<OutboxMessage[]> {
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date();
  const query = db
    .select()
    .from(outboxMessages)
    .where(and(isNull(outboxMessages.publishedAt), lte(outboxMessages.availableAt, now)))
    .orderBy(asc(outboxMessages.availableAt), asc(outboxMessages.id))
    .limit(limit);

  if (options.lockForUpdate) {
    return query.for('update', { skipLocked: true });
  }
  return query;
}

/** Marca o lote como publicado. Chamado depois do broker confirmar. */
export async function markOutboxPublished(
  db: Database,
  ids: string[],
  publishedAt: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const result = await db
    .update(outboxMessages)
    .set({ publishedAt })
    .where(and(inArray(outboxMessages.id, ids), isNull(outboxMessages.publishedAt)));
  return result[0].affectedRows;
}

/**
 * Devolve o evento para a fila com nova janela de tentativa. O backoff
 * exponencial com jitter é responsabilidade de quem chama (`Docs/08`); aqui só
 * gravamos a decisão e o motivo.
 */
export async function rescheduleOutboxMessage(
  db: Database,
  id: string,
  availableAt: Date,
  lastError?: string,
): Promise<void> {
  await db
    .update(outboxMessages)
    .set({
      availableAt,
      attempts: sql`${outboxMessages.attempts} + 1`,
      lastError: lastError ?? null,
    })
    .where(and(inArray(outboxMessages.id, [id]), isNull(outboxMessages.publishedAt)));
}
