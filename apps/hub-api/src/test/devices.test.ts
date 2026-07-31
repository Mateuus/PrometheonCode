/**
 * Registro, heartbeat e lista de agentes ativos (`Docs/06`), contra MySQL e
 * Redis reais.
 *
 * O que a suíte cobre e por quê:
 *
 * - registro idempotente pela impressão da instalação — reinstalar a extensão
 *   não pode multiplicar linhas em `devices`;
 * - o heartbeat alimenta `agents/active` e emite `device.changed` para quem está
 *   conectado;
 * - **dispositivo que para de bater sai da lista sozinho**, que é o mesmo
 *   critério da presença: uma lista de agentes ativos com agentes mortos deixa
 *   de ser consultada;
 * - projeto sem acesso é recusado antes de qualquer escrita;
 * - uma credencial de dispositivo só fala pelo próprio dispositivo.
 */

import { newId, projectMembers, projects } from '@prometheon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEVICE_SETTINGS } from '../modules/devices/settings.js';
import {
  call,
  createRealtimeHarness,
  realtimeToken,
  TestClient,
  type RealtimeHarness,
} from './realtime-support.js';
import { probeServices, registerAndLogin, uniqueEmail, type RegisteredUser } from './support.js';

const probe = await probeServices();

interface DeviceBody {
  data: {
    id: string;
    organizationId: string;
    name: string;
    kind: string;
    platform: string | null;
    status: string;
    owner: { id: string };
    version: number;
  };
}

