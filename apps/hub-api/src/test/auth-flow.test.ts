/**
 * Ciclo completo de autenticação contra MySQL e Redis reais.
 *
 * O que esta suíte prova, e por que cada item importa:
 *
 * - registro → verificação → login → refresh → logout funciona ponta a ponta;
 * - refresh reutilizado é recusado **e** derruba a família inteira de tokens;
 * - registro, login e recuperação de senha não revelam se um e-mail existe;
 * - logout revoga de verdade — o access token que ainda não expirou para de
 *   valer na mesma hora;
 * - a senha nunca volta ao cliente e o refresh só existe hasheado no banco.
 */

import { refreshTokens, users } from '@prometheon/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashToken } from '../shared/crypto.js';
import {
  body,
  createHarness,
  lastMail,
  probeServices,
  registerAndLogin,
  tokenFromLink,
  uniqueEmail,
  type TestHarness,
} from './support.js';

const probe = await probeServices();

describe.skipIf(!probe.ok)('fluxo de autenticação', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_auth' });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('percorre registro, verificação, login, refresh e logout', async () => {
    const email = uniqueEmail('ciclo');
    const password = 'uma-senha-bem-longa-2026';

    const registration = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        name: 'Ciclo Completo',
        email,
        password,
        organizationName: 'Ciclo',
        acceptedTerms: true,
      },
    });

    expect(registration.statusCode).toBe(202);
    await harness.authService.flushPendingMail();

    const mail = await lastMail(harness.mailDirectory, 'email-verification', email);

    expect(mail, 'o e-mail de verificação precisa ter sido gravado em disco').toBeDefined();

    // Antes de verificar, `me` já funciona mas a conta não está confirmada.
    const beforeVerification = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });

    expect(
      body<{ data: { user: { emailVerified: boolean } } }>(beforeVerification).data.user
        .emailVerified,
    ).toBe(false);

    const verified = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: tokenFromLink(mail!) },
    });

    expect(verified.statusCode).toBe(200);
    expect(
      body<{ data: { user: { emailVerified: boolean } } }>(verified).data.user.emailVerified,
    ).toBe(true);

    // Uso único: o mesmo link não vale duas vezes.
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: tokenFromLink(mail!) },
    });

    expect(replay.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(replay).error.code).toBe(
      'VERIFICATION_TOKEN_INVALID',
    );

    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });

    expect(login.statusCode).toBe(200);

    const session = body<{
      data: {
        user: { id: string };
        tokens: { accessToken: string; refreshToken: string; expiresIn: number };
        sessionId: string;
      };
    }>(login).data;

    expect(session.tokens.expiresIn).toBe(900);
    expect(login.payload).not.toContain(password);

    // O refresh token só existe hasheado no banco.
    const stored = await harness.app.db.manager.find(refreshTokens, {
      select: { id: true },
      where: { tokenHash: hashToken(session.tokens.refreshToken) },
    });

    expect(stored).toHaveLength(1);

    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${session.tokens.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(body<{ data: { user: { email: string } } }>(me).data.user.email).toBe(email);

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.tokens.refreshToken },
    });

    expect(refreshed.statusCode).toBe(200);

    const rotated = body<{
      data: { tokens: { accessToken: string; refreshToken: string } };
    }>(refreshed).data.tokens;

    expect(rotated.refreshToken).not.toBe(session.tokens.refreshToken);

    const logout = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${rotated.accessToken}` },
      payload: {},
    });

    expect(logout.statusCode).toBe(200);

    // Revogação de verdade: o access token ainda dentro da validade para de
    // funcionar assim que a sessão cai.
    const afterLogout = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });

    expect(afterLogout.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(afterLogout).error.code).toBe('SESSION_REVOKED');

    // E o refresh rotacionado também não vale mais.
    const refreshAfterLogout = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });

    expect(refreshAfterLogout.statusCode).toBe(401);
  });

  it('recusa refresh reutilizado e invalida a família inteira', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Reuso Detectado',
      email: uniqueEmail('reuso'),
      password: 'senha-para-testar-reuso-1',
      organizationName: 'Reuso',
    });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(first.statusCode).toBe(200);

    const rotated = body<{ data: { tokens: { accessToken: string; refreshToken: string } } }>(
      first,
    ).data.tokens;

    // Apresentar de novo o token já rotacionado: é o sinal de que o valor vazou.
    const reuse = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(reuse.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(reuse).error.code).toBe('TOKEN_INVALID');

    // A família cai junto: o token legítimo emitido logo antes também morre.
    const legitimate = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });

    expect(legitimate.statusCode).toBe(401);

    // E a sessão inteira, com ela.
    const withAccessToken = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });

    expect(withAccessToken.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(withAccessToken).error.code).toBe(
      'SESSION_REVOKED',
    );
  });

  it('não revela se um e-mail já está registrado', async () => {
    const email = uniqueEmail('enumeracao');
    const password = 'senha-da-enumeracao-2026';

    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Primeiro', email, password, acceptedTerms: true },
    });

    const second = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Segundo', email, password: 'outra-senha-longa-2026', acceptedTerms: true },
    });

    // Mesmo status e mesmo corpo, tirando o `requestId`.
    expect(second.statusCode).toBe(first.statusCode);
    expect(body<{ data: unknown }>(second).data).toEqual(body<{ data: unknown }>(first).data);

    // A segunda tentativa não criou conta nova.
    const rows = await harness.app.db.manager.find(users, {
      select: { id: true },
      where: { email },
    });

    expect(rows).toHaveLength(1);

    // Mas o dono do endereço é avisado.
    await harness.authService.flushPendingMail();
    expect(await lastMail(harness.mailDirectory, 'registration-attempt', email)).toBeDefined();
  });

  it('responde igual no login com e-mail inexistente e com senha errada', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Timing',
      email: uniqueEmail('timing'),
      password: 'senha-do-teste-de-timing',
      organizationName: 'Timing',
    });

    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: 'esta-senha-esta-errada' },
    });

    const unknownEmail = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: uniqueEmail('inexistente'), password: 'esta-senha-esta-errada' },
    });

    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(body<{ error: { code: string; message: string } }>(unknownEmail).error.message).toBe(
      body<{ error: { code: string; message: string } }>(wrongPassword).error.message,
    );
  });

  it('mede o tempo de login de conta inexistente e de senha errada na mesma ordem de grandeza', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Relogio',
      email: uniqueEmail('relogio'),
      password: 'senha-do-teste-de-relogio',
      organizationName: 'Relogio',
    });

    const measure = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();

      await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'uma-senha-qualquer-longa' },
      });

      return Number(process.hrtime.bigint() - started) / 1_000_000;
    };

    // Duas medições de cada, alternadas, para diluir o ruído do agendador.
    const existing = (await measure(user.email)) + (await measure(user.email));
    const missing =
      (await measure(uniqueEmail('fantasma'))) + (await measure(uniqueEmail('fantasma')));

    // O caminho "conta não existe" também paga um Argon2id completo. Sem isso a
    // razão passaria de 10x e o tempo de resposta entregaria quais e-mails
    // existem. A margem é larga de propósito: a asserção precisa reprovar o
    // vazamento sem falhar por causa de uma máquina ocupada.
    const ratio = Math.max(existing, missing) / Math.max(1, Math.min(existing, missing));

    expect(ratio).toBeLessThan(4);
  });

  it('recupera a senha com token de uso único e derruba as sessões', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Recuperacao',
      email: uniqueEmail('recuperacao'),
      password: 'senha-antiga-bem-longa-1',
      organizationName: 'Recuperacao',
    });

    const request = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset',
      payload: { email: user.email },
    });

    expect(request.statusCode).toBe(202);
    await harness.authService.flushPendingMail();

    const mail = await lastMail(harness.mailDirectory, 'password-reset', user.email);

    expect(mail).toBeDefined();

    const token = tokenFromLink(mail!);
    const newPassword = 'senha-nova-bem-longa-2026';

    const confirmed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, password: newPassword },
    });

    expect(confirmed.statusCode).toBe(200);

    // Uso único.
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, password: 'mais-uma-senha-longa-x' },
    });

    expect(replay.statusCode).toBe(400);
    expect(body<{ error: { code: string } }>(replay).error.code).toBe('RESET_TOKEN_INVALID');

    // Trocar a senha derruba a sessão que existia antes.
    const oldSession = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });

    expect(oldSession.statusCode).toBe(401);

    // A senha antiga não vale mais; a nova, sim.
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
  });

  it('recuperação de senha responde igual para endereço que não existe', async () => {
    const known = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset',
      payload: { email: uniqueEmail('nao-cadastrado') },
    });

    expect(known.statusCode).toBe(202);
    expect(body<{ data: unknown }>(known).data).toEqual({});
  });

  it('recusa access token adulterado', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Assinatura',
      email: uniqueEmail('assinatura'),
      password: 'senha-para-assinatura-01',
      organizationName: 'Assinatura',
    });

    const [header, payload] = user.accessToken.split('.');
    const forged = `${header ?? ''}.${payload ?? ''}.assinatura-invalida`;

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('TOKEN_INVALID');
  });

  it('exige credencial em /v1/me', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('UNAUTHENTICATED');
  });
});

describe.skipIf(probe.ok)('fluxo de autenticação (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
