// Transactional Outbox (`Docs/08`).
//
// O fluxo é: o domínio grava a mudança e o evento na MESMA transação; o worker
// varre os não publicados, publica e marca `published_at`; o consumidor
// deduplica pelo `id`. Assim não existe estado gravado sem evento
// correspondente — e a entrega é pelo menos uma vez, nunca exatamente uma.
//
// O `id` é o ULID que vai no envelope do WebSocket (`evt_...`) e serve de
// cursor: ULID ordena por tempo, então `ORDER BY id` já é ordem de criação.

import { EntitySchema } from 'typeorm';

import {
  createdAt,
  jsonColumn,
  nullableUnsignedBigint,
  organizationId,
  primaryId,
  requiredText,
  requiredUlidColumn,
  requiredUtcDatetime,
  text,
  ulidColumn,
  utcDatetime,
} from './columns.js';

export interface OutboxMessage {
  /** Também é o `id` do envelope entregue aos consumidores. */
  id: string;
  organizationId: string;
  projectId: string | null;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number | null;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  occurredAt: Date;
  availableAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export const outboxMessages = new EntitySchema<OutboxMessage>({
  name: 'outbox_messages',
  tableName: 'outbox_messages',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    // Sem FK para `organizations`/`projects`: o evento precisa continuar
    // publicável mesmo que o agregado seja apagado logo depois da transação.
    projectId: ulidColumn('project_id'),
    aggregateType: requiredText('aggregate_type', 64),
    aggregateId: requiredUlidColumn('aggregate_id'),
    // Ordem dentro do agregado, para os consumidores que exigem sequência.
    aggregateSequence: nullableUnsignedBigint('aggregate_sequence'),
    // `task.updated`, `message.created`, … (lista de eventos do `Docs/08`).
    eventType: requiredText('event_type', 96),
    eventVersion: { type: 'int', name: 'event_version', nullable: false, default: 1 },
    payload: jsonColumn('payload', { nullable: false }),
    // Chave opcional de deduplicação na origem (idempotency key do comando).
    dedupeKey: text('dedupe_key', 191),
    occurredAt: requiredUtcDatetime('occurred_at'),
    // Quando o evento fica elegível para publicação. Backoff exponencial com
    // jitter empurra este campo para o futuro em vez de bloquear a fila.
    availableAt: requiredUtcDatetime('available_at'),
    // Nulo enquanto não publicado — é o que o índice do worker procura.
    publishedAt: utcDatetime('published_at'),
    attempts: { type: 'int', name: 'attempts', nullable: false, default: 0 },
    lastError: { type: 'text', name: 'last_error', nullable: true },
    createdAt: createdAt(),
  },
  uniques: [{ name: 'uq_outbox_dedupe_key', columns: ['dedupeKey'] }],
  indices: [
    // Índice do worker. A varredura é:
    //   WHERE published_at IS NULL AND available_at <= NOW(3)
    //   ORDER BY available_at, id
    //   LIMIT n FOR UPDATE SKIP LOCKED
    // `published_at` vem primeiro para o range scan cair direto no bloco dos
    // não publicados, que é pequeno mesmo com a tabela grande.
    { name: 'idx_outbox_unpublished', columns: ['publishedAt', 'availableAt', 'id'] },
    { name: 'idx_outbox_aggregate', columns: ['aggregateType', 'aggregateId', 'id'] },
    { name: 'idx_outbox_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});