describe.skipIf(!probe.ok)('devices', () => {
  let harness: RealtimeHarness;
  let owner: RegisteredUser;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    // `prometheon_devices`, e não `prometheon_dev`: um prefixo que é prefixo do
    // banco de desenvolvimento convida a um `DROP` errado numa limpeza manual.
    harness = await createRealtimeHarness({ prefix: 'prometheon_devices' });
    owner = await registerAndLogin(harness, {
      name: 'Dono do Dispositivo',
      email: uniqueEmail('devices'),
      password: 'senha-dos-dispositivos-01',
      organizationName: 'Dispositivos',
    });

    projectId = newId();
    otherProjectId = newId();

    await harness.app.db.manager.insert(projects, [
      {
        id: projectId,
        organizationId: owner.organizationId,
        slug: `dev-${projectId.slice(-6).toLowerCase()}`,
        name: 'Projeto dos Dispositivos',
        visibility: 'organization',
        createdBy: owner.userId,
      },
      {
        id: otherProjectId,
        organizationId: owner.organizationId,
        slug: `fechado-${otherProjectId.slice(-6).toLowerCase()}`,
        name: 'Projeto Fechado',
        visibility: 'private',
        createdBy: owner.userId,
      },
    ]);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  async function registerDevice(installationId: string, name = 'VS Code do teste'): Promise<DeviceBody['data']> {
    const response = await call(harness, 'POST', '/v1/devices/register', {
      token: owner.accessToken,
      body: {
        name,
        kind: 'vscode',
        platform: 'windows',
        clientVersion: '0.1.0',
        installationId,
      },
    });

    expect(response.status).toBe(201);

    return (response.json as unknown as DeviceBody).data;
  }

  it('registra o dispositivo e reconhece a mesma instalação', async () => {
    const installationId = `install-${newId().toLowerCase()}`;
    const first = await registerDevice(installationId);

    expect(first.organizationId).toBe(owner.organizationId);
    expect(first.owner.id).toBe(owner.userId);
    expect(first.kind).toBe('vscode');
    expect(first.platform).toBe('windows');
    // Ainda não bateu: para o contrato, isso é `offline`.
    expect(first.status).toBe('offline');

    const again = await registerDevice(installationId, 'VS Code renomeado');

    // Mesmo dispositivo, não um novo: é o que impede a lista de crescer a cada
    // reinstalação da extensão.
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('VS Code renomeado');
  });

  it('recusa registro sem credencial', async () => {
    const response = await call(harness, 'POST', '/v1/devices/register', {
      body: {
        name: 'Anônimo',
        kind: 'cli',
        installationId: `install-${newId().toLowerCase()}`,
      },
    });

    expect(response.status).toBe(401);
  });

  it('faz o heartbeat alimentar a lista de agentes ativos', async () => {
    const device = await registerDevice(`install-${newId().toLowerCase()}`);
    const agentRunId = newId();

    const beat = await call(harness, 'POST', `/v1/devices/${device.id}/heartbeat`, {
      token: owner.accessToken,
      body: {
        status: 'online',
        projectIds: [projectId],
        activeAgentRunIds: [agentRunId],
        clientVersion: '0.2.0',
      },
    });

    expect(beat.status).toBe(200);

    const beatData = beat.json['data'] as { nextHeartbeatIn: number; shouldStop: boolean };

    expect(beatData.nextHeartbeatIn).toBe(DEVICE_SETTINGS.heartbeatIntervalSeconds);
    expect(beatData.shouldStop).toBe(false);

    const active = await call(harness, 'GET', `/v1/projects/${projectId}/agents/active`, {
      token: owner.accessToken,
    });

    expect(active.status).toBe(200);

    const agents = (active.json['data'] as { agents: { deviceId: string; activeAgentRunIds: string[]; status: string; owner: { id: string } }[] })
      .agents;
    const found = agents.find((agent) => agent.deviceId === device.id);

    expect(found).toBeDefined();
    expect(found?.status).toBe('online');
    expect(found?.activeAgentRunIds).toContain(agentRunId);
    expect(found?.owner.id).toBe(owner.userId);

    // A presença do projeto enxerga o mesmo dispositivo.
    const presence = await call(harness, 'GET', `/v1/projects/${projectId}/presence`, {
      token: owner.accessToken,
    });

    expect(presence.status).toBe(200);

    const entries = (presence.json['data'] as { entries: { user: { id: string }; deviceIds: string[]; activeAgentRuns: number }[] })
      .entries;
    const entry = entries.find((item) => item.user.id === owner.userId);

    expect(entry?.deviceIds).toContain(device.id);
    expect(entry?.activeAgentRuns).toBeGreaterThan(0);
  });

  it('tira da lista o dispositivo que parou de bater', async () => {
    const device = await registerDevice(`install-${newId().toLowerCase()}`);

    await call(harness, 'POST', `/v1/devices/${device.id}/heartbeat`, {
      token: owner.accessToken,
      body: { status: 'online', projectIds: [projectId], activeAgentRunIds: [] },
    });

    const before = await call(harness, 'GET', `/v1/projects/${projectId}/agents/active`, {
      token: owner.accessToken,
    });

    expect(
      (before.json['data'] as { agents: { deviceId: string }[] }).agents.map(
        (agent) => agent.deviceId,
      ),
    ).toContain(device.id);

    // Envelhece a batida em vez de esperar noventa e cinco segundos: o score no
    // ZSET **é** o prazo de validade, então empurrá-lo para o passado é
    // exatamente o que o relógio faria.
    await harness.app.redis.zadd(
      harness.realtime.keys.deviceProject(projectId),
      Date.now() - 1_000,
      device.id,
    );
    await harness.app.redis.del(harness.realtime.keys.deviceState(device.id));

    const after = await call(harness, 'GET', `/v1/projects/${projectId}/agents/active`, {
      token: owner.accessToken,
    });

    expect(
      (after.json['data'] as { agents: { deviceId: string }[] }).agents.map(
        (agent) => agent.deviceId,
      ),
    ).not.toContain(device.id);
  });

  it('anuncia device.changed a quem está conectado', async () => {
    const device = await registerDevice(`install-${newId().toLowerCase()}`);
    const client = await TestClient.connect(
      harness.wsUrl,
      await realtimeToken(harness, owner.accessToken),
    );

    client.send({
      type: 'hello',
      protocolVersion: 1,
      deviceId: null,
      clientVersion: null,
      subscriptions: [
        { organizationId: owner.organizationId, projectId, eventTypes: ['device.changed'] },
      ],
      cursor: null,
    });

    await client.waitForType('welcome');

    await call(harness, 'POST', `/v1/devices/${device.id}/heartbeat`, {
      token: owner.accessToken,
      body: { status: 'idle', projectIds: [projectId], activeAgentRunIds: [] },
    });

    const changed = await client.waitFor(
      (frame) =>
        frame.type === 'event' &&
        (frame['event'] as { type: string }).type === 'device.changed' &&
        (frame['event'] as { data: { deviceId: string } }).data.deviceId === device.id,
    );

    const envelope = changed['event'] as { projectId: string; data: { status: string } };

    expect(envelope.projectId).toBe(projectId);
    expect(envelope.data.status).toBe('idle');

    client.close();
    await client.waitForClose();
  });

  it('recusa heartbeat em projeto sem acesso', async () => {
    const device = await registerDevice(`install-${newId().toLowerCase()}`);

    // O projeto é privado e a dona não foi associada a ele.
    const response = await call(harness, 'POST', `/v1/devices/${device.id}/heartbeat`, {
      token: owner.accessToken,
      body: { status: 'online', projectIds: [otherProjectId], activeAgentRunIds: [] },
    });

    expect(response.status).toBe(403);
    expect((response.json['error'] as { code: string }).code).toBe('PROJECT_ACCESS_DENIED');
  });

  it('recusa heartbeat de dispositivo de outra pessoa', async () => {
    const device = await registerDevice(`install-${newId().toLowerCase()}`);
    const outsider = await registerAndLogin(harness, {
      name: 'De Fora',
      email: uniqueEmail('dev-fora'),
      password: 'senha-de-quem-esta-fora',
      organizationName: 'De Fora Devices',
    });

    const response = await call(harness, 'POST', `/v1/devices/${device.id}/heartbeat`, {
      token: outsider.accessToken,
      body: { status: 'online', projectIds: [], activeAgentRunIds: [] },
    });

    // Mesma resposta de dispositivo inexistente: quem não é dono não descobre
    // que o identificador existe.
    expect(response.status).toBe(404);
    expect((response.json['error'] as { code: string }).code).toBe('DEVICE_NOT_FOUND');
  });

  it('deixa a credencial do dispositivo bater o próprio heartbeat', async () => {
    // Associa a dona ao projeto privado, para o dispositivo poder declará-lo.
    await harness.app.db.manager.insert(projectMembers, {
      id: newId(),
      organizationId: owner.organizationId,
      projectId: otherProjectId,
      userId: owner.userId,
      status: 'active',
      createdBy: owner.userId,
    });

    const credential = await issueDeviceCredential(harness, owner);

    const beat = await call(harness, 'POST', `/v1/devices/${credential.deviceId}/heartbeat`, {
      token: credential.deviceToken,
      body: { status: 'online', projectIds: [otherProjectId], activeAgentRunIds: [] },
    });

    expect(beat.status).toBe(200);

    // A mesma credencial falando por outro dispositivo do mesmo dono: barrado.
    const another = await registerDevice(`install-${newId().toLowerCase()}`);
    const denied = await call(harness, 'POST', `/v1/devices/${another.id}/heartbeat`, {
      token: credential.deviceToken,
      body: { status: 'online', projectIds: [], activeAgentRunIds: [] },
    });

    expect(denied.status).toBe(403);
    expect((denied.json['error'] as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

/** Percorre o device flow existente e devolve a credencial `pdt_`. */
async function issueDeviceCredential(
  harness: RealtimeHarness,
  owner: RegisteredUser,
): Promise<{ deviceId: string; deviceToken: string }> {
  const started = await call(harness, 'POST', '/v1/auth/device/authorize', {
    body: {
      deviceName: 'CLI do teste',
      deviceKind: 'cli',
      platform: 'linux',
      clientVersion: '0.1.0',
    },
  });

  const startedData = started.json['data'] as { deviceCode: string; userCode: string };

  const decision = await call(harness, 'POST', '/v1/auth/device/decision', {
    token: owner.accessToken,
    body: {
      userCode: startedData.userCode,
      decision: 'approve',
      organizationId: owner.organizationId,
    },
  });

  expect(decision.status).toBe(200);

  // O intervalo mínimo de polling precisa vencer antes da primeira tentativa.
  await new Promise((resolve) => setTimeout(resolve, 5_200));

  const issued = await call(harness, 'POST', '/v1/auth/device/token', {
    body: { deviceCode: startedData.deviceCode },
  });

  expect(issued.status).toBe(200);

  return issued.json['data'] as { deviceId: string; deviceToken: string };
}

describe.skipIf(probe.ok)('devices (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
