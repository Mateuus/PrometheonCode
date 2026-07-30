// Publicador do outbox contra MySQL e Redis de verdade.
//
// O que estes testes precisam provar, e que só prova com serviço real:
//
// - dois workers concorrentes publicam o evento **uma vez só**;
// - a ordem dentro de um agregado é preservada;
// - falha de publicação vira retentativa com backoff, não perda;
// - tentativas esgotadas viram dead-letter, não laço infinito;
// - a métrica de atraso mede o que promete.
//
// Nada aqui toca `prometheon_dev`: o banco é descartável e o prefixo de chave é
// exclusivo desta execução, apagado no final.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueueOutboxMessage, newId, outboxMessages } from '@prometheon/database';
import { and, eq } from 'drizzle-orm';

import { createLogger } from '@prometheon/logger';

import { RedisLocker } from '../lock.js';
import { MetricsRegistry, METRIC } from '../metrics.js';
import { closeRedis, createRedisConnection, type RedisConnection } from '../redis.js';
import {
  cleanupKeyPrefix,
  createDisposableDatabase,
  disposableKeyPrefix,
  probeMysql,
  probeRedis,
  probeSettings,
  type DisposableDatabase,
} from '../testing/support.js';
import { DEAD_LETTER_PREFIX, OutboxPublisher, type OutboxDeadLetter } from './publisher.js';
import type { OutboxEnvelope } from './envelope.js';

const settingsProbe = probeSettings();
const mysqlProbe = await probeMysql();
const redisProbe = settingsProbe.settings === undefined
  ? { reachable: false, reason: settingsProbe.reason }
  : await probeRedis();

const unavailable = !mysqlProbe.reachable || !redisProbe.reachable;
if (unavailable) {
  console.warn(
    '[outbox] suíte pulada — ' +
      `mysql: ${mysqlProbe.reachable ? 'ok' : (mysqlProbe.reason ?? 'inacessível')}; ` +
      `redis: ${redisProbe.reachable ? 'ok' : (redisProbe.reason ?? 'inacessível')}`,
  );
}

// Logger silencioso: a suíte não é lugar de despejar linha de log.
const logger = createLogger({ level: 'silent', name: 'outbox-test' });

const ORGANIZATION_ID = newId();

