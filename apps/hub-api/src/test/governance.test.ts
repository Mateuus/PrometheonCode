/**
 * Planos, limites, auditoria e privacidade (`Docs/07`, `Docs/09`).
 *
 * O que estes testes provam, contra MySQL e Redis reais:
 *
 * - o limite do plano é **cobrado no servidor**: criar além do teto falha com
 *   erro que diz qual limite bateu;
 * - rebaixar para um plano que não comporta o uso atual é recusado;
 * - trocar o plano é ação auditada;
 * - a auditoria filtra e pagina sem repetir item;
 * - **não existe rota que altere ou apague auditoria**;
 * - o pacote de exportação não carrega hash de senha, token nem credencial.
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExport } from '@prometheon/hub-worker';
import {
  dataExportJobs,
  newId,
  organizationMembers,
  plans,
  projects,
  roles,
  securityEvents,
} from '@prometheon/database';
import { and, eq, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertPlanLimit } from '../modules/billing/limits.js';
import {
  body,
  createHarness,
  probeServices,
  registerAndLogin,
  uniqueEmail,
  type RegisteredUser,
  type TestHarness,
} from './support.js';

const probe = await probeServices();

describe.skipIf(!probe.ok)('planos, limites e governança', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let projectId: string;
  let tinyPlanId: string;
  const enqueuedJobIds: string[] = [];

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_govtest' });
    owner = await registerAndLogin(harness, {
      name: 'Governance Owner',
      email: uniqueEmail('governance.owner'),
      password: 'Sup3r-S3nha-F0rte!',
      organizationName: 'Governance Org',
    });

    projectId = newId();

    await harness.app.db.insert(projects).values({
      id: projectId,
      organizationId: owner.organizationId,
      slug: 'governance',
      name: 'Governance',
      createdBy: owner.userId,
    });

    // Plano apertado, criado só para provar que o teto é cobrado. Um plano de
    // teste é mais honesto que criar quinhentos itens para bater no teto real.
    tinyPlanId = newId();

    await harness.app.db.insert(plans).values({
      id: tinyPlanId,
      code: 'tiny',
      name: 'Tiny',
      description: 'Plano de teste com tetos baixos.',
      priceCents: 0,
      currency: 'USD',
      billingPeriod: 'none',
      maxMembers: 5,
      maxProjects: 1,
      maxKnowledgeItems: 1,
      maxAgentRunsPerMonth: 10,
      maxStorageBytes: 1_000,
      retentionDays: 7,
      isDefault: false,
      isActive: true,
    });
  }, 180_000);

  afterAll(async () => {
    // Os jobs enfileirados de verdade não podem ficar no Redis compartilhado.
    if (enqueuedJobIds.length > 0) {
      const config = harness.config;
      const redis =
        config.redis.url === undefined
          ? new Redis({
              host: config.redis.host ?? '127.0.0.1',
              port: config.redis.port,
              db: config.redis.db,
              ...(config.redis.password === undefined ? {} : { password: config.redis.password }),
              lazyConnect: true,
            })
          : new Redis(config.redis.url, { lazyConnect: true });

      try {
        await redis.connect();
        await redis.del(...enqueuedJobIds);
      } catch {
        // Limpeza é melhor esforço: o teste não falha por causa dela.
      } finally {
        redis.disconnect();
      }
    }

    await harness.dispose();
  });

  async function currentOrganizationVersion(): Promise<number> {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/organizations/${owner.organizationId}/subscription`,
      headers: auth(owner.accessToken),
    });

    return body<{ data: { subscription: { version: number } } }>(response).data.subscription
      .version;
  }

  async function proposeKnowledge(title: string) {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/knowledge/proposals`,
      headers: auth(owner.accessToken),
      payload: {
        title,
        category: 'decision',
        origin: 'human',
        content: `# ${title}`,
        sources: [{ type: 'file', reference: 'README.md', origin: 'extracted' }],
      },
    });
  }

  it('lists plans and the subscription with measured usage', async () => {
    const catalogue = await harness.app.inject({
      method: 'GET',
      url: '/v1/admin/plans',
      headers: auth(owner.accessToken),
    });

    expect(catalogue.statusCode).toBe(200);

    const codes = body<{ data: { plans: { code: string }[] } }>(catalogue).data.plans.map(
      (plan) => plan.code,
    );

    expect(codes).toContain('free');

    const overview = await harness.app.inject({
      method: 'GET',
      url: `/v1/organizations/${owner.organizationId}/subscription`,
      headers: auth(owner.accessToken),
    });

    expect(overview.statusCode).toBe(200);

    const data = body<{
      data: {
        plan: { code: string; limits: { maxProjects: number | null } };
        usage: { projects: number; members: number };
      };
    }>(overview).data;

    expect(data.plan.code).toBe('free');
    expect(data.usage.projects).toBe(1);
    expect(data.usage.members).toBeGreaterThanOrEqual(1);
  });

  it('audits the plan change and refuses a stale version', async () => {
    const version = await currentOrganizationVersion();

    const stale = await harness.app.inject({
      method: 'PUT',
      url: `/v1/organizations/${owner.organizationId}/plan`,
      headers: auth(owner.accessToken),
      payload: { planCode: 'tiny', version: version + 7 },
    });

    expect(stale.statusCode).toBe(409);

    const changed = await harness.app.inject({
      method: 'PUT',
      url: `/v1/organizations/${owner.organizationId}/plan`,
      headers: auth(owner.accessToken),
      payload: { planCode: 'tiny', version },
    });

    expect(changed.statusCode).toBe(200);
    expect(
      body<{ data: { plan: { code: string }; previousPlanCode: string } }>(changed).data.plan.code,
    ).toBe('tiny');

    const audit = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit?action=subscription.plan_changed',
      headers: auth(owner.accessToken),
    });

    expect(audit.statusCode).toBe(200);

    const entries = body<{
      data: { items: { action: string; metadata: Record<string, unknown> | null }[] };
    }>(audit).data.items;

    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata?.['previousPlanCode']).toBe('free');
    expect(entries[0]?.metadata?.['planCode']).toBe('tiny');
  });

  it('enforces the plan limit on creation, not only on screen', async () => {
    // O plano `tiny` permite um item de conhecimento. O primeiro passa.
    const first = await proposeKnowledge('Primeiro item');

    expect(first.statusCode).toBe(201);

    const second = await proposeKnowledge('Segundo item');

    expect(second.statusCode).toBe(409);

    const error = body<{
      error: { code: string; message: string; fields?: { path: string; message: string }[] };
    }>(second).error;

    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
    // A mensagem diz o teto, o consumo e o que fazer.
    expect(error.message).toContain('tiny');
    expect(error.message).toContain('knowledge items');
    expect(error.message).toMatch(/upgrade/i);
    expect(error.fields?.[0]?.path).toBe('maxKnowledgeItems');
  });

  it('enforces the project limit through the shared guard', async () => {
    // A rota de projetos ainda não existe; o guard que ela vai usar já existe,
    // e é ele que precisa estar certo.
    await expect(
      assertPlanLimit(harness.app.db, {
        organizationId: owner.organizationId,
        limit: 'maxProjects',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED', statusCode: 409 });

    // Uma nova versão de item existente não consome vaga nenhuma.
    await expect(
      assertPlanLimit(harness.app.db, {
        organizationId: owner.organizationId,
        limit: 'maxMembers',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a downgrade that does not fit the current usage', async () => {
    const reviewerRole = await harness.app.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.slug, 'reviewer'), isNull(roles.organizationId)))
      .limit(1);

    const teammate = await registerAndLogin(harness, {
      name: 'Governance Reviewer',
      email: uniqueEmail('governance.reviewer'),
      password: 'Sup3r-S3nha-F0rte!',
    });

    await harness.app.db.insert(organizationMembers).values({
      id: newId(),
      organizationId: owner.organizationId,
      userId: teammate.userId,
      roleId: reviewerRole[0]?.id ?? '',
      status: 'active',
      joinedAt: new Date(),
      createdBy: owner.userId,
    });

    const cramped = newId();

    await harness.app.db.insert(plans).values({
      id: cramped,
      code: 'solo',
      name: 'Solo',
      priceCents: 0,
      currency: 'USD',
      billingPeriod: 'none',
      maxMembers: 1,
      maxProjects: 10,
      maxKnowledgeItems: 10,
      maxAgentRunsPerMonth: 10,
      maxStorageBytes: 1_000,
      retentionDays: 7,
      isDefault: false,
      isActive: true,
    });

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/v1/organizations/${owner.organizationId}/plan`,
      headers: auth(owner.accessToken),
      payload: { planCode: 'solo', version: await currentOrganizationVersion() },
    });

    expect(response.statusCode).toBe(409);
    expect(body<{ error: { code: string; message: string } }>(response).error.message).toContain(
      'members',
    );
  });

  it('pages the audit log by cursor without repeating an item', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const url: string =
        cursor === null
          ? '/v1/audit?limit=2'
          : `/v1/audit?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await harness.app.inject({ method: 'GET', url, headers: auth(owner.accessToken) });

      expect(response.statusCode).toBe(200);

      const data = body<{
        data: { items: { id: string }[]; pageInfo: { nextCursor: string | null } };
      }>(response).data;

      seen.push(...data.items.map((item) => item.id));
      cursor = data.pageInfo.nextCursor;

      if (cursor === null) {
        break;
      }
    }

    expect(seen.length).toBeGreaterThan(2);
    // Nenhum identificador aparece duas vezes: é o que o cursor existe para
    // garantir, e o que `LIMIT ... OFFSET` não garante.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters the audit log by action, actor and period', async () => {
    const byAction = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit?action=knowledge.proposed',
      headers: auth(owner.accessToken),
    });

    const proposals = body<{ data: { items: { action: string }[] } }>(byAction).data.items;

    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((item) => item.action === 'knowledge.proposed')).toBe(true);

    const byActor = await harness.app.inject({
      method: 'GET',
      url: `/v1/audit?actorUserId=${owner.userId}&resourceType=knowledge`,
      headers: auth(owner.accessToken),
    });

    expect(
      body<{ data: { items: { resourceType: string }[] } }>(byActor).data.items.every(
        (item) => item.resourceType === 'knowledge',
      ),
    ).toBe(true);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const empty = await harness.app.inject({
      method: 'GET',
      url: `/v1/audit?from=${encodeURIComponent(future)}`,
      headers: auth(owner.accessToken),
    });

    expect(body<{ data: { items: unknown[] } }>(empty).data.items).toHaveLength(0);
  });

  it('exposes no route that changes or deletes audit records', () => {
    const table = harness.app.printRoutes({ commonPrefix: false });
    const auditLines = table
      .split('\n')
      .filter((line) => line.includes('/v1/audit') || line.includes('audit'));

    for (const line of auditLines) {
      expect(line).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    }
  });

  it('answers 404 to any attempt to write over the audit log', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await harness.app.inject({
        method,
        url: '/v1/audit',
        headers: auth(owner.accessToken),
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    }

    const deleteOne = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/audit/${newId()}`,
      headers: auth(owner.accessToken),
    });

    expect(deleteOne.statusCode).toBe(404);
  });

  it('reads security events for whoever has audit.read', async () => {
    await harness.app.db.insert(securityEvents).values({
      id: newId(),
      organizationId: owner.organizationId,
      userId: owner.userId,
      type: 'login_failed',
      severity: 'high',
      ip: '203.0.113.10',
      details: { attempts: 3 },
      occurredAt: new Date(),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit/security-events?severity=high',
      headers: auth(owner.accessToken),
    });

    expect(response.statusCode).toBe(200);

    const items = body<{ data: { items: { type: string; severity: string }[] } }>(response).data
      .items;

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.severity === 'high')).toBe(true);
  });

  it('queues an export whose bundle carries no credential column', async () => {
    const requested = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.organizationId}/exports`,
      headers: auth(owner.accessToken),
      payload: { scope: 'organization', format: 'json' },
    });

    expect(requested.statusCode).toBe(202);

    const job = body<{ data: { id: string; status: string } }>(requested).data;

    expect(job.status).toBe('pending');
    enqueuedJobIds.push(
      `{${harness.config.redis.keyPrefix}bull}:exports:export-${job.id}`,
    );

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/organizations/${owner.organizationId}/exports`,
      headers: auth(owner.accessToken),
    });

    expect(
      body<{ data: { items: { id: string }[] } }>(listed).data.items.some(
        (item) => item.id === job.id,
      ),
    ).toBe(true);

    // Roda o processador do worker contra o mesmo banco: o que interessa é o
    // conteúdo do pacote, não a viagem pela fila.
    const directory = await mkdtemp(join(tmpdir(), 'prometheon-export-test-'));
    const outcome = await runExport({
      db: harness.app.db,
      exportJobId: job.id,
      organizationId: owner.organizationId,
      exportsDir: directory,
      downloadTtlMs: 3_600_000,
    });

    expect(outcome.status).toBe('exported');

    const bundle = await readFile(join(directory, outcome.storageKey ?? ''), 'utf8');
    const parsed = JSON.parse(bundle) as { collections: Record<string, unknown[]> };

    expect(Object.keys(parsed.collections)).toContain('organizations');

    // Nenhuma coluna de credencial pode aparecer no pacote, em nenhum nível.
    for (const forbidden of [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'token_hash',
      'refreshToken',
      'secret',
      'accessToken',
      'encryptedToken',
    ]) {
      expect(bundle).not.toContain(forbidden);
    }

    const [stored] = await harness.app.db
      .select({ status: dataExportJobs.status })
      .from(dataExportJobs)
      .where(eq(dataExportJobs.id, job.id))
      .limit(1);

    expect(stored?.status).toBe('completed');
  });

  it('schedules a deletion with a grace window', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${owner.organizationId}/deletions`,
      headers: auth(owner.accessToken),
      payload: { targetType: 'project', targetId: projectId, reason: 'encerramento' },
    });

    expect(response.statusCode).toBe(202);

    const job = body<{ data: { id: string; status: string; scheduledFor: string } }>(response).data;

    expect(job.status).toBe('scheduled');
    expect(new Date(job.scheduledFor).getTime()).toBeGreaterThan(Date.now());
    enqueuedJobIds.push(
      `{${harness.config.redis.keyPrefix}bull}:deletions:deletion-${job.id}`,
    );

    const audited = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit?action=organization.deletion_requested',
      headers: auth(owner.accessToken),
    });

    expect(body<{ data: { items: unknown[] } }>(audited).data.items).toHaveLength(1);
  });
});

describe.skipIf(probe.ok)('planos, limites e governança (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
