/**
 * Tempo real ponta a ponta (`Docs/08`), contra MySQL e Redis reais.
 *
 * A suíte prova as garantias do documento uma a uma, e cada teste é escrito para
 * falhar pelo motivo certo:
 *
 * - o handshake dos cinco passos;
 * - o evento que o **publicador do worker de verdade** grava no Redis chega ao
 *   cliente conectado — não uma imitação do envelope, o `OutboxPublisher`
 *   importado de `@prometheon/hub-worker`;
 * - reconexão com cursor recebe o que perdeu;
 * - cursor velho demais devolve aviso de perda de janela em vez de silêncio;
 * - conexão sem heartbeat é encerrada e a presença some;
 * - quem não tem acesso ao projeto não recebe os eventos dele, nem assinando a
 *   organização inteira;
 * - duas conexões da mesma pessoa, e o fechamento de uma.
 */

import { enqueueOutboxMessage, newId, projectMembers, projects } from '@prometheon/database';
import { child } from '@prometheon/logger';
import {
  createKeyNamespace,
  MetricsRegistry,
  OutboxPublisher,
  RedisLocker,
} from '@prometheon/hub-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PresenceStore } from '../modules/realtime/presence.js';
import { REALTIME_SETTINGS } from '../modules/realtime/settings.js';
import {
  call,
  createRealtimeHarness,
  realtimeToken,
  TestClient,
  type RealtimeHarness,
} from './realtime-support.js';
import { probeServices, registerAndLogin, uniqueEmail, type RegisteredUser } from './support.js';

const probe = await probeServices();

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Eventos de domínio recebidos, sem os de presença.
 *
 * Entrar numa organização já publica um `presence.changed` para o próprio
 * inscrito — é o comportamento correto, e é ruído em toda verificação que fala
 * de retomada por cursor.
 */
function domainEventIds(client: TestClient): string[] {
  return client.frames
    .filter(
      (frame) =>
        frame.type === 'event' &&
        (frame['event'] as { type: string }).type !== 'presence.changed',
    )
    .map((frame) => (frame['event'] as { id: string }).id);
}

/** ULID com um instante escolhido — é como se fabrica um cursor antigo. */
function ulidAt(milliseconds: number): string {
  let time = '';
  let remaining = milliseconds;

  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  return `${time}${newId().slice(10)}`;
}

