// Consulta que o worker do outbox roda em laço (`Docs/08`).
//
// O que precisa valer: só volta o que ainda não foi publicado, só o que já está
// disponível, na ordem de disponibilidade, respeitando o lote — e o índice
// `idx_outbox_unpublished` precisa estar ao alcance do otimizador.

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from './id.js';
import {
  enqueueOutboxMessage,
  fetchUnpublishedOutboxMessages,
  markOutboxPublished,
  rescheduleOutboxMessage,
} from './outbox.js';
import { outboxMessages } from './schema/outbox.js';
import { createDisposableDatabase, probeDatabase, type DisposableDatabase } from './test-support.js';

const probe = await probeDatabase();
if (!probe.reachable) {
  console.warn(
    `[outbox] MySQL inacessível — suíte pulada. Motivo: ${probe.reason ?? 'desconhecido'}`,
  );
}

const ORGANIZATION_ID = newId();
const BASE = new Date('2026-07-30T12:00:00.000Z');
const minutes = (value: number): Date => new Date(BASE.getTime() + value * 60_000);

describe.skipIf(!probe.reachable)('outbox do worker', () => {
  let temporary: DisposableDatabase;

  beforeAll(async () => {
    temporary = await createDisposableDatabase('prometheon_outbox_test');
  }, 180_000);

  afterAll(async () => {
    await temporary?.drop();
  }, 60_000);

  it('devolve apenas os pendentes já disponíveis, em ordem', async () => {
    const aggregateId = newId();
    const first = await enqueue(temporary, {
      aggregateId,
      eventType: 'task.created',
      availableAt: minutes(-10),
    });
    const second = await enqueue(temporary, {
      aggregateId,
      eventType: 'task.updated',
      availableAt: minutes(-5),
    });
    // Agendado para o futuro: backoff em andamento, não pode aparecer.
    await enqueue(temporary, {
      aggregateId,
      eventType: 'task.updated',
      availableAt: minutes(30),
    });
    // Já publicado: fora da varredura.
    const published = await enqueue(temporary, {
      aggregateId,
      eventType: 'task.claimed',
      availableAt: minutes(-20),
    });
    await markOutboxPublished(temporary.db, [published], minutes(-19));

    const pending = await fetchUnpublishedOutboxMessages(temporary.db, { now: BASE });
    expect(pending.map((message) => message.id)).toEqual([first, second]);
    expect(pending[0]?.eventType).toBe('task.created');
    expect(pending[0]?.payload).toEqual({ aggregateId });
  });

  it('respeita o tamanho do lote', async () => {
    const lote = await fetchUnpublishedOutboxMessages(temporary.db, { now: BASE, limit: 1 });
    expect(lote).toHaveLength(1);
  });

  it('marcar como publicado tira o evento da varredura e não remarca', async () => {
    const pendentes = await fetchUnpublishedOutboxMessages(temporary.db, { now: BASE });
    const ids = pendentes.map((message) => message.id);
    expect(ids.length).toBeGreaterThan(0);

    const marcados = await markOutboxPublished(temporary.db, ids, BASE);
    expect(marcados).toBe(ids.length);

    // Segunda passada: já estão publicados, nada a marcar (entrega pelo menos
    // uma vez; a deduplicação é do consumidor).
    expect(await markOutboxPublished(temporary.db, ids, BASE)).toBe(0);
    expect(await fetchUnpublishedOutboxMessages(temporary.db, { now: BASE })).toEqual([]);
  });

  it('reagendar adia a próxima tentativa e conta o erro', async () => {
    const id = await enqueue(temporary, {
      aggregateId: newId(),
      eventType: 'agent.updated',
      availableAt: minutes(-1),
    });

    await rescheduleOutboxMessage(temporary.db, id, minutes(60), 'broker fora do ar');

    expect(await fetchUnpublishedOutboxMessages(temporary.db, { now: BASE })).toEqual([]);
    const [message] = await temporary.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, id))
      .limit(1);
    expect(message?.attempts).toBe(1);
    expect(message?.lastError).toBe('broker fora do ar');

    // Passada a janela do backoff, o evento volta para a varredura.
    const later = await fetchUnpublishedOutboxMessages(temporary.db, { now: minutes(61) });
    expect(later.map((entry) => entry.id)).toContain(id);
  });

  it('a varredura enxerga o índice dedicado', async () => {
    const [rows] = await temporary.db.execute(sql`
      EXPLAIN SELECT * FROM outbox_messages
       WHERE published_at IS NULL AND available_at <= ${BASE}
       ORDER BY available_at, id
       LIMIT 100
    `);
    const plan = (rows as unknown as Record<string, unknown>[])[0] ?? {};
    const possible = String(plan['possible_keys'] ?? '');
    const used = String(plan['key'] ?? '');
    expect(`${possible} ${used}`).toContain('idx_outbox_unpublished');
  });
});

/** Insere um evento com os campos que os testes variam. */
async function enqueue(
  temporary: DisposableDatabase,
  input: { aggregateId: string; eventType: string; availableAt: Date },
): Promise<string> {
  return enqueueOutboxMessage(temporary.db, {
    organizationId: ORGANIZATION_ID,
    aggregateType: 'task',
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: { aggregateId: input.aggregateId },
    occurredAt: input.availableAt,
    availableAt: input.availableAt,
  });
}
