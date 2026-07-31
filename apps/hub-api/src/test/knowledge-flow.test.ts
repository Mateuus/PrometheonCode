/**
 * Conhecimento: proposta → revisão → aprovação (`Docs/10`).
 *
 * O que estes testes provam, contra MySQL e Redis reais:
 *
 * - aprovar **cria** versão nova e mantém a anterior legível como `superseded`;
 * - versão sem fonte declarada não é aprovável;
 * - quem propõe não aprova a própria proposta sem `knowledge.approve`;
 * - o revisor enxerga o diff em relação à versão vigente;
 * - `knowledge.proposed` e `knowledge.reviewed` chegam ao outbox.
 */

import {
  knowledgeVersions,
  newId,
  organizationMembers,
  organizations,
  outboxMessages,
  projects,
  roles,
  securityEvents,
  writable,
  type Organization,
} from '@prometheon/database';
import { IsNull } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createHarness,
  probeServices,
  registerAndLogin,
  uniqueEmail,
  type TestHarness,
} from './support.js';

const probe = await probeServices();

describe.skipIf(!probe.ok)('knowledge proposal, review and approval', () => {
  let harness: TestHarness;
  let owner: Awaited<ReturnType<typeof registerAndLogin>>;
  let projectId: string;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_knowtest' });
    owner = await registerAndLogin(harness, {
      name: 'Knowledge Owner',
      email: uniqueEmail('knowledge.owner'),
      password: 'Sup3r-S3nha-F0rte!',
      organizationName: 'Knowledge Org',
    });

    projectId = newId();

    await harness.app.db.manager.insert(projects, {
      id: projectId,
      organizationId: owner.organizationId,
      slug: 'brain',
      name: 'Brain',
      createdBy: owner.userId,
    });
  }, 180_000);

  afterAll(async () => {
    await harness.dispose();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function propose(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; item: KnowledgeItemBody }> {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/knowledge/proposals`,
      headers: auth(token),
      payload,
    });

    return {
      status: response.statusCode,
      item: body<{ data: KnowledgeItemBody }>(response).data,
    };
  }

  interface KnowledgeItemBody {
    id: string;
    status: string;
    version: number;
    currentVersionNumber: number | null;
    pendingVersionNumber: number | null;
    currentVersion: { versionNumber: number; content: string } | null;
    pendingVersion: { versionNumber: number; content: string } | null;
    sources: { origin: string }[];
  }

  const sourceFromFile = {
    type: 'file',
    reference: 'apps/hub-api/src/app.ts',
    locator: 'L1-L40',
    origin: 'extracted',
    confidence: 90,
  };

  it('creates a proposal that is not yet official', async () => {
    const created = await propose(owner.accessToken, {
      title: 'Ordem de registro dos plugins',
      category: 'architecture',
      origin: 'extracted',
      content: 'config\nlogger\nbanco\nredis\n',
      confidence: 80,
      tags: ['fastify'],
      sources: [sourceFromFile],
    });

    expect(created.status).toBe(201);
    expect(created.item.status).toBe('proposed');
    // A proposta ainda não vale: não há versão vigente.
    expect(created.item.currentVersionNumber).toBeNull();
    expect(created.item.pendingVersionNumber).toBe(1);
    expect(created.item.sources).toHaveLength(1);

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/knowledge?limit=10`,
      headers: auth(owner.accessToken),
    });

    expect(listed.statusCode).toBe(200);
    expect(
      body<{ data: { items: { id: string }[] } }>(listed).data.items.some(
        (item) => item.id === created.item.id,
      ),
    ).toBe(true);
  });

  it('approves a new version without losing the previous one', async () => {
    const first = await propose(owner.accessToken, {
      title: 'Política de retentativa das filas',
      category: 'decision',
      origin: 'human',
      content: 'tentativas: 3\nbackoff: exponencial\n',
      sources: [sourceFromFile],
    });

    const approved = await harness.app.inject({
      method: 'POST',
      url: `/v1/knowledge/${first.item.id}/review`,
      headers: auth(owner.accessToken),
      payload: { decision: 'approve', version: first.item.version },
    });

    expect(approved.statusCode).toBe(200);

    const afterFirst = body<{ data: { item: KnowledgeItemBody } }>(approved).data.item;

    expect(afterFirst.status).toBe('approved');
    expect(afterFirst.currentVersionNumber).toBe(1);

    // Segunda proposta sobre o mesmo item: é aqui que o versionamento é posto à
    // prova.
    const second = await propose(owner.accessToken, {
      knowledgeId: first.item.id,
      title: 'Política de retentativa das filas',
      category: 'decision',
      origin: 'human',
      content: 'tentativas: 5\nbackoff: exponencial com jitter\n',
      changeNote: 'jitter, conforme Docs/08',
      sources: [sourceFromFile],
    });

    expect(second.item.pendingVersionNumber).toBe(2);
    expect(second.item.currentVersionNumber).toBe(1);

    const diff = await harness.app.inject({
      method: 'GET',
      url: `/v1/knowledge/${first.item.id}/diff`,
      headers: auth(owner.accessToken),
    });

    expect(diff.statusCode).toBe(200);

    const diffBody = body<{
      data: {
        base: { versionNumber: number } | null;
        proposed: { versionNumber: number };
        added: number;
        removed: number;
        sources: unknown[];
      };
    }>(diff).data;

    // O revisor vê o que muda em relação ao que vale hoje, e as fontes.
    expect(diffBody.base?.versionNumber).toBe(1);
    expect(diffBody.proposed.versionNumber).toBe(2);
    expect(diffBody.added).toBeGreaterThan(0);
    expect(diffBody.removed).toBeGreaterThan(0);
    expect(diffBody.sources.length).toBeGreaterThan(0);

    const secondApproval = await harness.app.inject({
      method: 'POST',
      url: `/v1/knowledge/${first.item.id}/review`,
      headers: auth(owner.accessToken),
      payload: { decision: 'approve', version: second.item.version },
    });

    expect(secondApproval.statusCode).toBe(200);

    const afterSecond = body<{ data: { item: KnowledgeItemBody } }>(secondApproval).data.item;

    expect(afterSecond.currentVersionNumber).toBe(2);
    expect(afterSecond.currentVersion?.content).toContain('jitter');

    // A versão anterior continua no banco, íntegra e marcada como aposentada.
    const stored = await harness.app.db.manager.find(knowledgeVersions, {
      select: { versionNumber: true, status: true, content: true },
      where: { knowledgeItemId: first.item.id },
    });

    expect(stored).toHaveLength(2);

    const previous = stored.find((version) => version.versionNumber === 1);

    expect(previous?.status).toBe('superseded');
    expect(previous?.content).toContain('tentativas: 3');
  });

  it('refuses to approve a version without declared provenance', async () => {
    const created = await propose(owner.accessToken, {
      title: 'Afirmação sem fonte',
      category: 'lesson',
      origin: 'inferred',
      content: 'o serviço aguenta dez mil requisições por segundo',
      sources: [],
    });

    expect(created.status).toBe(201);

    const review = await harness.app.inject({
      method: 'POST',
      url: `/v1/knowledge/${created.item.id}/review`,
      headers: auth(owner.accessToken),
      payload: { decision: 'approve', version: created.item.version },
    });

    expect(review.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(review).error.code).toBe(
      'KNOWLEDGE_PROVENANCE_REQUIRED',
    );

    // Rejeitar continua possível: o problema é virar oficial sem procedência.
    const rejected = await harness.app.inject({
      method: 'POST',
      url: `/v1/knowledge/${created.item.id}/review`,
      headers: auth(owner.accessToken),
      payload: { decision: 'reject', version: created.item.version, comment: 'sem evidência' },
    });

    expect(rejected.statusCode).toBe(200);
  });

  it('refuses self approval when the author lacks knowledge.approve', async () => {
    // A política da organização é a camada mais alta do `Docs/09`: ela nega
    // `knowledge.approve` para todos, inclusive para o dono.
    await harness.app.db.manager
      .createQueryBuilder()
      .update(organizations)
      .set(writable<Organization>({ policy: { deny: ['knowledge.approve'] } }))
      .where('id = :id', { id: owner.organizationId })
      .execute();

    const reviewerRole = await harness.app.db.manager.find(roles, {
      select: { id: true },
      where: { slug: 'reviewer', organizationId: IsNull() },
      take: 1,
    });

    const teammate = await registerAndLogin(harness, {
      name: 'Knowledge Reviewer',
      email: uniqueEmail('knowledge.reviewer'),
      password: 'Sup3r-S3nha-F0rte!',
    });

    await harness.app.db.manager.insert(organizationMembers, {
      id: newId(),
      organizationId: owner.organizationId,
      userId: teammate.userId,
      roleId: reviewerRole[0]?.id ?? '',
      status: 'active',
      joinedAt: new Date(),
      createdBy: owner.userId,
    });

    try {
      const created = await propose(owner.accessToken, {
        title: 'Proposta do próprio dono',
        category: 'component',
        origin: 'human',
        content: 'texto',
        sources: [sourceFromFile],
      });

      const selfReview = await harness.app.inject({
        method: 'POST',
        url: `/v1/knowledge/${created.item.id}/review`,
        headers: auth(owner.accessToken),
        payload: { decision: 'approve', version: created.item.version },
      });

      expect(selfReview.statusCode, selfReview.payload).toBe(403);
      expect(
        body<{ error: { code: string; message: string } }>(selfReview).error.message,
      ).toContain('knowledge.approve');

      // A tentativa de carimbar a própria proposta vira evento de segurança.
      const events = await harness.app.db.manager.find(securityEvents, {
        select: { type: true },
        where: { organizationId: owner.organizationId },
      });

      expect(events.map((event) => event.type)).toContain('knowledge.self_approval_denied');

      // Outra pessoa, com `knowledge.review`, aprova normalmente: a restrição é
      // sobre carimbar o próprio trabalho, não sobre revisar.
      const teammateReview = await harness.app.inject({
        method: 'POST',
        url: `/v1/knowledge/${created.item.id}/review`,
        headers: auth(teammate.accessToken),
        payload: { decision: 'approve', version: created.item.version },
      });

      expect(teammateReview.statusCode, teammateReview.payload).toBe(200);
      expect(
        body<{ data: { item: KnowledgeItemBody } }>(teammateReview).data.item.currentVersionNumber,
      ).toBe(1);
    } finally {
      // A política volta ao normal mesmo se a asserção falhar: sem isto, um
      // teste vermelho contamina todos os seguintes.
      await harness.app.db.manager
        .createQueryBuilder()
        .update(organizations)
        .set({ policy: null })
        .where('id = :id', { id: owner.organizationId })
        .execute();
    }
  });

  it('refuses a review made against a stale version', async () => {
    const created = await propose(owner.accessToken, {
      title: 'Concorrência otimista na revisão',
      category: 'problem',
      origin: 'human',
      content: 'texto',
      sources: [sourceFromFile],
    });

    const stale = await harness.app.inject({
      method: 'POST',
      url: `/v1/knowledge/${created.item.id}/review`,
      headers: auth(owner.accessToken),
      payload: { decision: 'approve', version: created.item.version + 5 },
    });

    expect(stale.statusCode, stale.payload).toBe(409);
    expect(body<{ error: { code: string } }>(stale).error.code).toBe('KNOWLEDGE_REVIEW_CONFLICT');
  });

  it('writes the proposal and review events to the outbox', async () => {
    const created = await propose(owner.accessToken, {
      title: 'Evento no outbox',
      category: 'solution',
      origin: 'human',
      content: 'texto',
      sources: [sourceFromFile],
    });

    await harness.app.inject({
      method: 'POST',
      url: `/v1/knowledge/${created.item.id}/review`,
      headers: auth(owner.accessToken),
      payload: { decision: 'approve', version: created.item.version },
    });

    const events = await harness.app.db.manager.find(outboxMessages, {
      select: { eventType: true, aggregateId: true },
      where: { aggregateId: created.item.id },
    });

    const types = events.map((event) => event.eventType);

    expect(types).toContain('knowledge.proposed');
    expect(types).toContain('knowledge.reviewed');
  });
});

describe.skipIf(probe.ok)('conhecimento (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
