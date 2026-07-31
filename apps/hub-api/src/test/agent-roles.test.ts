/**
 * Papéis de agente da organização: autorização por rota, substituição em bloco
 * e isolamento entre organizações.
 *
 * Os dois testes que mais importam aqui:
 *
 * - **substituir é a forma de remover.** O corpo é a lista inteira, e um papel
 *   que não veio some. É o que torna a remoção visível na própria requisição,
 *   em vez de depender de alguém lembrar de chamar um `DELETE`.
 * - **o slug é por organização.** Duas organizações podem ter um papel com o
 *   mesmo id sem se enxergarem — se isso falhar, o `roles.yaml` de um cliente
 *   passa a valer no de outro.
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

interface AgentRoleListBody {
  data: {
    items: {
      id: string;
      organizationId: string;
      label: string;
      description: string;
      basedOn: string;
      skills: string[];
      systemPrompt: string | null;
    }[];
  };
}

/** Papel válido; cada caso estraga um campo por vez. */
function role(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'Gameplay PIE UE5 Test',
    description: 'Roda testes de gameplay em PIE e relata o que quebrou.',
    basedOn: 'tester',
    skills: ['unreal-mcp', 'test-driven-development'],
    ...overrides,
  };
}

describe.skipIf(!probe.ok)('papéis de agente', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let developer: RegisteredUser;
  let outsider: RegisteredUser;
  let organizationId: string;

  async function invite(roleSlug: string, name: string): Promise<RegisteredUser> {
    const email = uniqueEmail(roleSlug);
    const invitation = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email, role: roleSlug },
    });

    expect(invitation.statusCode, invitation.payload).toBe(201);

    await harness.authService.flushPendingMail();

    const mail = await lastMail(harness.mailDirectory, 'organization-invitation', email);

    expect(mail).toBeDefined();

    return registerAndLogin(harness, {
      name,
      email,
      password: `senha-de-${roleSlug}-do-teste`,
      invitationToken: tokenFromLink(mail!),
    });
  }

  async function setRole(userId: string, slug: string): Promise<void> {
    const found = await harness.app.db.manager.find(roles, {
      select: { id: true },
      where: { organizationId: IsNull(), slug },
      take: 1,
    });

    await harness.app.db.manager
      .createQueryBuilder()
      .update(organizationMembers)
      .set({ roleId: found[0]?.id ?? '' })
      .where('organization_id = :organizationId', { organizationId })
      .andWhere('user_id = :userId', { userId })
      .execute();
  }

  /** Substitui a lista da organização e devolve o que passou a valer. */
  async function replace(
    token: string,
    list: readonly Record<string, unknown>[],
    organization = organizationId,
  ): Promise<{ statusCode: number; payload: string }> {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organization}/agent-roles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { roles: list },
    });
  }

  async function list(token: string, organization = organizationId) {
    return harness.app.inject({
      method: 'GET',
      url: `/v1/organizations/${organization}/agent-roles`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_agent_roles' });

    owner = await registerAndLogin(harness, {
      name: 'Olivia Owner',
      email: uniqueEmail('owner'),
      password: 'senha-do-owner-de-papeis',
      organizationName: 'Papéis',
    });
    organizationId = owner.organizationId;

    developer = await invite('developer', 'Diana Developer');
    await setRole(developer.userId, 'developer');

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

  it('o id sai do rótulo quando não vem no corpo', async () => {
    const response = await replace(owner.accessToken, [role()]);

    expect(response.statusCode, response.payload).toBe(200);

    const [saved] = body<AgentRoleListBody>(response).data.items;

    expect(saved?.id).toBe('gameplay-pie-ue5-test');
    expect(saved?.organizationId).toBe(organizationId);
    expect(saved?.basedOn).toBe('tester');
    expect(saved?.skills).toEqual(['unreal-mcp', 'test-driven-development']);
    expect(saved?.systemPrompt).toBeNull();
  });

  it('um id enviado à mão é respeitado', async () => {
    const response = await replace(owner.accessToken, [
      role({ id: 'meu-papel', label: 'Outro nome' }),
    ]);

    expect(body<AgentRoleListBody>(response).data.items[0]?.id).toBe('meu-papel');
  });

  it('o papel que não veio na lista é removido', async () => {
    await replace(owner.accessToken, [
      role({ id: 'fica' }),
      role({ id: 'some', label: 'Vai sumir' }),
    ]);

    const after = await replace(owner.accessToken, [role({ id: 'fica' })]);

    expect(
      body<AgentRoleListBody>(after).data.items.map((entry) => entry.id),
    ).toEqual(['fica']);
  });

  it('uma lista vazia limpa a organização', async () => {
    await replace(owner.accessToken, [role()]);
    const emptied = await replace(owner.accessToken, []);

    expect(emptied.statusCode, emptied.payload).toBe(200);
    expect(body<AgentRoleListBody>(emptied).data.items).toEqual([]);
  });

  it('id repetido no mesmo corpo fica com o primeiro', async () => {
    const response = await replace(owner.accessToken, [
      role({ id: 'repetido', label: 'Primeiro' }),
      role({ id: 'repetido', label: 'Segundo' }),
    ]);

    const items = body<AgentRoleListBody>(response).data.items;

    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('Primeiro');
  });

  it('a releitura devolve o que foi gravado, ordenado por rótulo', async () => {
    await replace(owner.accessToken, [
      role({ id: 'zelador', label: 'Zelador' }),
      role({ id: 'analista', label: 'Analista' }),
    ]);

    const response = await list(owner.accessToken);

    expect(response.statusCode, response.payload).toBe(200);
    expect(body<AgentRoleListBody>(response).data.items.map((entry) => entry.label)).toEqual([
      'Analista',
      'Zelador',
    ]);
  });

  it('corpo inválido é recusado antes de gravar', async () => {
    for (const invalid of [
      role({ label: '' }),
      role({ description: '' }),
      // `custom` não é papel-base: um papel nomeado herda de um papel real.
      role({ basedOn: 'custom' }),
      role({ basedOn: 'destroyer' }),
      role({ skills: 'unreal-mcp' }),
      // Nome de skill segue o mesmo formato dos três hosts que leem SKILL.md.
      role({ skills: ['Unreal MCP'] }),
      role({ description: 'x'.repeat(241) }),
    ]) {
      const response = await replace(owner.accessToken, [invalid]);

      expect(response.statusCode, `deveria recusar: ${JSON.stringify(invalid)}`).toBe(400);
    }
  });

  describe('autorização', () => {
    it('developer lê, mas não escreve', async () => {
      const read = await list(developer.accessToken);

      expect(read.statusCode, read.payload).toBe(200);

      const write = await replace(developer.accessToken, [role({ id: 'do-dev' })]);

      expect(write.statusCode, write.payload).toBe(403);
    });

    it('quem não é da organização não lê nem escreve', async () => {
      expect((await list(outsider.accessToken)).statusCode).toBe(403);
      expect((await replace(outsider.accessToken, [role()])).statusCode).toBe(403);
    });

    it('sem credencial, nada', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/organizations/${organizationId}/agent-roles`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  it('o mesmo id em outra organização é outro papel', async () => {
    // A chave é `(organization_id, id)`. Sem isso, o `roles.yaml` de um cliente
    // passaria a valer no de outro só por usar o mesmo slug.
    await replace(owner.accessToken, [role({ id: 'compartilhado', label: 'Da casa' })]);
    await replace(
      outsider.accessToken,
      [role({ id: 'compartilhado', label: 'Da outra casa' })],
      outsider.organizationId,
    );

    const mine = await list(owner.accessToken);
    const theirs = await list(outsider.accessToken, outsider.organizationId);

    expect(body<AgentRoleListBody>(mine).data.items[0]?.label).toBe('Da casa');
    expect(body<AgentRoleListBody>(theirs).data.items[0]?.label).toBe('Da outra casa');
  });
});
