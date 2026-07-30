/**
 * CORS, cookies e CSRF (`Docs/09`).
 *
 * O caso central é o do Hub Web: o refresh viaja em cookie `HttpOnly`, e é
 * justamente aí que o CSRF importa — é a única credencial que o navegador anexa
 * sozinho. Chamadas com `Authorization: Bearer` não são forjáveis por um site
 * terceiro e, por isso, não passam pela verificação.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  body,
  createHarness,
  probeServices,
  registerAndLogin,
  uniqueEmail,
  type TestHarness,
} from './support.js';

const probe = await probeServices();

/** Primeira origem da lista do `.env`; é a que o Hub Web usa. */
function allowedOrigin(harness: TestHarness): string {
  return harness.config.http.corsOrigins[0] ?? 'http://127.0.0.1:3550';
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  const found = all.find((entry) => entry.startsWith(`${name}=`));

  return found?.slice(name.length + 1).split(';')[0];
}

describe.skipIf(!probe.ok)('controles de borda', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_security' });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('devolve a origem permitida e recusa a desconhecida', async () => {
    const allowed = await harness.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: allowedOrigin(harness) },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe(allowedOrigin(harness));
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const rejected = await harness.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://site-de-terceiro.example' },
    });

    // Sem o header, o navegador descarta a resposta antes de o script a ver.
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('emite o cookie de CSRF legível pelo cliente', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health/live' });
    const setCookie = response.headers['set-cookie'];

    expect(cookieValue(setCookie, 'prom_csrf')).toBeDefined();
    // O cookie do double-submit precisa ser lido por JavaScript para voltar no
    // header; `HttpOnly` aqui quebraria o mecanismo.
    expect(String(setCookie)).not.toContain('HttpOnly');
    expect(String(setCookie)).toContain('SameSite=Strict');
  });

  it('o login de navegador guarda o refresh no cookie e o omite do corpo', async () => {
    const email = uniqueEmail('cookie');
    const password = 'senha-do-teste-de-cookie';

    await registerAndLogin(harness, {
      name: 'Cookie',
      email,
      password,
      organizationName: 'Cookie',
    });

    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: allowedOrigin(harness) },
      payload: { email, password },
    });

    expect(login.statusCode).toBe(200);

    const tokens = body<{
      data: { tokens: { accessToken: string; refreshToken?: string } };
    }>(login).data.tokens;

    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeUndefined();

    const refreshCookie = cookieValue(login.headers['set-cookie'], 'prom_refresh');

    expect(refreshCookie).toBeDefined();
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('recusa a requisição de cookie sem o header de CSRF', async () => {
    const email = uniqueEmail('csrf');
    const password = 'senha-do-teste-de-csrf-1';

    await registerAndLogin(harness, {
      name: 'Csrf',
      email,
      password,
      organizationName: 'Csrf',
    });

    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: allowedOrigin(harness) },
      payload: { email, password },
    });

    const refreshCookie = cookieValue(login.headers['set-cookie'], 'prom_refresh') ?? '';
    const csrfCookie = cookieValue(login.headers['set-cookie'], 'prom_csrf') ?? '';

    // Sem o header: é exatamente o que um site terceiro conseguiria montar.
    const withoutHeader = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        origin: allowedOrigin(harness),
        cookie: `prom_refresh=${refreshCookie}; prom_csrf=${csrfCookie}`,
      },
      payload: {},
    });

    expect(withoutHeader.statusCode).toBe(403);
    expect(body<{ error: { code: string } }>(withoutHeader).error.code).toBe('FORBIDDEN');

    // Com o header, mas com valor que não bate.
    const wrongHeader = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        origin: allowedOrigin(harness),
        cookie: `prom_refresh=${refreshCookie}; prom_csrf=${csrfCookie}`,
        'x-csrf-token': 'valor-que-nao-bate',
      },
      payload: {},
    });

    expect(wrongHeader.statusCode).toBe(403);

    // Com o par correto, passa.
    const valid = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        origin: allowedOrigin(harness),
        cookie: `prom_refresh=${refreshCookie}; prom_csrf=${csrfCookie}`,
        'x-csrf-token': csrfCookie,
      },
      payload: {},
    });

    expect(valid.statusCode).toBe(200);
  });

  it('recusa cookie vindo de origem fora da lista', async () => {
    const email = uniqueEmail('origem');
    const password = 'senha-do-teste-de-origem';

    await registerAndLogin(harness, {
      name: 'Origem',
      email,
      password,
      organizationName: 'Origem',
    });

    const login = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: allowedOrigin(harness) },
      payload: { email, password },
    });

    const refreshCookie = cookieValue(login.headers['set-cookie'], 'prom_refresh') ?? '';
    const csrfCookie = cookieValue(login.headers['set-cookie'], 'prom_csrf') ?? '';

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        origin: 'https://site-de-terceiro.example',
        cookie: `prom_refresh=${refreshCookie}; prom_csrf=${csrfCookie}`,
        'x-csrf-token': csrfCookie,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it('não exige CSRF de quem usa Bearer', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Bearer',
      email: uniqueEmail('bearer'),
      password: 'senha-do-teste-de-bearer',
      organizationName: 'Bearer',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { name: 'Sem CSRF' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('marca as respostas de autenticação como não cacheáveis', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset',
      payload: { email: uniqueEmail('cache') },
    });

    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe.skipIf(probe.ok)('controles de borda (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
