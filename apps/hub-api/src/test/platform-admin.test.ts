/**
 * Administração da plataforma e edição da organização.
 *
 * O que estes testes provam, contra MySQL e Redis reais:
 *
 * - **dono de organização não é administrador da plataforma.** Toda rota
 *   `/admin` responde 403 a quem só manda no próprio tenant — é a diferença
 *   entre administrar uma organização e decidir o preço de todas;
 * - o catálogo de planos é editável, e a edição chega ao teto que o servidor
 *   cobra;
 * - a exceção por organização vence o plano: o limite sobe para um tenant sem
 *   mexer nos outros;
 * - atribuir plano é manual e recusa o rebaixamento que deixaria o tenant acima
 *   do teto, a menos que a exceção seja pedida explicitamente;
 * - renomear a organização exige a versão lida, e excluir exige o endereço
 *   digitado de novo.
 */

import { newId, projects, users } from '@prometheon/database';
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

describe.skipIf(!probe.ok)('administração da plataforma', () => {
  let harness: TestHarness;
  let operator: RegisteredUser;
  let tenant: RegisteredUser;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_admintest' });

    operator = await registerAndLogin(harness, {
      name: 'Platform Operator',
      email: uniqueEmail('platform.operator'),
      password: 'Sup3r-S3nha-F0rte!',
      organizationName: 'Operator Org',
    });

    tenant = await registerAndLogin(harness, {
      name: 'Tenant Owner',
      email: uniqueEmail('tenant.owner'),
      password: 'Sup3r-S3nha-F0rte!',
      organizationName: 'Tenant Org',
    });

    // A marca não tem rota que a escreva: é concedida no banco, como em
    // produção (`db:grant-admin`). O guarda a lê a cada requisição, então o
    // token já emitido passa a valer como administrador sem novo login.
    await harness.app.db.manager.update(users, { id: operator.userId }, { isPlatformAdmin: true });
  }, 180_000);

  afterAll(async () => {
    await harness.dispose();
  });

  it('recusa quem administra apenas a própria organização', async () => {
    const routes = [
      { method: 'GET' as const, url: '/v1/admin/plans' },
      { method: 'GET' as const, url: '/v1/admin/organizations' },
      {
        method: 'PATCH' as const,
        url: `/v1/admin/organizations/${tenant.organizationId}/limits`,
        payload: { maxProjects: 999 },
      },
      {
        method: 'PUT' as const,
        url: `/v1/admin/organizations/${tenant.organizationId}/plan`,
        payload: { planCode: 'free' },
      },
    ];

    for (const route of routes) {
      const response = await harness.app.inject({
        method: route.method,
        url: route.url,
        headers: auth(tenant.accessToken),
        ...(route.payload === undefined ? {} : { payload: route.payload }),
      });

      expect(response.statusCode).toBe(403);
    }
  });

  it('cria e edita um plano, e o teto novo é o que o servidor cobra', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/plans',
      headers: auth(operator.accessToken),
      payload: {
        code: 'studio',
        name: 'Studio',
        priceCents: 4_900,
        currency: 'BRL',
        billingPeriod: 'monthly',
        limits: { maxProjects: 1, maxMembers: 10, maxKnowledgeItems: null },
        features: ['web_chat', 'remote_agents'],
      },
    });

    expect(created.statusCode).toBe(201);

    const plan = body<{ data: { plan: { code: string; limits: Record<string, number | null> } } }>(
      created,
    ).data.plan;

    expect(plan.code).toBe('studio');
    expect(plan.limits.maxProjects).toBe(1);
    // `null` no contrato é "sem teto", e é assim que ele volta.
    expect(plan.limits.maxKnowledgeItems).toBeNull();

    const assigned = await harness.app.inject({
      method: 'PUT',
      url: `/v1/admin/organizations/${tenant.organizationId}/plan`,
      headers: auth(operator.accessToken),
      payload: { planCode: 'studio' },
    });

    expect(assigned.statusCode).toBe(200);
    expect(
      body<{ data: { organization: { planCode: string } } }>(assigned).data.organization.planCode,
    ).toBe('studio');

    await harness.app.db.manager.insert(projects, {
      id: newId(),
      organizationId: tenant.organizationId,
      slug: `admin-${newId().slice(-6).toLowerCase()}`,
      name: 'Primeiro',
      createdBy: tenant.userId,
    });

    // Um projeto, teto de um: o próximo não passa.
    await expect(
      assertPlanLimit(harness.app.db, {
        organizationId: tenant.organizationId,
        limit: 'maxProjects',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' });

    const raised = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/admin/plans/studio',
      headers: auth(operator.accessToken),
      payload: { limits: { maxProjects: 5 } },
    });

    expect(raised.statusCode).toBe(200);

    // Sem novo login e sem cache: o teto cobrado é o que está no banco agora.
    await expect(
      assertPlanLimit(harness.app.db, {
        organizationId: tenant.organizationId,
        limit: 'maxProjects',
      }),
    ).resolves.toBeUndefined();
  });

  it('a exceção da organização vence o plano e volta atrás com null', async () => {
    const limited = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/admin/plans/studio',
      headers: auth(operator.accessToken),
      payload: { limits: { maxProjects: 1 } },
    });

    expect(limited.statusCode).toBe(200);

    const raised = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/organizations/${tenant.organizationId}/limits`,
      headers: auth(operator.accessToken),
      payload: { maxProjects: 50 },
    });

    expect(raised.statusCode).toBe(200);

    const view = body<{
      data: {
        organization: {
          limits: { maxProjects: number | null };
          overrides: { maxProjects: number | null; maxMembers: number | null };
        };
      };
    }>(raised).data.organization;

    expect(view.limits.maxProjects).toBe(50);
    expect(view.overrides.maxProjects).toBe(50);
    // O que não foi tocado continua valendo pelo plano.
    expect(view.overrides.maxMembers).toBeNull();

    await expect(
      assertPlanLimit(harness.app.db, {
        organizationId: tenant.organizationId,
        limit: 'maxProjects',
      }),
    ).resolves.toBeUndefined();

    // A mesma organização vê o teto que vale de fato na própria assinatura.
    const overview = await harness.app.inject({
      method: 'GET',
      url: `/v1/organizations/${tenant.organizationId}/subscription`,
      headers: auth(tenant.accessToken),
    });

    expect(
      body<{ data: { limits: { maxProjects: number | null } } }>(overview).data.limits.maxProjects,
    ).toBe(50);

    const restored = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/organizations/${tenant.organizationId}/limits`,
      headers: auth(operator.accessToken),
      payload: { maxProjects: null },
    });

    expect(restored.statusCode).toBe(200);
    expect(
      body<{ data: { organization: { limits: { maxProjects: number | null } } } }>(restored).data
        .organization.limits.maxProjects,
    ).toBe(1);
  });

  it('lista as organizações com uso medido e filtra por busca', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/admin/organizations?search=Tenant',
      headers: auth(operator.accessToken),
    });

    expect(response.statusCode).toBe(200);

    const items = body<{
      data: { items: { id: string; name: string; usage: { projects: number } }[] };
    }>(response).data.items;

    expect(items.some((item) => item.id === tenant.organizationId)).toBe(true);
    expect(items.every((item) => item.name.includes('Tenant'))).toBe(true);
  });

  it('recusa o rebaixamento que deixaria o tenant acima do teto, salvo exceção pedida', async () => {
    // Segundo projeto: agora o tenant não cabe num plano de um só.
    await harness.app.db.manager.insert(projects, {
      id: newId(),
      organizationId: tenant.organizationId,
      slug: `admin-${newId().slice(-6).toLowerCase()}`,
      name: 'Segundo',
      createdBy: tenant.userId,
    });

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/plans',
      headers: auth(operator.accessToken),
      payload: {
        code: 'micro',
        name: 'Micro',
        limits: { maxProjects: 1 },
      },
    });

    expect(created.statusCode).toBe(201);

    const refused = await harness.app.inject({
      method: 'PUT',
      url: `/v1/admin/organizations/${tenant.organizationId}/plan`,
      headers: auth(operator.accessToken),
      payload: { planCode: 'micro' },
    });

    expect(refused.statusCode).toBe(409);
    expect(body<{ error: { code: string } }>(refused).error.code).toBe('PLAN_LIMIT_EXCEEDED');

    // Quem administra a plataforma às vezes precisa mesmo assim; a exceção é
    // explícita e fica no registro de auditoria da rota.
    const forced = await harness.app.inject({
      method: 'PUT',
      url: `/v1/admin/organizations/${tenant.organizationId}/plan`,
      headers: auth(operator.accessToken),
      payload: { planCode: 'micro', allowOverLimit: true },
    });

    expect(forced.statusCode).toBe(200);
    expect(
      body<{ data: { organization: { planCode: string } } }>(forced).data.organization.planCode,
    ).toBe('micro');
  });
});

