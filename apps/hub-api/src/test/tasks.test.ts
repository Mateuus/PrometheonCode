/**
 * Tarefas: criação, atualização e — o que de fato decide se o módulo presta —
 * a disputa pela reivindicação.
 *
 * Os três cenários que a suíte prova contra o MySQL real:
 *
 * 1. duas reivindicações simultâneas, um só vencedor;
 * 2. reivindicação vencida devolve a tarefa à fila e emite `task.released`;
 * 3. soltar tarefa alheia falha com `TASK_NOT_CLAIMED_BY_ACTOR`.
 */

import { newId, outboxMessages, projectMembers, tasks } from '@prometheon/database';
import { and, eq, sql } from 'drizzle-orm';
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

interface TaskBody {
  data: {
    id: string;
    status: string;
    version: number;
    tags: string[];
    dependsOn: string[];
    assigneeType: string;
    claim: { userId: string | null; expiresAt: string } | null;
  };
}

describe.skipIf(!probe.ok)('tarefas', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;
  let developer: RegisteredUser;
  let organizationId: string;
  let projectId: string;

  async function invite(role: string, name: string, inProject: boolean): Promise<RegisteredUser> {
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
    const account = await registerAndLogin(harness, {
      name,
      email,
      password: `senha-de-${role}-em-tarefas`,
      invitationToken: tokenFromLink(mail!),
    });

    if (inProject) {
      await harness.app.db.insert(projectMembers).values({
        id: newId(),
        organizationId,
        projectId,
        userId: account.userId,
        status: 'active',
      });
    }

    return account;
  }

  async function createTask(
    payload: Record<string, unknown> = {},
    token = owner.accessToken,
  ) {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Tarefa de teste', ...payload },
    });
  }

  async function claim(taskId: string, token: string, leaseSeconds = 900) {
    return harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${token}` },
      payload: { leaseSeconds },
    });
  }

  /** Envelhece a reivindicação direto no banco, para não esperar o relógio. */
  async function expireClaim(taskId: string): Promise<void> {
    await harness.app.db
      .update(tasks)
      .set({ claimExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(tasks.id, taskId));
  }

  async function eventsOf(taskId: string, eventType: string): Promise<number> {
    const rows = await harness.app.db
      .select({ total: sql<number>`count(*)` })
      .from(outboxMessages)
      .where(
        and(eq(outboxMessages.aggregateId, taskId), eq(outboxMessages.eventType, eventType)),
      );

    return Number(rows[0]?.total ?? 0);
  }

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_tasks' });

    owner = await registerAndLogin(harness, {
      name: 'Olivia Owner',
      email: uniqueEmail('owner'),
      password: 'senha-do-owner-de-tarefas',
      organizationName: 'Tarefas',
    });

    organizationId = owner.organizationId;

    const project = await harness.app.inject({
      method: 'POST',
      url: `/v1/organizations/${organizationId}/projects`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'Fila de trabalho' },
    });

    expect(project.statusCode, project.payload).toBe(201);

    projectId = body<{ data: { id: string } }>(project).data.id;

    developer = await invite('developer', 'Diana Developer', true);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  describe('criação', () => {
    it('cria em ready e grava task.created no outbox', async () => {
      const response = await createTask({ title: 'Escrever o worker', tags: ['infra'] });

      expect(response.statusCode, response.payload).toBe(201);

      const task = body<TaskBody>(response).data;

      expect(task.status).toBe('ready');
      expect(task.tags).toEqual(['infra']);
      expect(await eventsOf(task.id, 'task.created')).toBe(1);
    });

    it('nasce blocked quando depende de outra tarefa', async () => {
      const blocker = body<TaskBody>(await createTask({ title: 'Primeiro isto' })).data;
      const response = await createTask({ title: 'Depois isto', dependsOn: [blocker.id] });

      expect(response.statusCode, response.payload).toBe(201);

      const task = body<TaskBody>(response).data;

      expect(task.status).toBe('blocked');
      expect(task.dependsOn).toEqual([blocker.id]);
    });

    it('concluir a dependência libera quem estava blocked', async () => {
      const blocker = body<TaskBody>(await createTask({ title: 'Bloqueadora' })).data;
      const dependent = body<TaskBody>(
        await createTask({ title: 'Dependente', dependsOn: [blocker.id] }),
      ).data;

      expect(dependent.status).toBe('blocked');

      const done = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${blocker.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { status: 'done', version: blocker.version },
      });

      expect(done.statusCode, done.payload).toBe(200);

      const stored = await harness.app.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, dependent.id))
        .limit(1);

      expect(stored[0]?.status).toBe('ready');
      // A liberação também vira evento: quem escuta o WebSocket vê o trabalho
      // aparecer na fila sem precisar recarregar a lista inteira.
      expect(await eventsOf(dependent.id, 'task.updated')).toBe(1);
    });

    it('não libera quem ainda tem outra dependência em aberto', async () => {
      const first = body<TaskBody>(await createTask({ title: 'Primeira trava' })).data;
      const second = body<TaskBody>(await createTask({ title: 'Segunda trava' })).data;
      const dependent = body<TaskBody>(
        await createTask({ title: 'Espera as duas', dependsOn: [first.id, second.id] }),
      ).data;

      const done = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${first.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { status: 'done', version: first.version },
      });

      expect(done.statusCode, done.payload).toBe(200);

      const stored = await harness.app.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, dependent.id))
        .limit(1);

      expect(stored[0]?.status).toBe('blocked');
    });

    it('recusa dependência de fora do projeto', async () => {
      const other = await harness.app.inject({
        method: 'POST',
        url: `/v1/organizations/${organizationId}/projects`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Outro projeto' },
      });

      const otherProjectId = body<{ data: { id: string } }>(other).data.id;
      const foreign = await harness.app.inject({
        method: 'POST',
        url: `/v1/projects/${otherProjectId}/tasks`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { title: 'Tarefa alheia' },
      });

      const foreignId = body<TaskBody>(foreign).data.id;
      const response = await createTask({ title: 'Depende de fora', dependsOn: [foreignId] });

      expect(response.statusCode).toBe(400);
      expect(body<{ error: { code: string } }>(response).error.code).toBe('VALIDATION_FAILED');
    });

    it('números por projeto não colidem com criações simultâneas', async () => {
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) => createTask({ title: `Paralela ${String(index)}` })),
      );

      for (const response of responses) {
        expect(response.statusCode, response.payload).toBe(201);
      }

      const ids = responses.map((response) => body<TaskBody>(response).data.id);
      const rows = await harness.app.db
        .select({ number: tasks.number })
        .from(tasks)
        .where(eq(tasks.projectId, projectId));

      expect(new Set(rows.map((row) => row.number)).size).toBe(rows.length);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('PATCH /v1/tasks/:taskId', () => {
    it('respeita a concorrência otimista', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Para editar' })).data;

      const first = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${task.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { title: 'Editada', priority: 'high', version: task.version },
      });

      expect(first.statusCode, first.payload).toBe(200);
      expect(body<TaskBody>(first).data.version).toBe(task.version + 1);
      expect(await eventsOf(task.id, 'task.updated')).toBe(1);

      const stale = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${task.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { title: 'Atrasada', version: task.version },
      });

      expect(stale.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(stale).error.code).toBe('VERSION_CONFLICT');
    });

    it('trocar o responsável exige task.assign, que o developer não tem', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Para atribuir' })).data;

      const denied = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${task.id}`,
        headers: { authorization: `Bearer ${developer.accessToken}` },
        payload: { assigneeUserId: developer.userId, version: task.version },
      });

      expect(denied.statusCode).toBe(403);
      expect(body<{ error: { message: string } }>(denied).error.message).toContain('task.assign');

      // O mesmo developer edita o título sem problema: a permissão que falta é
      // só a de decidir de quem é o trabalho.
      const allowed = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${task.id}`,
        headers: { authorization: `Bearer ${developer.accessToken}` },
        payload: { title: 'Título ajustado', version: task.version },
      });

      expect(allowed.statusCode, allowed.payload).toBe(200);

      // E o owner, que tem `task.assign`, atribui.
      const assigned = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${task.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: {
          assigneeUserId: developer.userId,
          version: body<TaskBody>(allowed).data.version,
        },
      });

      expect(assigned.statusCode, assigned.payload).toBe(200);
      expect(body<TaskBody>(assigned).data.assigneeType).toBe('user');
    });
  });

  describe('claim', () => {
    it('duas pessoas ao mesmo tempo: exatamente uma ganha', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Disputada' })).data;

      // Uma tentativa por pessoa, disparadas juntas. Quem decide é o banco:
      // o `UPDATE` condicional da segunda transação não encontra mais a tarefa
      // disponível e não afeta linha nenhuma.
      const attempts = await Promise.all([
        claim(task.id, owner.accessToken),
        claim(task.id, developer.accessToken),
      ]);

      const winners = attempts.filter((attempt) => attempt.statusCode === 200);
      const losers = attempts.filter((attempt) => attempt.statusCode === 409);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(body<{ error: { code: string } }>(losers[0]!).error.code).toBe(
        'TASK_ALREADY_CLAIMED',
      );

      const holder = body<TaskBody>(winners[0]!).data.claim?.userId;

      const stored = await harness.app.db
        .select({ claimedByUserId: tasks.claimedByUserId, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);

      expect(stored[0]?.status).toBe('claimed');
      expect(stored[0]?.claimedByUserId).toBe(holder);
      // Um vencedor, um evento.
      expect(await eventsOf(task.id, 'task.claimed')).toBe(1);
    });

    it('uma rajada de tentativas deixa um único dono', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Muito disputada' })).data;

      const attempts = await Promise.all([
        claim(task.id, owner.accessToken),
        claim(task.id, developer.accessToken),
        claim(task.id, developer.accessToken),
        claim(task.id, owner.accessToken),
        claim(task.id, developer.accessToken),
        claim(task.id, owner.accessToken),
      ]);

      const winners = attempts.filter((attempt) => attempt.statusCode === 200);
      const losers = attempts.filter((attempt) => attempt.statusCode === 409);

      // Quem já é dono pode renovar o próprio prazo, então mais de um 200 é
      // legítimo — desde que todos sejam da **mesma** pessoa.
      expect(winners.length + losers.length).toBe(attempts.length);

      const holders = new Set(
        winners.map((winner) => body<TaskBody>(winner).data.claim?.userId),
      );

      expect(holders.size).toBe(1);

      for (const loser of losers) {
        expect(body<{ error: { code: string } }>(loser).error.code).toBe('TASK_ALREADY_CLAIMED');
      }

      const stored = await harness.app.db
        .select({ claimedByUserId: tasks.claimedByUserId })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);

      expect([...holders][0]).toBe(stored[0]?.claimedByUserId);
    });

    it('nega quem já perdeu a disputa, enquanto a reivindicação valer', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Ocupada' })).data;

      expect((await claim(task.id, owner.accessToken)).statusCode).toBe(200);

      const second = await claim(task.id, developer.accessToken);

      expect(second.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(second).error.code).toBe('TASK_ALREADY_CLAIMED');
    });

    it('reivindicação vencida libera a tarefa e emite task.released', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Abandonada' })).data;

      expect((await claim(task.id, owner.accessToken)).statusCode).toBe(200);

      await expireClaim(task.id);

      const before = await eventsOf(task.id, 'task.released');

      // Quem chega agora consegue assumir: a expiração é o que impede que
      // alguém que sumiu trave a tarefa para sempre.
      const taken = await claim(task.id, developer.accessToken);

      expect(taken.statusCode, taken.payload).toBe(200);
      expect(body<TaskBody>(taken).data.claim?.userId).toBe(developer.userId);
      // A devolução à fila também virou evento.
      expect(await eventsOf(task.id, 'task.released')).toBe(before + 1);
    });

    it('a listagem devolve à fila o que venceu, antes de responder', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Vencida na listagem' })).data;

      expect((await claim(task.id, owner.accessToken)).statusCode).toBe(200);

      await expireClaim(task.id);

      const list = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/tasks?limit=100`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });

      expect(list.statusCode, list.payload).toBe(200);

      const stored = await harness.app.db
        .select({ status: tasks.status, claimedByUserId: tasks.claimedByUserId })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);

      expect(stored[0]?.status).toBe('ready');
      expect(stored[0]?.claimedByUserId).toBeNull();
    });

    it('recusa reivindicar tarefa encerrada', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Encerrada' })).data;

      const done = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/tasks/${task.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { status: 'done', version: task.version },
      });

      expect(done.statusCode, done.payload).toBe(200);

      const response = await claim(task.id, owner.accessToken);

      expect(response.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(response).error.code).toBe('CONFLICT');
    });
  });

  describe('release', () => {
    it('solta a própria tarefa e grava task.released', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Para soltar' })).data;

      expect((await claim(task.id, owner.accessToken)).statusCode).toBe(200);

      const before = await eventsOf(task.id, 'task.released');
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/release`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { status: 'in_review' },
      });

      expect(response.statusCode, response.payload).toBe(200);

      const released = body<TaskBody>(response).data;

      expect(released.status).toBe('in_review');
      expect(released.claim).toBeNull();
      expect(await eventsOf(task.id, 'task.released')).toBe(before + 1);
    });

    it('falha com erro claro ao soltar tarefa de outra pessoa', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Alheia' })).data;

      expect((await claim(task.id, owner.accessToken)).statusCode).toBe(200);

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/release`,
        headers: { authorization: `Bearer ${developer.accessToken}` },
        payload: { status: 'ready' },
      });

      expect(response.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'TASK_NOT_CLAIMED_BY_ACTOR',
      );
    });

    it('falha ao soltar tarefa que ninguém reivindicou', async () => {
      const task = body<TaskBody>(await createTask({ title: 'Livre' })).data;

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/release`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { status: 'ready' },
      });

      expect(response.statusCode).toBe(409);
      expect(body<{ error: { code: string } }>(response).error.code).toBe(
        'TASK_NOT_CLAIMED_BY_ACTOR',
      );
    });
  });

  describe('autorização', () => {
    it('nega criação ao viewer, que não tem task.create', async () => {
      const viewer = await invite('viewer', 'Vera Viewer', true);

      const denied = await createTask({ title: 'Do viewer' }, viewer.accessToken);

      expect(denied.statusCode).toBe(403);
      expect(body<{ error: { message: string } }>(denied).error.message).toContain('task.create');

      // Ler, ele pode.
      const list = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      });

      expect(list.statusCode, list.payload).toBe(200);
    });

    it('nega o membro da organização que não é do projeto', async () => {
      const outsider = await invite('developer', 'Otto de Fora', false);

      const list = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });

      expect(list.statusCode).toBe(403);
      expect(body<{ error: { code: string } }>(list).error.code).toBe('PROJECT_ACCESS_DENIED');

      const created = await createTask({ title: 'De fora' }, outsider.accessToken);

      expect(created.statusCode).toBe(403);
    });

    it('nega sem credencial', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/tasks`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  it('pagina por cursor sem repetir nem pular tarefa', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        cursor === null
          ? `/v1/projects/${projectId}/tasks?limit=3`
          : `/v1/projects/${projectId}/tasks?limit=3&cursor=${encodeURIComponent(cursor)}`;

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
    } while (cursor !== null && pages < 40);

    const rows = await harness.app.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.projectId, projectId));

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(rows.map((row) => row.id).sort());
  });
});

describe.skipIf(probe.ok)('tarefas (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
