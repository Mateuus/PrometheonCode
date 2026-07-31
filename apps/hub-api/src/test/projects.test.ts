/**
 * Projetos: autorização por rota, isolamento por `project_members`,
 * concorrência otimista e paginação por cursor.
 *
 * O teste que mais importa aqui é o do isolamento: **ser da organização não é
 * ser do projeto**. Um `developer` do tenant que não participa do projeto não
 * pode ler o projeto nem o que existe dentro dele.
 */

import { newId, organizationMembers, projectMembers, roles } from '@prometheon/database';
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

interface ProjectBody {
  data: {
    id: string;
    slug: string;
    name: string;
    version: number;
    visibility: string;
    tags: string[];
    settings: { requireReview: boolean; defaultAutonomy: string };
  };
}

describe.skipIf(!probe.ok)('projetos', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let outsiderMember: RegisteredUser;
  let outsider: RegisteredUser;
  let organizationId: string;
  let projectId: string;

  /** Convida alguém pela rota real e devolve a conta já autenticada. */
  async function invite(role: string, name: string): Promise<RegisteredUser> {
    const email = uniqueEmail(role);
    const invitation = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email, role },
    });

    expect(invitation.statusCode, invitation.payload).toBe(201);

    await harness.authService.flushPendingMail();

    const mail = await lastMail(harness.mailDirectory, 'organization-invitation', email);

    expect(mail).toBeDefined();

    return registerAndLogin(harness, {
      name,
      email,
      password: `senha-de-${role}-do-teste`,
      invitationToken: tokenFromLink(mail!),
    });
  }

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
    harness = await createHarness({ prefix: 'prometheon_projects' });

    owner = await registerAndLogin(harness, {
      name: 'Olivia Owner',
      email: uniqueEmail('owner'),
      password: 'senha-do-owner-de-projetos',
      organizationName: 'Projetos',
    });

    organizationId = owner.organizationId;

    // Membro da organização com papel de escrita, mas fora do projeto.
    outsiderMember = await invite('developer', 'Diana Developer');

    outsider = await registerAndLogin(harness, {
      name: 'Otto Outsider',
      email: uniqueEmail('outsider'),
      password: 'senha-de-quem-nao-entra',
      organizationName: 'Outra Casa',
    });

    const created = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/projects`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Prometheon Core', tags: ['core', 'mvp'] },
    });

    expect(created.statusCode, created.payload).toBe(201);

    projectId = body<ProjectBody>(created).data.id;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  describe('POST /v1/organizations/:orgId/projects — exige project.create', () => {
    it('cria com slug derivado do nome e configuração conservadora', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/projects`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Integração Contínua' },
      });

      expect(response.statusCode, response.payload).toBe(201);

      const project = body<ProjectBody>(response).data;

      expect(project.slug).toBe('integracao-continua');
      // Projeto novo nasce no padrão mais fechado.
      expect(project.settings.requireReview).toBe(true);
      expect(project.settings.defaultAutonomy).toBe('manual');
    });

    it('recusa slug repetido na mesma organização', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/projects`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Outro nome', slug: 'prometheon-core' },
      });

      expect(response.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(response).error.code).toBe('PROJECT_SLUG_TAKEN');
    });

    it('nega o developer, que não tem project.create', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/projects`,
        headers: { authorization: `Bearer ${outsiderMember.accessToken}` },
        payload: { name: 'Projeto negado' },
      });

      expect(response.statusCode).toBe(403);

      const error = body<{ error: { code: string; message: string } }>(response).error;

      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.message).toContain('project.create');
    });

    it('nega quem não é da organização', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/projects`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
        payload: { name: 'Projeto invasor' },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'ORGANIZATION_ACCESS_DENIED',
      );
    });

    it('nega sem credencial', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/projects`,
        payload: { name: 'Projeto anônimo' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /v1/projects/:projectId — exige chat.read e participação', () => {
    it('permite quem criou o projeto', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(body<ProjectBody>(response).data.tags).toEqual(['core', 'mvp']);
    });

    it('nega o membro da organização que não participa do projeto', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${outsiderMember.accessToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'PROJECT_ACCESS_DENIED',
      );
    });

    it('nega quem não é da organização, sem chegar à camada de projeto', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'ORGANIZATION_ACCESS_DENIED',
      );
    });

    it('responde 404 para projeto inexistente', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/projects/01JQZZZZZZZZZZZZZZZZZZZZZZ',
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PATCH /v1/projects/:projectId — exige project.configure', () => {
    it('atualiza e respeita a concorrência otimista', async () => {
      const current = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      const version = body<ProjectBody>(current).data.version;

      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          name: 'Prometheon Core (renomeado)',
          settings: { requireReview: false, defaultAutonomy: 'auto' },
          version,
        },
      });

      expect(response.statusCode, response.payload).toBe(200);

      const updated = body<ProjectBody>(response).data;

      expect(updated.name).toBe('Prometheon Core (renomeado)');
      expect(updated.settings.requireReview).toBe(false);
      expect(updated.settings.defaultAutonomy).toBe('auto');
      expect(updated.version).toBe(version + 1);

      // A mesma versão não serve duas vezes.
      const stale = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Tentativa atrasada', version },
      });

      expect(stale.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(stale).error.code).toBe('VERSION_CONFLICT');
    });

    it('nega o developer mesmo depois de entrar no projeto', async () => {
      // O developer vira membro do projeto para provar que a negação vem da
      // permissão, e não da participação.
      await harness.app.db.manager
        .createQueryBuilder()
        .insert()
        .into(projectMembers)
        .values({
          id: newId(),
          organizationId,
          projectId,
          userId: outsiderMember.userId,
          status: 'active',
        })
        // `ON DUPLICATE KEY UPDATE status = VALUES(status)`: se o vínculo já
        // existe, ele volta a valer em vez de a inserção falhar pelo unique.
        .orUpdate(['status'])
        .execute();

      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        headers: { authorization: `Bearer ${outsiderMember.accessToken}` },
        payload: { name: 'Renomeado por quem não pode', version: 1 },
      });

      expect(response.statusCode).toBe(403);
      expect(body<{ error: { message: string } }>(response).error.message).toContain(
        'project.configure',
      );
    });
  });

  describe('GET /v1/organizations/:orgId/projects — pagina por cursor', () => {
    it('não repete nem pula item entre páginas', async () => {
      for (const name of ['Alfa', 'Bravo', 'Charlie', 'Delta']) {
        const created = await harness.app.inject({
          method: 'POST',
          url: `/v1/organizations/${organizationId}/projects`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
          payload: { name: `Paginação ${name}` },
        });

        expect(created.statusCode, created.payload).toBe(201);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const url: string =
          cursor === null
            ? `/v1/organizations/${organizationId}/projects?limit=2`
            : `/v1/organizations/${organizationId}/projects?limit=2&cursor=${encodeURIComponent(cursor)}`;

        const response = await harness.app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${owner.accessToken}` },
        });

        expect(response.statusCode, response.payload).toBe(200);

        const page = body<{
          data: { items: { id: string }[]; pageInfo: { nextCursor: string | null } };
        }>(response).data;

        seen.push(...page.items.map((item) => item.id));
        cursor = page.pageInfo.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 20);

      // Sem repetição⬦
      expect(new Set(seen).size).toBe(seen.length);
      // ⬦e sem faltar: o total bate com o que o dono enxerga de uma vez.
      const all = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/projects?limit=100`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      const allIds = body<{ data: { items: { id: string }[] } }>(all).data.items.map(
        (item) => item.id,
      );

      expect(seen.sort()).toEqual(allIds.sort());
    });

    it('o membro que não participa de projeto algum vê uma lista vazia', async () => {
      const solitary = await invite('reviewer', 'Rita Reviewer');

      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/projects`,
        headers: { authorization: `Bearer ${solitary.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(body<{ data: { items: unknown[] } }>(response).data.items).toEqual([]);
    });

    it('o admin enxerga todo projeto de visibilidade organization', async () => {
      const admin = await invite('developer', 'Adam Admin');

      await setRole(admin.userId, 'admin');

      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/projects?limit=100`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(
        body<{ data: { items: { id: string }[] } }>(response).data.items.length,
      ).toBeGreaterThan(0);
    });
  });
});

describe.skipIf(probe.ok)('projetos (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
