// Consultas do Transactional Outbox usadas pelo worker (`Docs/08`).
//
// A gravação acontece dentro da transação do domínio — é isso que garante que
// não exista mudança sem evento. A publicação é um segundo passo, do worker,
// que varre os não publicados, publica e marca. Consumidor deduplica pelo `id`.

import { writable, type Database, type Executor, type TransactionExecutor } from './client.js';
import { outboxMessages, type OutboxMessage } from './entities/outbox.js';
import { newId } from './id.js';

export type { OutboxMessage } from './entities/outbox.js';

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
 * Grava o evento.
 *
 * O parâmetro é `TransactionExecutor`, não o `Database`: o tipo só existe dentro
 * de `runInTransaction()`, então **não há como gravar um evento fora da
 * transação do domínio** sem escrever o SQL na mão. É a garantia central do
 * padrão do outbox transformada em regra de compilação.
 *
 * ```ts
 * await runInTransaction(db, async (tx) => {
 *   await tx.update(tasks, { id: taskId }, { status: 'done' });
 *   await enqueueOutboxMessage(tx, { … });
 * });
 * ```
 */
export async function enqueueOutboxMessage(
  executor: TransactionExecutor,
  input: EnqueueOutboxInput,
): Promise<string> {
  const id = input.id ?? newId();
  const occurredAt = input.occurredAt ?? new Date();
  await executor.insert(
    outboxMessages,
    writable<OutboxMessage>({
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
      createdAt: new Date(),
    }),
  );
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
 * SELECT … FROM outbox_messages
 *  WHERE published_at IS NULL AND available_at <= ?
 *  ORDER BY available_at, id
 *  LIMIT ?
 * ```
 *
 * Ela existe para casar com `idx_outbox_unpublished (published_at,
 * available_at, id)`: o filtro por `published_at IS NULL` corta o índice no
 * bloco dos pendentes e a ordenação sai do próprio índice, sem `filesort`. A
 * forma da consulta é verificada por um teste que roda `EXPLAIN` — mexer na
 * ordenação ou no filtro reprova lá.
 */
export async function fetchUnpublishedOutboxMessages(
  db: Database | Executor,
  options: FetchUnpublishedOptions = {},
): Promise<OutboxMessage[]> {
  const limit = options.limit ?? 100;
  const now = options.now ?? new Date();
  const query = manager(db)
    .createQueryBuilder(outboxMessages, 'outbox')
    .where('outbox.publishedAt IS NULL')
    .andWhere('outbox.availableAt <= :now', { now })
    .orderBy('outbox.availableAt', 'ASC')
    .addOrderBy('outbox.id', 'ASC')
    .limit(limit);

  if (options.lockForUpdate) {
    query.setLock('pessimistic_write').setOnLocked('skip_locked');
  }
  return query.getMany();
}

/**
 * Marca o lote como publicado e devolve quantas linhas mudaram.
 *
 * `WHERE … AND published_at IS NULL` não é enfeite: é ele que denuncia a corrida
 * perdida. Se outro worker marcou a mesma mensagem entre a leitura e esta
 * escrita, nenhuma linha é afetada e quem chamou sabe que o evento saiu duas
 * vezes — comportamento previsto pela entrega "pelo menos uma vez". Ler antes e
 * escrever depois devolveria "publicado" para os dois workers.
 */
export async function markOutboxPublished(
  db: Database | Executor,
  ids: string[],
  publishedAt: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const result = await manager(db)
    .createQueryBuilder()
    .update(outboxMessages)
    .set({ publishedAt })
    .where('id IN (:...ids)', { ids })
    .andWhere('published_at IS NULL')
    .execute();
  return result.affected ?? 0;
}

/**
 * Devolve o evento para a fila com nova janela de tentativa. O backoff
 * exponencial com jitter é responsabilidade de quem chama (`Docs/08`); aqui só
 * gravamos a decisão e o motivo.
 *
 * O `published_at IS NULL` também está aqui: reagendar um evento que outro
 * worker acabou de publicar o faria sair uma segunda vez sem necessidade.
 */
export async function rescheduleOutboxMessage(
  db: Database | Executor,
  id: string,
  availableAt: Date,
  lastError?: string,
): Promise<void> {
  await manager(db)
    .createQueryBuilder()
    .update(outboxMessages)
    .set({
      availableAt,
      attempts: () => 'attempts + 1',
      lastError: lastError ?? null,
    })
    .where('id = :id', { id })
    .andWhere('published_at IS NULL')
    .execute();
}

/** Aceita tanto o `DataSource` quanto um `EntityManager` já aberto. */
function manager(db: Database | Executor): Executor {
  return 'manager' in db ? db.manager : db;
}
