// Filas BullMQ contra MySQL e Redis de verdade.
//
// O que estes testes cobrem, e que não dá para conferir com fila falsa:
//
// - job idempotente rodado duas vezes com o mesmo `jobId` não repete o efeito;
// - falha permanente vai direto para a dead-letter, sem gastar tentativa;
// - falha transitória é retentada e só cai na dead-letter na última tentativa;
// - `retention`, `exports` e `deletions` fazem o que dizem no banco.
//
// O banco é descartável e o prefixo de chave é exclusivo desta execução.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';

import {
  auditLogs,
  dataExportJobs,
  deletionJobs,
  newId,
  outboxMessages,
  projects,
  type SeedResult,
} from '@prometheon/database';
import { createLogger } from '@prometheon/logger';

import { BACKOFF_STRATEGY } from './definitions.js';
import { listDeadLetters } from './processors/dead-letter.js';
import {
  cleanupKeyPrefix,
  createDisposableDatabase,
  disposableSettings,
  probeMysql,
  probeRedis,
  probeSettings,
  scanKeys,
  seedFixtures,
  type DisposableDatabase,
  type DisposableSettings,
} from '../testing/support.js';
import { createWorkerRuntime, type WorkerRuntime } from '../worker.js';

const settingsProbe = probeSettings();
const mysqlProbe = await probeMysql();
const redisProbe = settingsProbe.settings === undefined
  ? { reachable: false, reason: settingsProbe.reason }
  : await probeRedis();

const unavailable = !mysqlProbe.reachable || !redisProbe.reachable;
if (unavailable) {
  console.warn(
    '[jobs] suíte pulada — ' +
      `mysql: ${mysqlProbe.reachable ? 'ok' : (mysqlProbe.reason ?? 'inacessível')}; ` +
      `redis: ${redisProbe.reachable ? 'ok' : (redisProbe.reason ?? 'inacessível')}`,
  );
}

const logger = createLogger({ level: 'silent', name: 'jobs-test' });
const DAY_MS = 86_400_000;