describe.skipIf(!probe.ok)('edição e exclusão da organização', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let neighbour: RegisteredUser;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function currentVersion(user: RegisteredUser): Promise<number> {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/organizations/${user.organizationId}`,
      headers: auth(user.accessToken),
    });

    return body<{ data: { version: number } }>(response).data.version;
  }

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_orgedittest' });

    owner = await registerAndLogin(harness, {
      name: 'Org Owner',
      email: uniqueEmail('org.owner'),
      password: 'Sup3r-S3nha-F0rte!',
      organizationName: 'Primeira Casa',
    });

    neighbour = await registerAndLogin(harness, {
      name: 'Neighbour Owner',
      email: uniqueEmail('neighbour.owner'),
      password: 'Sup3r-S3nha-F0rte!',
      organizationName: 'Casa Vizinha',
    });
  }, 180_000);

  afterAll(async () => {
    await harness.dispose();
  });

  it('renomeia e troca o endereço', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${owner.organizationId}`,
      headers: auth(owner.accessToken),
      payload: { name: 'Casa Nova', slug: 'casa-nova', version: await currentVersion(owner) },
    });

    expect(response.statusCode).toBe(200);

    const organization = body<{ data: { name: string; slug: string } }>(response).data;

    expect(organization.name).toBe('Casa Nova');
    expect(organization.slug).toBe('casa-nova');
  });

  it('recusa versão vencida e endereço já usado', async () => {
    const stale = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${owner.organizationId}`,
      headers: auth(owner.accessToken),
      payload: { name: 'Não vai', version: 1 },
    });

    expect(stale.statusCode).toBe(409);

    const neighbourSlug = body<{ data: { slug: string } }>(
      await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${neighbour.organizationId}`,
        headers: auth(neighbour.accessToken),
      }),
    ).data.slug;

    const taken = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${owner.organizationId}`,
      headers: auth(owner.accessToken),
      payload: { slug: neighbourSlug, version: await currentVersion(owner) },
    });

    expect(taken.statusCode).toBe(409);
  });

  it('exclui apenas com o endereço digitado de novo', async () => {
    const wrong = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${owner.organizationId}`,
      headers: auth(owner.accessToken),
      payload: { slug: 'casa-errada', version: await currentVersion(owner) },
    });

    expect(wrong.statusCode).toBe(400);

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/organizations/${owner.organizationId}`,
      headers: auth(owner.accessToken),
      payload: { slug: 'casa-nova', version: await currentVersion(owner) },
    });

    expect(removed.statusCode).toBe(200);

    // Some das listagens, e a leitura direta passa a não encontrar.
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/organizations',
      headers: auth(owner.accessToken),
    });

    const ids = body<{ data: { items: { id: string }[] } }>(listed).data.items.map(
      (item) => item.id,
    );

    expect(ids).not.toContain(owner.organizationId);
  });
});
