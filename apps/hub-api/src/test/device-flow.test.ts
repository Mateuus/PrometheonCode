/**
 * Device authorization flow, os seis passos do `Docs/09`.
 *
 * O que a suíte cobre: pedido de código, consulta no navegador, aprovação,
 * polling limitado, entrega da credencial e o que acontece quando o usuário
 * nega. O passo 6 (guardar em SecretStorage/Keychain) é do cliente.
 */

import { devices, deviceTokens } from '@prometheon/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken } from '../shared/crypto.js';
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

interface DeviceCodeResponse {
  data: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  };
}

describe.skipIf(!probe.ok)('device flow', () => {
  let harness: TestHarness;
  let owner: RegisteredUser;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_device' });
    owner = await registerAndLogin(harness, {
      name: 'Dono do Dispositivo',
      email: uniqueEmail('device'),
      password: 'senha-do-device-flow-01',
      organizationName: 'Device',
    });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** Passo 1. */
  async function startFlow(): Promise<DeviceCodeResponse['data']> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/authorize',
      payload: {
        deviceName: 'VS Code do teste',
        deviceKind: 'vscode',
        platform: 'windows',
        clientVersion: '0.1.0',
      },
    });

    expect(response.statusCode).toBe(200);

    return body<DeviceCodeResponse>(response).data;
  }

  it('entrega a credencial depois da aprovação', async () => {
    const started = await startFlow();

    expect(started.userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(started.expiresIn).toBe(600);
    expect(started.interval).toBe(5);
    expect(started.verificationUriComplete).toContain(encodeURIComponent(started.userCode));

    // Passo 4 antes da decisão: ainda pendente.
    const pending = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: started.deviceCode },
    });

    expect(pending.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(pending).error.code).toBe(
      'DEVICE_AUTHORIZATION_PENDING',
    );

    // Polling mais rápido que o intervalo anunciado.
    const tooFast = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: started.deviceCode },
    });

    expect(tooFast.statusCode).toBe(429);
    expect(body<{ error: { code: string } }>(tooFast).error.code).toBe('SLOW_DOWN');
    expect(tooFast.headers['retry-after']).toBeDefined();

    // Passo 3: o navegador mostra o que está sendo autorizado.
    const verification = await harness.app.inject({
      method: 'GET',
      url: `/v1/auth/device/verification?userCode=${encodeURIComponent(started.userCode)}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });

    expect(verification.statusCode).toBe(200);
    expect(body<{ data: { deviceName: string } }>(verification).data.deviceName).toBe(
      'VS Code do teste',
    );

    const decision = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/decision',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        userCode: started.userCode,
        decision: 'approve',
        organizationId: owner.organizationId,
      },
    });

    expect(decision.statusCode).toBe(200);
    expect(body<{ data: { status: string } }>(decision).data.status).toBe('approved');

    // O intervalo de polling precisa vencer antes da próxima tentativa.
    await new Promise((resolve) => setTimeout(resolve, 5_200));

    const credential = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: started.deviceCode },
    });

    expect(credential.statusCode).toBe(200);

    const issued = body<{
      data: { deviceId: string; deviceToken: string; organizationId: string };
    }>(credential).data;

    expect(issued.deviceToken.startsWith('pdt_')).toBe(true);
    expect(issued.organizationId).toBe(owner.organizationId);

    // Só o hash é guardado.
    const stored = await harness.app.db
      .select({ id: deviceTokens.id, hash: deviceTokens.tokenHash })
      .from(deviceTokens)
      .where(eq(deviceTokens.deviceId, issued.deviceId));

    expect(stored).toHaveLength(1);
    expect(stored[0]?.hash).toBe(hashToken(issued.deviceToken));
    expect(stored[0]?.hash).not.toBe(issued.deviceToken);

    const device = await harness.app.db
      .select({ status: devices.status })
      .from(devices)
      .where(eq(devices.id, issued.deviceId));

    expect(device[0]?.status).toBe('active');

    // A credencial autentica como o dono.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${issued.deviceToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(body<{ data: { user: { id: string } } }>(me).data.user.id).toBe(owner.userId);

    // O device code não vale duas vezes.
    await new Promise((resolve) => setTimeout(resolve, 5_200));

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: started.deviceCode },
    });

    expect(replay.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(replay).error.code).toBe('DEVICE_CODE_EXPIRED');
  });

  it('recusa a entrega quando o usuário nega', async () => {
    const started = await startFlow();

    const decision = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/decision',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: {
        userCode: started.userCode,
        decision: 'deny',
        organizationId: owner.organizationId,
      },
    });

    expect(decision.statusCode).toBe(200);
    expect(body<{ data: { status: string } }>(decision).data.status).toBe('denied');

    const polled = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: started.deviceCode },
    });

    expect(polled.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(polled).error.code).toBe(
      'DEVICE_AUTHORIZATION_DENIED',
    );
  });

  it('recusa device code desconhecido', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/token',
      payload: { deviceCode: 'este-codigo-nunca-existiu-mas-tem-tamanho' },
    });

    expect(response.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('DEVICE_CODE_EXPIRED');
  });

  it('exige autenticação para consultar e para decidir', async () => {
    const started = await startFlow();

    const anonymousView = await harness.app.inject({
      method: 'GET',
      url: `/v1/auth/device/verification?userCode=${encodeURIComponent(started.userCode)}`,
    });

    expect(anonymousView.statusCode).toBe(401);

    const anonymousDecision = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/decision',
      payload: {
        userCode: started.userCode,
        decision: 'approve',
        organizationId: owner.organizationId,
      },
    });

    expect(anonymousDecision.statusCode).toBe(401);
  });

  it('recusa aprovar dispositivo para organização de que não se é membro', async () => {
    const outsider = await registerAndLogin(harness, {
      name: 'De Fora',
      email: uniqueEmail('defora'),
      password: 'senha-de-quem-esta-fora',
      organizationName: 'De Fora',
    });

    const started = await startFlow();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/decision',
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: {
        userCode: started.userCode,
        // A organização do dono, não a de quem está chamando.
        decision: 'approve',
        organizationId: owner.organizationId,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(response).error.code).toBe(
      'ORGANIZATION_ACCESS_DENIED',
    );
  });
});

describe.skipIf(probe.ok)('device flow (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
