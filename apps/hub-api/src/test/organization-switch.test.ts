/**
 * Trocar a organização ativa (`POST /v1/auth/switch-organization`).
 *
 * O claim `org` é fixado quando a sessão nasce, e nada dentro de um JWT assinado
 * pode ser reescrito. A troca, portanto, encerra a sessão anterior e abre outra.
 * O que esta suíte prova:
 *
 * - só troca para organização com associação **ativa**, verificada no banco:
 *   organização de terceiro, organização inexistente e vínculo suspenso recebem
 *   a mesma recusa, que também não revela se o tenant existe;
 * - o escopo antigo morre no ato — o access token anterior, ainda dentro dos
 *   quinze minutos, para de valer, e é a denylist do Redis que faz isso;
 * - o refresh anterior morre junto, e o novo continua rotacionando normalmente,
 *   carregando a organização nova em toda a família;
 * - o token novo resolve `GET /v1/audit` para a organização nova, que era o
 *   sintoma visível da lacuna;
 * - credencial de dispositivo não troca: o escopo dela foi decidido no device
 *   flow, e reemitir aqui contornaria aquela decisão;
 * - a troca fica registrada na auditoria da organização de destino.
 */

import { organizationMembers } from '@prometheon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

interface SwitchBody {
  data: {
    user: { id: string };
    tokens: { accessToken: string; refreshToken: string };
    sessionId: string;
    activeOrganizationId: string;
  };
}

/**
 * Lê o claim `org` do access token.
 *
 * O teste decodifica em vez de confiar no corpo da resposta porque é o **token**
 * que autoriza as chamadas seguintes; se o claim divergir do que a resposta
 * anuncia, é o claim que vale.
 */
function organizationClaim(accessToken: string): string | null {
  const payload = accessToken.split('.')[1] ?? '';
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    org?: string | null;
  };

  return decoded.org ?? null;
}

