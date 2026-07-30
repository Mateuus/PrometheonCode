/**
 * Gestão da própria conta, contra MySQL e Redis reais.
 *
 * O que esta suíte prova, e por que cada item importa:
 *
 * - a lista de sessões mostra todas as sessões vivas e diz qual é a atual — sem
 *   a marca, revogar a própria sessão achando que era outra é o erro fácil;
 * - a lista **não** devolve o user agent cru nem o endereço IP inteiro;
 * - revogar uma sessão a invalida **imediatamente**: o refresh daquela sessão
 *   para de funcionar na mesma hora, e o access token que ainda não expirou
 *   também;
 * - ninguém revoga sessão de outra pessoa, e a tentativa não revela se aquele
 *   identificador existe;
 * - trocar a senha exige a senha atual, faz a antiga parar de valer e derruba as
 *   outras sessões preservando a de quem trocou;
 * - o perfil é editável e o e-mail não.
 */

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

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

interface SessionItem {
  id: string;
  clientName: string | null;
  ipAddress: string | null;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe.skipIf(!probe.ok)('gestão da conta', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_account' });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** Abre mais uma sessão da mesma conta, com um cliente distinto. */
  async function signInAgain(
    user: Pick<RegisteredUser, 'email' | 'password'>,
    userAgent: string,
    password?: string,
  ): Promise<Tokens & { sessionId: string }> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'user-agent': userAgent },
      payload: { email: user.email, password: password ?? user.password },
    });

    if (response.statusCode !== 200) {
      throw new Error(`Login extra falhou: ${response.payload}`);
    }

    const parsed = body<{
      data: { tokens: Tokens; sessionId: string };
    }>(response).data;

    return { ...parsed.tokens, sessionId: parsed.sessionId };
  }

  async function listSessions(accessToken: string): Promise<SessionItem[]> {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    return body<{ data: { items: SessionItem[] } }>(response).data.items;
  }

  async function newUser(prefix: string): Promise<RegisteredUser> {
    return registerAndLogin(harness, {
      name: `Conta ${prefix}`,
      email: uniqueEmail(prefix),
      password: `senha-longa-de-teste-${prefix}`,
      organizationName: `Org ${prefix}`,
    });
  }

  // -------------------------------------------------------------------------
  // Listagem
  // -------------------------------------------------------------------------

  it('lista as sessões vivas e identifica a atual', async () => {
    const user = await newUser('lista');
    const second = await signInAgain(user, FIREFOX_LINUX);

    const fromFirst = await listSessions(user.accessToken);

    // As duas sessões aparecem, e exatamente uma é a atual.
    expect(fromFirst.length).toBeGreaterThanOrEqual(2);
    expect(fromFirst.filter((item) => item.current)).toHaveLength(1);

    const current = fromFirst.find((item) => item.current);

    expect(current).toBeDefined();
    expect(current?.id).not.toBe(second.sessionId);

    // A mesma lista vista da outra sessão marca a outra linha — a marca segue
    // quem está chamando, e não uma propriedade gravada na sessão.
    const fromSecond = await listSessions(second.accessToken);
    const currentForSecond = fromSecond.find((item) => item.current);

    expect(currentForSecond?.id).toBe(second.sessionId);
  });

  it('descreve a sessão sem devolver o user agent nem o endereço exato', async () => {
    const user = await newUser('privacidade');

    await signInAgain(user, CHROME);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    // A string crua do navegador não sai da API em lugar nenhum do corpo.
    expect(response.payload).not.toContain('AppleWebKit');
    expect(response.payload).not.toContain('Mozilla/5.0');

    const items = body<{ data: { items: SessionItem[] } }>(response).data.items;
    const chrome = items.find((item) => item.clientName === 'Chrome on Windows');

    expect(chrome, 'a sessão do Chrome precisa aparecer com rótulo legível').toBeDefined();

    // `app.inject()` chega por 127.0.0.1; o que sai é a rede, não o endereço.
    for (const item of items) {
      expect(item.ipAddress).toBe('127.0.0.0');
    }
  });

  it('exige credencial nas rotas de conta', async () => {
    // Os corpos são válidos de propósito. O Fastify valida o corpo antes de
    // chamar `preHandler`, então um payload malformado responderia 400 e o teste
    // passaria sem nunca ter exercitado a autenticação.
    for (const call of [
      { method: 'GET' as const, url: '/v1/me/sessions', payload: undefined },
      {
        method: 'DELETE' as const,
        url: '/v1/sessions/01JAV3B8QK5Z9TQW2M4X6YFHNP',
        payload: undefined,
      },
      {
        method: 'POST' as const,
        url: '/v1/me/password',
        payload: {
          currentPassword: 'uma-senha-bem-longa-01',
          newPassword: 'outra-senha-bem-longa-02',
        },
      },
      { method: 'PATCH' as const, url: '/v1/me', payload: { name: 'Sem Credencial' } },
    ]) {
      const response = await harness.app.inject(
        call.payload === undefined
          ? { method: call.method, url: call.url }
          : { method: call.method, url: call.url, payload: call.payload },
      );

      expect(response.statusCode, `${call.method} ${call.url}`).toBe(401);
      expect(
        body<{ error: { code: string } }>(response).error.code,
        `${call.method} ${call.url}`,
      ).toBe('UNAUTHENTICATED');
    }
  });

  // -------------------------------------------------------------------------
  // Revogação
  // -------------------------------------------------------------------------

  it('revoga uma sessão e derruba o refresh dela na mesma hora', async () => {
    const user = await newUser('revoga');
    const doomed = await signInAgain(user, FIREFOX_LINUX);

    // Antes: o refresh da outra sessão funciona.
    const beforeMe = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${doomed.accessToken}` },
    });

    expect(beforeMe.statusCode).toBe(200);

    const revoked = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${doomed.sessionId}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(revoked.statusCode).toBe(200);
    expect(body<{ data: { current: boolean } }>(revoked).data.current).toBe(false);

    // O ponto da rota: o refresh daquela sessão para de valer agora, não no
    // próximo ciclo de rotação.
    const refresh = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: doomed.refreshToken },
    });

    expect(refresh.statusCode).toBe(401);

    // E o access token que ainda estava dentro da validade também.
    const afterMe = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${doomed.accessToken}` },
    });

    expect(afterMe.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(afterMe).error.code).toBe('SESSION_REVOKED');

    // A sessão de quem revogou continua de pé, e a revogada some da lista.
    const remaining = await listSessions(user.accessToken);

    expect(remaining.some((item) => item.id === doomed.sessionId)).toBe(false);
  });

  it('deixa a pessoa revogar a própria sessão e avisa que foi essa', async () => {
    const user = await newUser('propria');
    const survivor = await signInAgain(user, FIREFOX_LINUX);
    const sessions = await listSessions(user.accessToken);
    const mine = sessions.find((item) => item.current);

    expect(mine).toBeDefined();

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${mine?.id ?? ''}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(body<{ data: { current: boolean } }>(response).data.current).toBe(true);

    const afterMe = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(afterMe.statusCode).toBe(401);

    // A outra sessão da mesma conta não foi arrastada junto.
    const stillAlive = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${survivor.accessToken}` },
    });

    expect(stillAlive.statusCode).toBe(200);
  });

  it('não deixa ninguém revogar a sessão de outra pessoa', async () => {
    const victim = await newUser('vitima');
    const attacker = await newUser('atacante');

    const sessions = await listSessions(victim.accessToken);
    const target = sessions.find((item) => item.current);

    expect(target).toBeDefined();

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${target?.id ?? ''}`,
      headers: { authorization: `Bearer ${attacker.accessToken}` },
    });

    // 404, e não 403: a resposta é a mesma de um identificador inexistente, para
    // que a rota não sirva de oráculo de sessões alheias.
    expect(response.statusCode).toBe(404);

    const unknown = await harness.app.inject({
      method: 'DELETE',
      url: '/v1/sessions/01JAV3B8QK5Z9TQW2M4X6YFHNP',
      headers: { authorization: `Bearer ${attacker.accessToken}` },
    });

    expect(unknown.statusCode).toBe(response.statusCode);
    expect(body<{ error: { code: string } }>(unknown).error.code).toBe(
      body<{ error: { code: string } }>(response).error.code,
    );

    // E a sessão da vítima continua funcionando.
    const victimMe = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${victim.accessToken}` },
    });

    expect(victimMe.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Troca de senha
  // -------------------------------------------------------------------------

  it('recusa a troca de senha sem a senha atual correta', async () => {
    const user = await newUser('senha-errada');

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/me/password',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        currentPassword: 'esta-nao-e-a-senha-atual',
        newPassword: 'uma-senha-nova-bem-longa',
      },
    });

    // 400, e não 401: errar o campo de um formulário não pode fazer o cliente
    // achar que a sessão morreu e deslogar a pessoa.
    expect(response.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(response).error.code).toBe(
      'INVALID_CREDENTIALS',
    );

    // A senha não mudou.
    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });

    expect(login.statusCode).toBe(200);
  });

  it('recusa uma nova senha igual à atual', async () => {
    const user = await newUser('senha-igual');

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/me/password',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { currentPassword: user.password, newPassword: user.password },
    });

    expect(response.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(response).error.code).toBe(
      'PASSWORD_TOO_WEAK',
    );
  });

  it('troca a senha, derruba as outras sessões e preserva a atual', async () => {
    const user = await newUser('troca');
    const other = await signInAgain(user, FIREFOX_LINUX);
    const newPassword = 'senha-nova-depois-da-troca';

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/me/password',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { currentPassword: user.password, newPassword },
    });

    expect(response.statusCode).toBe(200);
    expect(
      body<{ data: { revokedSessions: number } }>(response).data.revokedSessions,
    ).toBeGreaterThanOrEqual(1);

    // A senha antiga para de valer imediatamente.
    const withOld = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });

    expect(withOld.statusCode).toBe(401);

    const withNew = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: newPassword },
    });

    expect(withNew.statusCode).toBe(200);

    // A outra sessão cai — access token e refresh token, os dois.
    const otherMe = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${other.accessToken}` },
    });

    expect(otherMe.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(otherMe).error.code).toBe('SESSION_REVOKED');

    const otherRefresh = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: other.refreshToken },
    });

    expect(otherRefresh.statusCode).toBe(401);

    // A sessão de quem trocou sobrevive inteira: access token e refresh token.
    const mine = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(mine.statusCode).toBe(200);

    const myRefresh = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(myRefresh.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Perfil
  // -------------------------------------------------------------------------

  it('edita o próprio perfil', async () => {
    const user = await newUser('perfil');

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        name: 'Nome Novo',
        locale: 'pt-BR',
        timeZone: 'America/Sao_Paulo',
        avatarUrl: 'https://cdn.example.com/avatar.png',
      },
    });

    expect(response.statusCode).toBe(200);

    const updated = body<{
      data: { user: { name: string; locale: string; timeZone: string; avatarUrl: string | null } };
    }>(response).data.user;

    expect(updated.name).toBe('Nome Novo');
    expect(updated.locale).toBe('pt-BR');
    expect(updated.timeZone).toBe('America/Sao_Paulo');
    expect(updated.avatarUrl).toBe('https://cdn.example.com/avatar.png');

    // E ficou gravado: `GET /v1/me` vê a mesma coisa.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(body<{ data: { user: { name: string } } }>(me).data.user.name).toBe('Nome Novo');

    // Atualização parcial: o que não veio no corpo continua como estava.
    const partial = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { avatarUrl: null },
    });

    expect(partial.statusCode).toBe(200);

    const afterPartial = body<{
      data: { user: { name: string; avatarUrl: string | null } };
    }>(partial).data.user;

    expect(afterPartial.avatarUrl).toBeNull();
    expect(afterPartial.name).toBe('Nome Novo');
  });

  it('não deixa trocar o e-mail pelo perfil', async () => {
    const user = await newUser('email');

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: 'Outro Nome', email: 'sequestrado@example.test' },
    });

    expect(response.statusCode).toBe(200);
    expect(body<{ data: { user: { email: string } } }>(response).data.user.email).toBe(
      user.email,
    );

    // E o login continua sendo pelo endereço original.
    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });

    expect(login.statusCode).toBe(200);
  });

  it('recusa perfil vazio, fuso inexistente e avatar que não é http', async () => {
    const user = await newUser('perfil-invalido');

    const empty = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {},
    });

    expect(empty.statusCode).toBe(400);

    const badZone = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { timeZone: 'Mars/Olympus_Mons' },
    });

    expect(badZone.statusCode).toBe(400);

    // `javascript:` numa URL que a interface coloca em `<img src>` é execução de
    // script no cliente; o contrato só aceita http e https.
    const badAvatar = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { avatarUrl: 'javascript:alert(1)' },
    });

    expect(badAvatar.statusCode).toBe(400);
  });
});

describe.skipIf(probe.ok)('gestão da conta (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