describe.skipIf(unavailable)('filas do worker', () => {
  let temporary: DisposableDatabase;
  let disposable: DisposableSettings;
  let runtime: WorkerRuntime;
  let fixtures: SeedResult;

  beforeAll(async () => {
    const base = settingsProbe.settings;
    if (base === undefined) {
      throw new Error(settingsProbe.reason ?? 'configuração indisponível');
    }
    temporary = await createDisposableDatabase('prometheon_worker_jobs');
    fixtures = await seedFixtures(temporary.db);
    disposable = disposableSettings('jobs', base);

    runtime = createWorkerRuntime({
      settings: disposable.settings,
      database: { db: temporary.db, pool: temporary.pool },
      logger,
      onlyQueues: ['deletions', 'retention', 'exports', 'dead-letter'],
    });
    await runtime.start();
  }, 180_000);

  afterAll(async () => {
    if (runtime !== undefined) {
      await runtime.shutdown('fim da suíte');
    }
    if (disposable !== undefined) {
      const inspector = createWorkerRuntime({
        settings: disposable.settings,
        database: { db: temporary.db, pool: temporary.pool },
        logger,
        onlyQueues: [],
      });
      await cleanupKeyPrefix(inspector.deps.redis, disposable.keys).catch(() => undefined);
      await inspector.shutdown('limpeza');
      await disposable.cleanup();
    }
    await temporary?.drop();
  }, 120_000);

  /** Espera o job chegar a um estado terminal. */
  async function waitForFinish(
    queue: Queue,
    jobId: string,
    timeoutMs = 30_000,
  ): Promise<{ state: string; attemptsMade: number; returnvalue: unknown; failedReason?: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await queue.getJob(jobId);
      if (job !== undefined) {
        const state = await job.getState();
        if (state === 'completed' || state === 'failed') {
          return {
            state,
            attemptsMade: job.attemptsMade,
            returnvalue: job.returnvalue,
            ...(job.failedReason === undefined ? {} : { failedReason: job.failedReason }),
          };
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`job ${jobId} não terminou em ${String(timeoutMs)} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Espera aparecer um registro na dead-letter para a origem informada. */
  async function waitForDeadLetter(originId: string, timeoutMs = 20_000): Promise<{
    permanent: boolean;
    origin: string;
    errorCode: string;
    attemptsMade: number;
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entries = await listDeadLetters(runtime.deps.redis, disposable.keys, 100);
      const found = entries.find((entry) => entry.originId.includes(originId));
      if (found !== undefined) {
        return {
          permanent: found.permanent,
          origin: found.origin,
          errorCode: found.errorCode,
          attemptsMade: found.attemptsMade,
        };
      }
      if (Date.now() > deadline) {
        throw new Error(`nenhum registro de dead-letter para ${originId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function createProject(slug: string): Promise<string> {
    const id = newId();
    await temporary.db.insert(projects).values({
      id,
      organizationId: fixtures.organizationId,
      slug,
      name: slug,
    });
    return id;
  }

  async function countProjects(): Promise<number> {
    const [row] = await temporary.db
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(eq(projects.organizationId, fixtures.organizationId));
    return Number(row?.total ?? 0);
  }

  it('não duplica o efeito quando o mesmo jobId roda duas vezes', async () => {
    const doomed = await createProject('doomed-project');
    const survivor = await createProject('surviving-project');
    const deletionJobId = newId();

    await temporary.db.insert(deletionJobs).values({
      id: deletionJobId,
      organizationId: fixtures.organizationId,
      targetType: 'project',
      targetId: doomed,
      status: 'pending',
      scheduledFor: new Date(Date.now() - 60_000),
      reason: 'teste de idempotência',
    });

    const queue = runtime.queues.deletions;
    const jobId = `deletion-${deletionJobId}`;
    const payload = {
      correlationId: `test-${deletionJobId}`,
      organizationId: fixtures.organizationId,
      deletionJobId,
    };

    await queue.add('delete', payload, { jobId });
    const first = await waitForFinish(queue, jobId);

    expect(first.state).toBe('completed');
    expect(first.returnvalue).toMatchObject({ status: 'done' });
    expect(await countProjects()).toBe(1);

    // Segunda rodada: o job é removido da fila (como a limpeza faria) e
    // reenfileirado com o MESMO `jobId`. Sem a marca no Redis, o processador
    // rodaria de novo — e é justamente isso que não pode acontecer.
    const previous = await queue.getJob(jobId);
    await previous?.remove();
    await queue.add('delete', payload, { jobId });
    const second = await waitForFinish(queue, jobId);

    expect(second.state).toBe('completed');
    expect(second.returnvalue).toMatchObject({ status: 'skipped' });
    expect(await countProjects()).toBe(1);

    const [row] = await temporary.db
      .select({ status: deletionJobs.status })
      .from(deletionJobs)
      .where(eq(deletionJobs.id, deletionJobId))
      .limit(1);
    expect(row?.status).toBe('completed');

    const [remaining] = await temporary.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, survivor))
      .limit(1);
    expect(remaining?.id).toBe(survivor);
  });

  it('manda falha permanente direto para a dead-letter, sem retentativa', async () => {
    const missingId = newId();
    const queue = runtime.queues.deletions;
    const jobId = `deletion-missing-${missingId}`;

    await queue.add(
      'delete',
      {
        correlationId: `test-${missingId}`,
        organizationId: fixtures.organizationId,
        deletionJobId: missingId,
      },
      { jobId },
    );

    const result = await waitForFinish(queue, jobId);
    expect(result.state).toBe('failed');
    // A política da fila permite cinco tentativas; a permanente gasta uma só.
    expect(result.attemptsMade).toBe(1);
    expect(result.failedReason).toContain('inexistente');

    const record = await waitForDeadLetter(jobId);
    expect(record.permanent).toBe(true);
    expect(record.origin).toBe('deletions');
    expect(record.errorCode).toBe('DELETION_JOB_NOT_FOUND');
  });

  it('retenta a falha transitória e só a abandona na última tentativa', async () => {
    const target = await createProject('not-due-project');
    const deletionJobId = newId();

    await temporary.db.insert(deletionJobs).values({
      id: deletionJobId,
      organizationId: fixtures.organizationId,
      targetType: 'project',
      targetId: target,
      status: 'pending',
      // Ainda não venceu: o processador classifica como transitório.
      scheduledFor: new Date(Date.now() + 3 * DAY_MS),
      reason: 'teste de retentativa',
    });

    const queue = runtime.queues.deletions;
    const jobId = `deletion-not-due-${deletionJobId}`;

    await queue.add(
      'delete',
      {
        correlationId: `test-${deletionJobId}`,
        organizationId: fixtures.organizationId,
        deletionJobId,
      },
      // Duas tentativas com backoff curto: o teste não pode esperar o backoff
      // real da fila, mas a decisão exercitada é exatamente a mesma.
      { jobId, attempts: 2, backoff: { type: BACKOFF_STRATEGY, delay: 50 } },
    );

    const result = await waitForFinish(queue, jobId);
    expect(result.state).toBe('failed');
    // Provou que houve retentativa: a transitória não foi abandonada na primeira.
    expect(result.attemptsMade).toBe(2);
    expect(result.failedReason).toContain('não venceu');

    const record = await waitForDeadLetter(jobId);
    expect(record.permanent).toBe(false);
    expect(record.errorCode).toBe('DELETION_NOT_DUE');
    expect(record.attemptsMade).toBe(2);

    // O alvo sobreviveu: exclusão que não venceu não apaga nada.
    const [row] = await temporary.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, target))
      .limit(1);
    expect(row?.id).toBe(target);

    // Exatamente um registro para este job: a primeira falha não gerou nenhum.
    const entries = await listDeadLetters(runtime.deps.redis, disposable.keys, 200);
    expect(entries.filter((entry) => entry.originId.includes(jobId))).toHaveLength(1);
  });

  it('aplica a retenção respeitando a política do plano', async () => {
    const oldAuditId = newId();
    const freshAuditId = newId();
    const oldOutboxId = newId();

    await temporary.db.insert(auditLogs).values([
      {
        id: oldAuditId,
        organizationId: fixtures.organizationId,
        actorType: 'system',
        action: 'test.old',
        resourceType: 'test',
        // 400 dias: muito além dos 30 do plano gratuito.
        createdAt: new Date(Date.now() - 400 * DAY_MS),
      },
      {
        id: freshAuditId,
        organizationId: fixtures.organizationId,
        actorType: 'system',
        action: 'test.fresh',
        resourceType: 'test',
        createdAt: new Date(),
      },
    ]);

    await temporary.db.insert(outboxMessages).values({
      id: oldOutboxId,
      organizationId: fixtures.organizationId,
      aggregateType: 'task',
      aggregateId: newId(),
      eventType: 'task.updated',
      payload: {},
      occurredAt: new Date(Date.now() - 400 * DAY_MS),
      availableAt: new Date(Date.now() - 400 * DAY_MS),
      publishedAt: new Date(Date.now() - 400 * DAY_MS),
    });

    const queue = runtime.queues.retention;

    // Primeiro em modo seco: relata sem apagar.
    const dryRunId = `retention-dry-${newId()}`;
    await queue.add(
      'retention',
      { correlationId: dryRunId, dryRun: true },
      { jobId: dryRunId },
    );
    const dry = await waitForFinish(queue, dryRunId);
    expect(dry.state).toBe('completed');
    expect(dry.returnvalue).toMatchObject({ status: 'done' });
    expect((dry.returnvalue as { details?: { totalDeleted?: number } }).details?.totalDeleted)
      .toBeGreaterThanOrEqual(2);

    const [stillThere] = await temporary.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, oldAuditId))
      .limit(1);
    expect(stillThere?.id).toBe(oldAuditId);

    // Agora de verdade.
    const runId = `retention-run-${newId()}`;
    await queue.add('retention', { correlationId: runId }, { jobId: runId });
    const run = await waitForFinish(queue, runId);
    expect(run.state).toBe('completed');

    const survivors = await temporary.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.organizationId, fixtures.organizationId));
    const survivorIds = survivors.map((row) => row.id);
    expect(survivorIds).toContain(freshAuditId);
    expect(survivorIds).not.toContain(oldAuditId);

    const [purgedOutbox] = await temporary.db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.id, oldOutboxId))
      .limit(1);
    expect(purgedOutbox).toBeUndefined();
  });

  it('materializa a exportação no disco e fecha o job', async () => {
    const exportJobId = newId();
    await temporary.db.insert(dataExportJobs).values({
      id: exportJobId,
      organizationId: fixtures.organizationId,
      requestedByUserId: fixtures.ownerUserId,
      scope: 'organization',
      scopeId: fixtures.organizationId,
      format: 'json',
      status: 'pending',
    });

    const queue = runtime.queues.exports;
    const jobId = `export-${exportJobId}`;
    await queue.add(
      'export',
      {
        correlationId: `test-${exportJobId}`,
        organizationId: fixtures.organizationId,
        exportJobId,
      },
      { jobId },
    );

    const result = await waitForFinish(queue, jobId);
    expect(result.state).toBe('completed');
    expect(result.returnvalue).toMatchObject({ status: 'done' });

    const [row] = await temporary.db
      .select({
        status: dataExportJobs.status,
        storageKey: dataExportJobs.storageKey,
        sizeBytes: dataExportJobs.sizeBytes,
        downloadExpiresAt: dataExportJobs.downloadExpiresAt,
        completedAt: dataExportJobs.completedAt,
      })
      .from(dataExportJobs)
      .where(eq(dataExportJobs.id, exportJobId))
      .limit(1);

    expect(row?.status).toBe('completed');
    expect(row?.storageKey).toBeTruthy();
    expect(Number(row?.sizeBytes ?? 0)).toBeGreaterThan(0);
    expect(row?.downloadExpiresAt).not.toBeNull();
    expect(row?.completedAt).not.toBeNull();

    const path = join(disposable.settings.storage.exportsDir, row?.storageKey ?? '');
    const bundle = JSON.parse(await readFile(path, 'utf8')) as {
      scope: string;
      collections: Record<string, unknown[]>;
    };
    expect(bundle.scope).toBe('organization');
    expect(bundle.collections['organizations']).toHaveLength(1);
    // Nada de segredo no pacote: o hash da senha nem aparece na lista de colunas.
    expect(JSON.stringify(bundle)).not.toContain('passwordHash');
  });

  it('registra na dead-letter tudo que foi abandonado', async () => {
    const entries = await listDeadLetters(runtime.deps.redis, disposable.keys, 200);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      expect(entry.source).toBe('queue');
      expect(entry.failedAt).toBeTruthy();
      expect(entry.errorMessage.length).toBeGreaterThan(0);
    }
  });

  it('mantém a marca de idempotência sob o prefixo da suíte', async () => {
    const marks = await scanKeys(runtime.deps.redis, `${disposable.keys.prefix}jobs:done:*`);
    // A exclusão e a exportação são idempotentes e deixaram marca; a retenção,
    // que é recorrente por natureza, não deixa.
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks.every((key) => key.startsWith(disposable.keys.prefix))).toBe(true);
    expect(marks.some((key) => key.includes(':jobs:done:deletions:'))).toBe(true);
    expect(marks.some((key) => key.includes(':jobs:done:exports:'))).toBe(true);
    expect(marks.some((key) => key.includes(':jobs:done:retention:'))).toBe(false);
  });
});