describe.skipIf(!probe.ok)('realtime', () => {
  let harness: RealtimeHarness;
  let owner: RegisteredUser;
  /** Projeto de visibilidade `organization`: todo membro enxerga. */
  let openProjectId: string;
  /** Projeto privado, sem associação para o intruso. */
  let privateProjectId: string;
  let publisher: OutboxPublisher;

  /** Grava no outbox e roda o publicador do worker, como em produção. */
  async function publishThroughWorker(input: {
    eventType: string;
    projectId: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const id = await enqueueOutboxMessage(harness.app.db, {
      organizationId: owner.organizationId,
      projectId: input.projectId,
      aggregateType: 'task',
      aggregateId: newId(),
      eventType: input.eventType,
      payload: input.payload ?? { taskId: newId() },
    });

    await publisher.runOnce();

    return id;
  }

  beforeAll(async () => {
    harness = await createRealtimeHarness({ prefix: 'prometheon_rt' });
    owner = await registerAndLogin(harness, {
      name: 'Dona do Tempo Real',
      email: uniqueEmail('realtime'),
      password: 'senha-do-tempo-real-01',
      organizationName: 'Tempo Real',
    });

    openProjectId = newId();
    privateProjectId = newId();

    await harness.app.db.insert(projects).values([
      {
        id: openProjectId,
        organizationId: owner.organizationId,
        slug: `aberto-${openProjectId.slice(-6).toLowerCase()}`,
        name: 'Projeto Aberto',
        visibility: 'organization',
        createdBy: owner.userId,
      },
      {
        id: privateProjectId,
        organizationId: owner.organizationId,
        slug: `privado-${privateProjectId.slice(-6).toLowerCase()}`,
        name: 'Projeto Privado',
        visibility: 'private',
        createdBy: owner.userId,
      },
    ]);

    // A dona participa do projeto privado; o intruso do outro teste não.
    await harness.app.db.insert(projectMembers).values({
      id: newId(),
      organizationId: owner.organizationId,
      projectId: privateProjectId,
      userId: owner.userId,
      status: 'active',
      createdBy: owner.userId,
    });

    // O publicador de verdade, apontado para o mesmo prefixo de chave da suíte.
    publisher = new OutboxPublisher({
      db: harness.app.db,
      locker: new RedisLocker(harness.app.redis),
      keys: createKeyNamespace(harness.keyPrefix),
      logger: child('test-worker'),
      metrics: new MetricsRegistry(),
      publish: async (channel: string, payload: string) =>
        harness.app.redis.publish(channel, payload),
      batchSize: 50,
      pollIntervalMs: 50,
      idlePollIntervalMs: 50,
      lockTtlMs: 5_000,
      maxAttempts: 3,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
      lagSampleIntervalMs: 60_000,
    });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('completa o handshake dos cinco passos', async () => {
    // Passo 1.
    const issued = await call(harness, 'GET', '/v1/realtime/token', {
      token: owner.accessToken,
    });

    expect(issued.status).toBe(200);

    const data = issued.json['data'] as {
      token: string;
      expiresIn: number;
      url: string;
      protocolVersion: number;
      heartbeatIntervalMs: number;
    };

    expect(data.expiresIn).toBe(REALTIME_SETTINGS.tokenTtlSeconds);
    expect(data.protocolVersion).toBe(1);
    expect(data.url.startsWith('ws')).toBe(true);

    // Passo 2 e 3.
    const client = await TestClient.connect(harness.wsUrl, data.token);

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: '0.0.1-test',
      subscriptions: [
        { organizationId: owner.organizationId, projectId: null, eventTypes: [] },
      ],
      cursor: null,
    });

    // Passo 4.
    const welcome = await client.waitForType('welcome');

    expect(welcome['protocolVersion']).toBe(1);
    expect(welcome['resumeGap']).toBe(false);
    expect(welcome['resumeCursor']).toBeNull();
    expect(welcome['heartbeatIntervalMs']).toBe(REALTIME_SETTINGS.heartbeatIntervalMs);
    expect(typeof welcome['sessionId']).toBe('string');

    // O `ping` da aplicação existe para o cliente medir latência sem depender
    // do ping de protocolo, que o navegador não expõe.
    const sentAt = new Date().toISOString();

    client.send({ type: 'ping', sentAt });

    const pong = await client.waitForType('pong');

    expect(pong['sentAt']).toBe(sentAt);

    client.close();
    await client.waitForClose();
  });

  it('recusa o token de handshake reusado', async () => {
    const token = await realtimeToken(harness, owner.accessToken);
    const first = await TestClient.connect(harness.wsUrl, token);

    first.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: null, eventTypes: [] },
      ],
      cursor: null,
    });

    await first.waitForType('welcome');

    // O mesmo token de novo: o `jti` já foi queimado. O TCP chega a subir — o
    // servidor só descobre o replay depois do upgrade —, e o fechamento vem em
    // seguida, com o código de credencial recusada.
    const replay = await TestClient.connect(harness.wsUrl, token);

    expect(await replay.waitForClose()).toBe(4001);

    first.close();
    await first.waitForClose();
  });

  it('recusa versão de protocolo que não fala', async () => {
    const token = await realtimeToken(harness, owner.accessToken);
    const client = await TestClient.connect(harness.wsUrl, token);

    client.send({
      type: 'hello',
      protocolVersion: 99,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: null, eventTypes: [] },
      ],
      cursor: null,
    });

    const error = await client.waitForType('error');

    expect(error['code']).toBe('PROTOCOL_VERSION_UNSUPPORTED');
    expect(await client.waitForClose()).toBe(4003);
  });

  it('entrega ao cliente conectado o evento publicado pelo worker', async () => {
    const token = await realtimeToken(harness, owner.accessToken);
    const client = await TestClient.connect(harness.wsUrl, token);

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: openProjectId, eventTypes: [] },
      ],
      cursor: null,
    });

    await client.waitForType('welcome');

    const eventId = await publishThroughWorker({
      eventType: 'task.created',
      projectId: openProjectId,
    });

    const received = await client.waitFor(
      (frame) =>
        frame.type === 'event' && (frame['event'] as { id: string }).id === eventId,
    );

    const envelope = received['event'] as Record<string, unknown>;

    expect(envelope['type']).toBe('task.created');
    expect(envelope['organizationId']).toBe(owner.organizationId);
    expect(envelope['projectId']).toBe(openProjectId);
    // O `id` é o cursor: é ele que o cliente guarda para retomar.
    expect(envelope['cursor']).toBe(eventId);
    expect(typeof envelope['occurredAt']).toBe('string');

    client.close();
    await client.waitForClose();
  });

  it('retoma do cursor e entrega o que o cliente perdeu', async () => {
    // Um cursor de agora, antes de qualquer evento novo.
    const cursor = ulidAt(Date.now() - 1_000);

    const missedFirst = await publishThroughWorker({
      eventType: 'task.updated',
      projectId: openProjectId,
    });
    const missedSecond = await publishThroughWorker({
      eventType: 'task.claimed',
      projectId: openProjectId,
    });

    const token = await realtimeToken(harness, owner.accessToken);
    const client = await TestClient.connect(harness.wsUrl, token);

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: openProjectId, eventTypes: [] },
      ],
      cursor,
    });

    const welcome = await client.waitForType('welcome');

    expect(welcome['resumeGap']).toBe(false);
    expect(welcome['resumeCursor']).toBe(cursor);

    await client.waitFor(
      (frame) =>
        frame.type === 'event' && (frame['event'] as { id: string }).id === missedSecond,
    );

    const delivered = domainEventIds(client);

    expect(delivered).toContain(missedFirst);
    expect(delivered).toContain(missedSecond);
    // Ordem por cursor: o ULID cresce com o tempo.
    expect(delivered.indexOf(missedFirst)).toBeLessThan(delivered.indexOf(missedSecond));

    client.close();
    await client.waitForClose();
  });

  it('avisa perda de janela quando o cursor é antigo demais', async () => {
    const ancient = ulidAt(Date.now() - REALTIME_SETTINGS.resumeWindowMs - 60_000);
    const token = await realtimeToken(harness, owner.accessToken);
    const client = await TestClient.connect(harness.wsUrl, token);

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: openProjectId, eventTypes: [] },
      ],
      cursor: ancient,
    });

    const welcome = await client.waitForType('welcome');

    // O ponto do teste: o servidor **diz** que perdeu a janela em vez de fingir
    // que entregou tudo. O cliente recarrega por REST a partir daqui.
    expect(welcome['resumeGap']).toBe(true);

    expect(domainEventIds(client)).toHaveLength(0);

    // E a conexão continua útil: o que vier depois é entregue normalmente.
    const eventId = await publishThroughWorker({
      eventType: 'task.updated',
      projectId: openProjectId,
    });

    await client.waitFor(
      (frame) => frame.type === 'event' && (frame['event'] as { id: string }).id === eventId,
    );

    client.close();
    await client.waitForClose();
  });

  it('encerra a conexão sem heartbeat e tira a presença', async () => {
    const token = await realtimeToken(harness, owner.accessToken);
    const client = await TestClient.connect(harness.wsUrl, token);

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: openProjectId, eventTypes: [] },
      ],
      cursor: null,
    });

    await client.waitForType('welcome');

    const index = harness.realtime.keys.presenceOrganization(owner.organizationId);

    expect(
      await harness.realtime.presence.countConnections(index, owner.userId),
    ).toBeGreaterThan(0);

    // Relógio adiantado além do silêncio tolerado: é o que o servidor faria
    // sozinho depois de 75 segundos sem sinal.
    const dropped = harness.realtime.hub.checkHeartbeats(
      Date.now() + REALTIME_SETTINGS.connectionTimeoutMs + 1_000,
    );

    // Conexões de outros testes podem estar abertas; o que importa é que esta
    // foi derrubada por silêncio, com o código de timeout.
    expect(dropped.length).toBeGreaterThan(0);
    expect(await client.waitForClose()).toBe(4000);

    // A saída precisa aparecer no Redis, não só na memória do processo.
    await expect
      .poll(
        async () => harness.realtime.presence.countConnections(index, owner.userId),
        { timeout: 5_000 },
      )
      .toBe(0);
  });

  it('faz a presença expirar sozinha, sem ninguém removê-la', async () => {
    // TTL curto: o mecanismo é o mesmo do servidor, só o prazo muda. É este
    // teste que prova que fechar o notebook tira a pessoa da lista mesmo quando
    // nenhum `leave` chega a rodar.
    const store = new PresenceStore(harness.app.redis, 1_000);
    const index = `rt:presence:test:${newId()}`;
    const userId = newId();

    const joined = await store.join(index, userId, newId());

    expect(joined.becameOnline).toBe(true);
    expect(await store.list(index)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 1_300));

    // Ninguém chamou `leave`: o TTL venceu, e a leitura já não vê a entrada.
    expect(await store.list(index)).toHaveLength(0);
    expect(await store.countConnections(index, userId)).toBe(0);

    await store.purge(index);
  });

  it('mantém a pessoa online quando uma de duas conexões fecha', async () => {
    const index = harness.realtime.keys.presenceOrganization(owner.organizationId);
    const first = await TestClient.connect(
      harness.wsUrl,
      await realtimeToken(harness, owner.accessToken),
    );
    const second = await TestClient.connect(
      harness.wsUrl,
      await realtimeToken(harness, owner.accessToken),
    );

    const hello = {
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: null, eventTypes: [] },
      ],
      cursor: null,
    };

    first.send(hello);
    await first.waitForType('welcome');
    second.send(hello);
    await second.waitForType('welcome');

    expect(await harness.realtime.presence.countConnections(index, owner.userId)).toBe(2);

    // A segunda conexão vê a entrada da primeira? Não: ela entrou depois. O que
    // ela precisa ver é a **saída** — e com a contagem certa.
    second.close();
    await second.waitForClose();

    await expect
      .poll(
        async () => harness.realtime.presence.countConnections(index, owner.userId),
        { timeout: 5_000 },
      )
      .toBe(1);

    const presence = await first.waitFor(
      (frame) =>
        frame.type === 'event' &&
        (frame['event'] as { type: string }).type === 'presence.changed' &&
        ((frame['event'] as { data: { deviceCount: number } }).data.deviceCount === 1),
    );

    const data = (presence['event'] as { data: { status: string; userId: string } }).data;

    // Fechar uma aba não deixa ninguém offline.
    expect(data.status).toBe('online');
    expect(data.userId).toBe(owner.userId);

    first.close();
    await first.waitForClose();

    await expect
      .poll(
        async () => harness.realtime.presence.countConnections(index, owner.userId),
        { timeout: 5_000 },
      )
      .toBe(0);
  });

  it('não entrega os eventos de um projeto a quem não tem acesso a ele', async () => {
    // Um intruso: conta válida, organização própria, nenhum vínculo com a de
    // quem está publicando.
    const outsider = await registerAndLogin(harness, {
      name: 'De Fora',
      email: uniqueEmail('rt-fora'),
      password: 'senha-de-quem-esta-fora',
      organizationName: 'De Fora RT',
    });

    const token = await realtimeToken(harness, outsider.accessToken);
    const client = await TestClient.connect(harness.wsUrl, token);

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        // Organização alheia e projeto alheio: os dois precisam ser negados.
        { organizationId: owner.organizationId, projectId: openProjectId, eventTypes: [] },
      ],
      cursor: null,
    });

    const error = await client.waitForType('error');

    expect(error['code']).toBe('SUBSCRIPTION_DENIED');
    expect(await client.waitForClose()).toBe(4001);
  });

  it('não vaza projeto privado para quem assina a organização inteira', async () => {
    // Um membro da organização que **não** participa do projeto privado. Ele
    // assina a organização inteira, que é o caminho por onde o evento vazaria.
    const invitation = await call(
      harness,
      'POST',
      `/v1/organizations/${owner.organizationId}/invitations`,
      {
        token: owner.accessToken,
        body: { email: uniqueEmail('rt-membro'), role: 'developer', projectIds: [] },
      },
    );

    expect(invitation.status).toBe(201);

    const invited = (invitation.json['data'] as { email: string }).email;
    const member = await registerAndLogin(harness, {
      name: 'Membro Sem Projeto',
      email: invited,
      password: 'senha-do-membro-sem-projeto',
      invitationToken: await invitationToken(harness, invited),
    });

    const client = await TestClient.connect(
      harness.wsUrl,
      await realtimeToken(harness, member.accessToken),
    );

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId: null, eventTypes: [] },
      ],
      cursor: null,
    });

    await client.waitForType('welcome');

    const secret = await publishThroughWorker({
      eventType: 'task.created',
      projectId: privateProjectId,
    });
    const visible = await publishThroughWorker({
      eventType: 'task.created',
      projectId: openProjectId,
    });

    // Esperar o evento do projeto aberto é o que dá ao evento do projeto privado
    // tempo de chegar — se ele fosse chegar. Sem esta âncora o teste passaria
    // por ser rápido demais, não por estar correto.
    await client.waitFor(
      (frame) => frame.type === 'event' && (frame['event'] as { id: string }).id === visible,
    );

    const seen = domainEventIds(client);

    expect(seen).toContain(visible);
    expect(seen).not.toContain(secret);

    client.close();
    await client.waitForClose();
  });

  it('desconecta quando o acesso é revogado durante a conexão', async () => {
    const outsider = await registerAndLogin(harness, {
      name: 'Sessão Curta',
      email: uniqueEmail('rt-sessao'),
      password: 'senha-da-sessao-curta',
      organizationName: 'Sessão Curta',
    });

    const client = await TestClient.connect(
      harness.wsUrl,
      await realtimeToken(harness, outsider.accessToken),
    );

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: outsider.organizationId, projectId: null, eventTypes: [] },
      ],
      cursor: null,
    });

    await client.waitForType('welcome');

    // Logout revoga a sessão. Um token de realtime não pode sobreviver a isso.
    const loggedOut = await call(harness, 'POST', '/v1/auth/logout', {
      token: outsider.accessToken,
      body: { refreshToken: outsider.refreshToken },
    });

    expect(loggedOut.status).toBeLessThan(300);

    await harness.realtime.hub.revalidateAccess();

    expect(await client.waitForClose()).toBe(4001);
  });
});

/** Token do convite mais recente para um endereço, lido do e-mail capturado. */
async function invitationToken(harness: RealtimeHarness, email: string): Promise<string> {
  await harness.authService.flushPendingMail();

  const { lastMail, tokenFromLink } = await import('./support.js');
  const mail = await lastMail(harness.mailDirectory, 'organization-invitation', email);

  if (mail === undefined) {
    throw new Error(`Nenhum convite capturado para ${email}.`);
  }

  return tokenFromLink(mail);
}

describe.skipIf(probe.ok)('realtime (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