describe.skipIf(unavailable)('publicador do outbox', () => {
  let temporary: DisposableDatabase;
  let commands: RedisConnection;
  let secondary: RedisConnection;
  let subscriber: RedisConnection;
  const keys = disposableKeyPrefix('outbox');
  const received: OutboxEnvelope[] = [];

  beforeAll(async () => {
    const settings = settingsProbe.settings;
    if (settings === undefined) {
      throw new Error(settingsProbe.reason ?? 'configuração indisponível');
    }
    temporary = await createDisposableDatabase('prometheon_worker_outbox');
    commands = createRedisConnection(settings.app.redis, { role: 'test-commands' });
    secondary = createRedisConnection(settings.app.redis, { role: 'test-commands-2' });
    subscriber = createRedisConnection(settings.app.redis, { role: 'test-subscriber' });

    subscriber.on('pmessage', (_pattern: string, _channel: string, payload: string) => {
      received.push(JSON.parse(payload) as OutboxEnvelope);
    });
    await subscriber.psubscribe(keys.realtimeChannelPattern);
  }, 180_000);

  afterAll(async () => {
    await subscriber?.punsubscribe(keys.realtimeChannelPattern).catch(() => undefined);
    if (commands !== undefined) {
      await cleanupKeyPrefix(commands, keys).catch(() => undefined);
    }
    await closeRedis(subscriber);
    await closeRedis(secondary);
    await closeRedis(commands);
    await temporary?.drop();
  }, 60_000);

  /** Publicador apontando para o banco descartável e o prefixo da suíte. */
  function createPublisher(
    redis: RedisConnection,
    overrides: Partial<{
      publish: (channel: string, payload: string) => Promise<number>;
      maxAttempts: number;
      onDeadLetter: (record: OutboxDeadLetter) => Promise<void>;
      metrics: MetricsRegistry;
    }> = {},
  ): OutboxPublisher {
    return new OutboxPublisher({
      db: temporary.db,
      locker: new RedisLocker(redis),
      keys,
      logger,
      metrics: overrides.metrics ?? new MetricsRegistry(),
      publish: overrides.publish ?? (async (channel, payload) => redis.publish(channel, payload)),
      onDeadLetter: overrides.onDeadLetter,
      batchSize: 100,
      pollIntervalMs: 50,
      idlePollIntervalMs: 100,
      lockTtlMs: 10_000,
      maxAttempts: overrides.maxAttempts ?? 8,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
      lagSampleIntervalMs: 1_000,
    });
  }

  async function enqueue(input: {
    aggregateId: string;
    eventType: string;
    sequence?: number;
    availableAt?: Date;
    occurredAt?: Date;
  }): Promise<string> {
    return enqueueOutboxMessage(temporary.db, {
      organizationId: ORGANIZATION_ID,
      aggregateType: 'task',
      aggregateId: input.aggregateId,
      aggregateSequence: input.sequence ?? null,
      eventType: input.eventType,
      payload: { taskId: input.aggregateId, sequence: input.sequence ?? null },
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.availableAt === undefined ? {} : { availableAt: input.availableAt }),
    });
  }

  /** Espera até a condição valer ou o prazo estourar. */
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function readRow(id: string): Promise<{
    publishedAt: Date | null;
    attempts: number;
    availableAt: Date;
    lastError: string | null;
  }> {
    const [row] = await temporary.db
      .select({
        publishedAt: outboxMessages.publishedAt,
        attempts: outboxMessages.attempts,
        availableAt: outboxMessages.availableAt,
        lastError: outboxMessages.lastError,
      })
      .from(outboxMessages)
      .where(eq(outboxMessages.id, id))
      .limit(1);
    if (row === undefined) {
      throw new Error(`linha ${id} não encontrada`);
    }
    return row;
  }

  it('publica cada evento uma única vez com dois workers concorrentes', async () => {
    const ids: string[] = [];
    for (let aggregate = 0; aggregate < 5; aggregate += 1) {
      const aggregateId = newId();
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        ids.push(await enqueue({ aggregateId, eventType: 'task.updated', sequence }));
      }
    }

    received.length = 0;
    const metricsA = new MetricsRegistry();
    const metricsB = new MetricsRegistry();
    const workerA = createPublisher(commands, { metrics: metricsA });
    const workerB = createPublisher(secondary, { metrics: metricsB });

    // Os dois varrem a mesma tabela ao mesmo tempo, como duas instâncias reais.
    const [resultA, resultB] = await Promise.all([workerA.runOnce(), workerB.runOnce()]);

    // Uma segunda volta cobre o que ficou para trás por disputa de lock.
    await workerA.runOnce();
    await workerB.runOnce();

    await waitFor(() => received.filter((event) => ids.includes(event.id)).length >= ids.length);

    const mine = received.filter((event) => ids.includes(event.id));
    const uniqueIds = new Set(mine.map((event) => event.id));

    expect(uniqueIds.size).toBe(ids.length);
    // A prova de "uma vez só": nenhum ID chegou duplicado ao assinante.
    expect(mine).toHaveLength(ids.length);
    expect(resultA.published + resultB.published).toBe(ids.length);

    for (const id of ids) {
      expect((await readRow(id)).publishedAt).not.toBeNull();
    }

    // O envelope carrega o que o `Docs/08` promete.
    const sample = mine[0];
    expect(sample).toBeDefined();
    expect(sample?.organizationId).toBe(ORGANIZATION_ID);
    expect(sample?.cursor).toBe(sample?.id);
    expect(sample?.type).toBe('task.updated');
    expect(sample?.version).toBe(1);
  });

  it('preserva a ordem dentro do agregado', async () => {
    const aggregateId = newId();
    const ids: string[] = [];
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      ids.push(await enqueue({ aggregateId, eventType: 'task.updated', sequence }));
    }

    const order: string[] = [];
    const publisher = createPublisher(commands, {
      publish: async (_channel, payload) => {
        order.push((JSON.parse(payload) as OutboxEnvelope).id);
        return 1;
      },
    });

    await publisher.runOnce();

    const mine = order.filter((id) => ids.includes(id));
    expect(mine).toEqual(ids);
  });

  it('ignora o que ainda não está disponível', async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const id = await enqueue({
      aggregateId: newId(),
      eventType: 'task.created',
      availableAt: future,
    });

    const publisher = createPublisher(commands, {
      publish: async () => {
        throw new Error('não deveria publicar evento agendado para o futuro');
      },
    });
    const result = await publisher.runOnce();

    expect(result.published).toBe(0);
    expect((await readRow(id)).publishedAt).toBeNull();
  });

  it('reagenda com backoff quando a publicação falha', async () => {
    const id = await enqueue({ aggregateId: newId(), eventType: 'task.updated' });
    const before = Date.now();

    const publisher = createPublisher(commands, {
      publish: async () => {
        throw new Error('broker indisponível');
      },
    });
    const result = await publisher.runOnce();

    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);

    const row = await readRow(id);
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('broker indisponível');
    // O backoff empurra a próxima tentativa para o futuro em vez de travar a fila.
    expect(row.availableAt.getTime()).toBeGreaterThan(before);
  });

  it('manda para a dead-letter quando as tentativas acabam', async () => {
    const id = await enqueue({ aggregateId: newId(), eventType: 'task.updated' });
    const abandoned: OutboxDeadLetter[] = [];

    const publisher = createPublisher(commands, {
      maxAttempts: 1,
      publish: async () => {
        throw new Error('broker recusou o evento');
      },
      onDeadLetter: async (record) => {
        abandoned.push(record);
      },
    });
    const result = await publisher.runOnce();

    expect(result.deadLettered).toBe(1);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.messageId).toBe(id);

    const row = await readRow(id);
    // Sai da varredura para não envenenar a métrica de atraso, mas o motivo
    // fica gravado — `published_at` aqui não significa "entregue".
    expect(row.publishedAt).not.toBeNull();
    expect(row.lastError?.startsWith(DEAD_LETTER_PREFIX)).toBe(true);
  });

  it('mede o atraso do evento pendente mais antigo', async () => {
    const metrics = new MetricsRegistry();
    const publisher = createPublisher(commands, { metrics });

    const occurredAt = new Date(Date.now() - 90_000);
    const id = await enqueue({
      aggregateId: newId(),
      eventType: 'task.created',
      occurredAt,
      availableAt: occurredAt,
    });

    const lag = await publisher.sampleLag();

    expect(lag.pending).toBeGreaterThanOrEqual(1);
    expect(lag.lagMs).toBeGreaterThanOrEqual(85_000);
    expect(metrics.gaugeValue(METRIC.outboxPending)).toBe(lag.pending);
    expect(metrics.gaugeValue(METRIC.outboxLagSeconds)).toBeCloseTo(lag.lagMs / 1_000, 0);

    // Publicado o mais antigo, o atraso cai — é o alarme desarmando. O que
    // sobra pendente são os agendados para o futuro pelos testes anteriores,
    // que por definição ainda não estão atrasados.
    await publisher.runOnce();
    const after = await publisher.sampleLag();
    expect((await readRow(id)).publishedAt).not.toBeNull();
    expect(after.lagMs).toBeLessThan(lag.lagMs);
    expect(after.pending).toBeLessThan(lag.pending);
  });

  it('a varredura usa o índice dos não publicados, sem filesort', async () => {
    const [plan] = await temporary.db.execute(
      // `EXPLAIN` da consulta exata do publicador.
      `EXPLAIN SELECT id FROM outbox_messages
         WHERE published_at IS NULL AND available_at <= NOW(3)
         ORDER BY available_at, id
         LIMIT 100`,
    );
    const row = (plan as unknown as Record<string, unknown>[])[0];
    expect(String(row?.['key'])).toBe('idx_outbox_unpublished');
    expect(String(row?.['Extra'] ?? '')).not.toContain('filesort');
  });

  it('não deixa lock pendurado depois da publicação', async () => {
    const id = await enqueue({ aggregateId: newId(), eventType: 'task.updated' });
    const publisher = createPublisher(commands);
    await publisher.runOnce();

    expect(await commands.exists(keys.outboxLock(id))).toBe(0);
    const [row] = await temporary.db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(and(eq(outboxMessages.id, id), eq(outboxMessages.attempts, 0)))
      .limit(1);
    expect(row?.id).toBe(id);
  });
});
