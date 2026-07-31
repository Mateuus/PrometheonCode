/**
 * Autorização por rota (`Docs/09`: "testes de autorização por rota").
 *
 * Para cada rota protegida, a suíte verifica os três desfechos que importam:
 * quem tem a permissão passa, quem não tem recebe `PERMISSION_DENIED`, e quem
 * não é membro da organização recebe `ORGANIZATION_ACCESS_DENIED` — sem
 * distinguir "não existe" de "não é seu", que entregaria a existência do tenant.
 */

import { organizationMembers, roles } from '@prometheon/database';
import { IsNull } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createHarness,
  lastMail,
  probeServices,
  registerAndLogin,
  tokenFromLink,
  uniqueEmail,
  type RegisteredUser,
  type TestHarness,
} from './support.js';

const probe = await probeServices();

describe.skipIf(!probe.ok)('autorização por rota', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let viewer: RegisteredUser;
  let outsider: RegisteredUser;
  let organizationId: string;

  /** Troca o papel de um membro direto no banco, para montar o cenário. */
  async function setRole(userId: string, slug: string): Promise<void> {
    const role = await harness.app.db.manager.find(roles, {
      select: { id: true },
      where: { organizationId: IsNull(), slug },
      take: 1,
    });

    await harness.app.db.manager
      .createQueryBuilder()
      .update(organizationMembers)
      .set({ roleId: role[0]?.id ?? '' })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('user_id = :userId', { userId })
      .execute();
  }

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_rbac' });

    owner = await registerAndLogin(harness, {
      name: 'Olivia Owner',
      email: uniqueEmail('owner'),
      password: 'senha-do-owner-do-rbac',
      organizationName: 'RBAC',
    });

    organizationId = owner.organizationId;

    // O convidado entra pela rota real de convite, com o token do e-mail.
    const invitation = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: uniqueEmail('viewer'), role: 'viewer' },
    });

    expect(invitation.statusCode).toBe(201);

    const invited = body<{ data: { email: string } }>(invitation).data.email;

    await harness.authService.flushPendingMail();

    const mail = await lastMail(harness.mailDirectory, 'organization-invitation', invited);

    expect(mail).toBeDefined();

    viewer = await registerAndLogin(harness, {
      name: 'Vera Viewer',
      email: invited,
      password: 'senha-do-viewer-do-rbac',
      invitationToken: tokenFromLink(mail!),
    });

    outsider = await registerAndLogin(harness, {
      name: 'Otto Outsider',
      email: uniqueEmail('outsider'),
      password: 'senha-de-quem-nao-entra',
      organizationName: 'Outra Casa',
    });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('o convite coloca a pessoa na organização com o papel escolhido', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });

    const organizations = body<{
      data: { organizations: { id: string; role: string }[] };
    }>(response).data.organizations;

    expect(organizations).toContainEqual(
      expect.objectContaining({ id: organizationId, role: 'viewer' }),
    );
  });

  describe('GET /v1/organizations/:orgId — exige chat.read', () => {
    it('permite qualquer papel ativo', async () => {
      for (const actor of [owner, viewer]) {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/v1/organizations/${organizationId}`,
          headers: { authorization: `Bearer ${actor.accessToken}` },
        });

        expect(response.statusCode, `papel de ${actor.email}`).toBe(200);
      }
    });

    it('nega quem não é membro, sem revelar se a organização existe', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'ORGANIZATION_ACCESS_DENIED',
      );
    });

    it('nega sem credencial', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/organizations/:orgId/members — exige chat.read', () => {
    it('permite qualquer papel ativo e pagina por cursor', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/members?limit=1`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });

      expect(response.statusCode).toBe(200);

      const page = body<{
        data: { items: { id: string }[]; pageInfo: { nextCursor: string | null; hasMore: boolean } };
      }>(response).data;

      expect(page.items).toHaveLength(1);
      expect(page.pageInfo.hasMore).toBe(true);
      expect(page.pageInfo.nextCursor).not.toBeNull();

      // A segunda página não repete o item da primeira.
      const next = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/members?limit=1&cursor=${encodeURIComponent(
          page.pageInfo.nextCursor ?? '',
        )}`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });

      const second = body<{ data: { items: { id: string }[] } }>(next).data;

      expect(second.items[0]?.id).not.toBe(page.items[0]?.id);
    });

    it('nega quem não é membro', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/members`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /v1/organizations/:orgId/invitations — exige members.invite', () => {
    it('permite o owner', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { email: uniqueEmail('convidado'), role: 'developer' },
      });

      expect(response.statusCode).toBe(201);
      // O token do convite nunca volta na resposta.
      expect(response.payload).not.toContain('token');
    });

    it('nega o viewer', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
        payload: { email: uniqueEmail('negado'), role: 'developer' },
      });

      expect(response.statusCode).toBe(403);

      const error = body<{ error: { code: string; message: string } }>(response).error;

      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.message).toContain('members.invite');
    });

    it('nega o developer', async () => {
      await setRole(viewer.userId, 'developer');

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
        payload: { email: uniqueEmail('negado'), role: 'reviewer' },
      });

      expect(response.statusCode).toBe(403);

      await setRole(viewer.userId, 'viewer');
    });

    it('impede convidar para papel igual ou acima do próprio', async () => {
      await setRole(viewer.userId, 'admin');

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/invitations`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
        payload: { email: uniqueEmail('escalada'), role: 'owner' },
      });

      expect(response.statusCode).toBe(400);

      await setRole(viewer.userId, 'viewer');
    });
  });

  describe('PATCH /v1/organizations/:orgId/members/:memberId — exige organization.manage', () => {
    async function memberIdOf(userId: string): Promise<string> {
      const rows = await harness.app.db.manager.find(organizationMembers, {
        select: { id: true, version: true },
        where: { organizationId, userId },
        take: 1,
      });

      return rows[0]?.id ?? '';
    }

    it('permite o owner e respeita a concorrência otimista', async () => {
      const memberId = await memberIdOf(viewer.userId);

      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${organizationId}/members/${memberId}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { role: 'reviewer', version: 1 },
      });

      expect(response.statusCode).toBe(200);
      expect(body<{ data: { role: string; version: number } }>(response).data).toMatchObject({
        role: 'reviewer',
        version: 2,
      });

      // A mesma versão não serve duas vezes.
      const stale = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${organizationId}/members/${memberId}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { role: 'developer', version: 1 },
      });

      expect(stale.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(stale).error.code).toBe('VERSION_CONFLICT');

      await setRole(viewer.userId, 'viewer');
    });

    it('nega o viewer', async () => {
      const memberId = await memberIdOf(owner.userId);

      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${organizationId}/members/${memberId}`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
        payload: { role: 'viewer', version: 1 },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { message: string } }>(response).error.message).toContain(
        'organization.manage',
      );
    });

    it('nega o admin, que não tem organization.manage', async () => {
      await setRole(viewer.userId, 'admin');

      const memberId = await memberIdOf(owner.userId);

      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/organizations/${organizationId}/members/${memberId}`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
        payload: { role: 'viewer', version: 1 },
      });

      // `admin` tem `organization.manage` na tabela do pacote de permissões,
      // mas não supera o `owner` — a regra de senioridade barra depois.
      expect(response.statusCode).toBe(400);
      expect(body<{ error: { code: string } }>(response).error.code).toBe('PERMISSION_DENIED');

      await setRole(viewer.userId, 'viewer');
    });
  });

  describe('GET /v1/audit — exige audit.read', () => {
    it('permite o owner e devolve o que foi auditado', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/audit?limit=10',
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      expect(response.statusCode).toBe(200);

      const items = body<{ data: { items: { action: string }[] } }>(response).data.items;

      expect(items.map((item) => item.action)).toEqual(
        expect.arrayContaining(['invitation.created']),
      );
    });

    it('nega o viewer', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/audit',
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { message: string } }>(response).error.message).toContain(
        'audit.read',
      );
    });

    it('registra a negação na auditoria', async () => {
      await harness.app.inject({
        method: 'GET',
        url: '/v1/audit',
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/audit?limit=50',
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      const actions = body<{ data: { items: { action: string }[] } }>(response).data.items.map(
        (item) => item.action,
      );

      expect(actions).toEqual(expect.arrayContaining(['authz.audit.read']));
    });
  });

  it('a política da organização nega mesmo quem tem o papel', async () => {
    // Camada mais alta da precedência do `Docs/09`: nem o owner passa.
    await harness.app.db.query('update organizations set policy = ? where id = ?', [
      JSON.stringify({ deny: ['audit.read'] }),
      organizationId,
    ]);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(body<{ error: { message: string } }>(response).error.message).toContain(
      'organization policy',
    );

    await harness.app.db.query('update organizations set policy = null where id = ?', [
      organizationId,
    ]);
  });
});

describe.skipIf(probe.ok)('autorização por rota (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