describe.skipIf(!probe.ok)('trocar a organização ativa', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_switch' });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** Cria uma segunda organização para a conta, que passa a ser dona das duas. */
  async function createSecondOrganization(
    user: RegisteredUser,
    name: string,
  ): Promise<string> {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name },
    });

    if (created.statusCode !== 201) {
      throw new Error(`Organização não criada: ${created.payload}`);
    }

    return body<{ data: { id: string } }>(created).data.id;
  }

  function switchTo(organizationId: string, accessToken: string) {
    return harness.app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { organizationId },
    });
  }

  it('troca o escopo da sessão e derruba a credencial anterior', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Duas Organizacoes',
      email: uniqueEmail('duas-orgs'),
      password: 'senha-de-quem-tem-duas-orgs',
      organizationName: 'Primeira',
    });

    const second = await createSecondOrganization(user, 'Segunda');

    // Antes da troca, a sessão está ancorada na primeira.
    expect(organizationClaim(user.accessToken)).toBe(user.organizationId);

    const response = await switchTo(second, user.accessToken);

    expect(response.statusCode).toBe(200);

    const switched = body<SwitchBody>(response).data;

    expect(switched.activeOrganizationId).toBe(second);
    expect(switched.user.id).toBe(user.userId);
    // A sessão é outra: o cliente precisa substituir o par inteiro.
    expect(switched.sessionId).not.toBe('');
    expect(organizationClaim(switched.tokens.accessToken)).toBe(second);

    // O access token anterior estava longe de expirar e, ainda assim, morreu.
    const withOldToken = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(withOldToken.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(withOldToken).error.code).toBe('SESSION_REVOKED');

    // O refresh anterior também.
    const oldRefresh = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(oldRefresh.statusCode).toBe(401);

    // E `me` passa a informar a organização nova como ativa.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${switched.tokens.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(body<{ data: { activeOrganizationId: string } }>(me).data.activeOrganizationId).toBe(
      second,
    );
  });

  it('mantém a rotação de refresh funcionando com a organização nova', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Rotacao Depois da Troca',
      email: uniqueEmail('rotacao-troca'),
      password: 'senha-da-rotacao-apos-troca',
      organizationName: 'Rotacao Primeira',
    });

    const second = await createSecondOrganization(user, 'Rotacao Segunda');
    const switched = body<SwitchBody>(await switchTo(second, user.accessToken)).data;

    // Primeira rotação depois da troca.
    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: switched.tokens.refreshToken },
    });

    expect(refreshed.statusCode).toBe(200);

    const rotated = body<{ data: { tokens: { accessToken: string; refreshToken: string } } }>(
      refreshed,
    ).data.tokens;

    expect(rotated.refreshToken).not.toBe(switched.tokens.refreshToken);
    // O escopo acompanha a família inteira, não só o token emitido na troca.
    expect(organizationClaim(rotated.accessToken)).toBe(second);

    // Segunda rotação: a cadeia continua íntegra.
    const again = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });

    expect(again.statusCode).toBe(200);
    expect(
      organizationClaim(
        body<{ data: { tokens: { accessToken: string } } }>(again).data.tokens.accessToken,
      ),
    ).toBe(second);

    // E a detecção de reuso segue valendo na família nova.
    const reuse = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });

    expect(reuse.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(reuse).error.code).toBe('TOKEN_INVALID');
  });

  it('resolve GET /v1/audit pela organização do token', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Auditoria Depois da Troca',
      email: uniqueEmail('audit-troca'),
      password: 'senha-da-auditoria-na-troca',
      organizationName: 'Auditoria Primeira',
    });

    const second = await createSecondOrganization(user, 'Auditoria Segunda');
    const switched = body<SwitchBody>(await switchTo(second, user.accessToken)).data;

    const audit = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${switched.tokens.accessToken}` },
    });

    expect(audit.statusCode).toBe(200);

    const items = body<{ data: { items: { organizationId: string }[] } }>(audit).data.items;

    expect(items.length).toBeGreaterThan(0);
    // Toda linha é da organização nova — era este o sintoma que a interface
    // avisava não conseguir resolver.
    expect(items.every((item) => item.organizationId === second)).toBe(true);
  });

  it('registra a troca na auditoria da organização de destino', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Rastro da Troca',
      email: uniqueEmail('rastro-troca'),
      password: 'senha-do-rastro-de-troca',
      organizationName: 'Rastro Primeira',
    });

    const second = await createSecondOrganization(user, 'Rastro Segunda');
    const switched = body<SwitchBody>(await switchTo(second, user.accessToken)).data;

    const audit = await harness.app.inject({
      method: 'GET',
      url: '/v1/audit?action=auth.organization.switched',
      headers: { authorization: `Bearer ${switched.tokens.accessToken}` },
    });

    expect(audit.statusCode).toBe(200);

    const items = body<{
      data: { items: { action: string; resourceId: string | null; organizationId: string }[] };
    }>(audit).data.items;

    const entry = items.find((item) => item.resourceId === switched.sessionId);

    expect(entry, 'a troca precisa aparecer na auditoria da organização nova').toBeDefined();
    expect(entry?.organizationId).toBe(second);
  });

  it('recusa organização de terceiro, inexistente ou com vínculo suspenso', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Sem Acesso',
      email: uniqueEmail('sem-acesso'),
      password: 'senha-de-quem-nao-tem-acesso',
      organizationName: 'Propria',
    });

    const stranger = await registerAndLogin(harness, {
      name: 'Estranho',
      email: uniqueEmail('estranho'),
      password: 'senha-da-organizacao-alheia',
      organizationName: 'Alheia',
    });

    // Organização de outra pessoa.
    const foreign = await switchTo(stranger.organizationId, user.accessToken);

    expect(foreign.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(foreign).error.code).toBe(
      'ORGANIZATION_ACCESS_DENIED',
    );

    // Organização que não existe: mesma resposta, para a rota não virar um
    // verificador de identificadores.
    const missing = await switchTo('01JZZZZZZZZZZZZZZZZZZZZZZZ', user.accessToken);

    expect(missing.statusCode).toBe(foreign.statusCode);
    expect(body<{ error: { code: string } }>(missing).error.code).toBe(
      body<{ error: { code: string } }>(foreign).error.code,
    );

    // Vínculo suspenso não serve: a associação precisa estar ativa.
    const second = await createSecondOrganization(user, 'Suspensa');

    await harness.app.db.manager
      .createQueryBuilder()
      .update(organizationMembers)
      .set({ status: 'suspended' })
      .where('organization_id = :organizationId', { organizationId: second })
      .andWhere('user_id = :userId', { userId: user.userId })
      .execute();

    const suspended = await switchTo(second, user.accessToken);

    expect(suspended.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(suspended).error.code).toBe(
      'ORGANIZATION_ACCESS_DENIED',
    );

    // Nenhuma tentativa recusada derrubou a sessão de quem tentou.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
  });

  it('recusa credencial de dispositivo', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Dono do Dispositivo',
      email: uniqueEmail('dispositivo-troca'),
      password: 'senha-do-dono-do-dispositivo',
      organizationName: 'Dispositivo Primeira',
    });

    const second = await createSecondOrganization(user, 'Dispositivo Segunda');

    const started = body<{ data: { deviceCode: string; userCode: string } }>(
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/device/authorize',
        payload: { deviceName: 'VS Code do teste', deviceKind: 'vscode', platform: 'windows' },
      }),
    ).data;

    const decision = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/device/decision',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        userCode: started.userCode,
        decision: 'approve',
        organizationId: user.organizationId,
      },
    });

    expect(decision.statusCode).toBe(200);

    const credential = body<{ data: { deviceToken: string } }>(
      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/device/token',
        payload: { deviceCode: started.deviceCode },
      }),
    ).data;

    const response = await switchTo(second, credential.deviceToken);

    expect(response.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(response).error.code).toBe(
      'ORGANIZATION_ACCESS_DENIED',
    );
  });

  it('exige autenticação', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/switch-organization',
      payload: { organizationId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe.skipIf(probe.ok)('trocar a organização ativa (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
