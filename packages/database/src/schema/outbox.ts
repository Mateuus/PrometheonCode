// Transactional Outbox (`Docs/08`).
//
// O fluxo é: o domínio grava a mudança e o evento na MESMA transação; o worker
// varre os não publicados, publica e marca `published_at`; o consumidor
// deduplica pelo `id`. Assim não existe estado gravado sem evento
// correspondente — e a entrega é pelo menos uma vez, nunca exatamente uma.
//
// O `id` é o ULID que vai no envelope do WebSocket (`evt_...`) e serve de
// cursor: ULID ordena por tempo, então `ORDER BY id` já é ordem de criação.

import {
  bigint,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

import {
  createdAt,
  organizationId,
  primaryId,
  ulidColumn,
  utcDatetime,
} from './columns.js';

export const outboxMessages = mysqlTable(
  'outbox_messages',
  {
    // Também é o `id` do envelope entregue aos consumidores.
    id: primaryId(),
    organizationId: organizationId(),
    // Sem FK para `organizations`/`projects`: o evento precisa continuar
    // publicável mesmo que o agregado seja apagado logo depois da transação.
    projectId: ulidColumn('project_id'),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: ulidColumn('aggregate_id').notNull(),
    // Ordem dentro do agregado, para os consumidores que exigem sequência.
    aggregateSequence: bigint('aggregate_sequence', { mode: 'number', unsigned: true }),
    // `task.updated`, `message.created`, … (lista de eventos do `Docs/08`).
    eventType: varchar('event_type', { length: 96 }).notNull(),
    eventVersion: int('event_version').notNull().default(1),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    // Chave opcional de deduplicação na origem (idempotency key do comando).
    dedupeKey: varchar('dedupe_key', { length: 191 }),
    occurredAt: utcDatetime('occurred_at').notNull(),
    // Quando o evento fica elegível para publicação. Backoff exponencial com
    // jitter empurra este campo para o futuro em vez de bloquear a fila.
    availableAt: utcDatetime('available_at').notNull(),
    // Nulo enquanto não publicado — é o que o índice do worker procura.
    publishedAt: utcDatetime('published_at'),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (table) => [
    // Índice do worker. A varredura é:
    //   WHERE published_at IS NULL AND available_at <= NOW(3)
    //   ORDER BY available_at, id
    //   LIMIT n FOR UPDATE SKIP LOCKED
    // `published_at` vem primeiro para o range scan cair direto no bloco dos
    // não publicados, que é pequeno mesmo com a tabela grande.
    index('idx_outbox_unpublished').on(table.publishedAt, table.availableAt, table.id),
    index('idx_outbox_aggregate').on(table.aggregateType, table.aggregateId, table.id),
    index('idx_outbox_org_created_at').on(table.organizationId, table.createdAt),
    uniqueIndex('uq_outbox_dedupe_key').on(table.dedupeKey),
  ],
);
