/**
 * Login com GitHub, contra MySQL e Redis reais.
 *
 * O GitHub é simulado — e só ele. Um teste que fala com o GitHub de verdade
 * falha quando a internet cai, quando o rate limit estoura e quando alguém
 * revoga o app, e nenhuma dessas falhas diz nada sobre o código. O resto do
 * caminho é real: banco, Redis, rotas, sessão.
 *
 * O que esta suíte prova, e por que cada item importa:
 *
 * - o `state` amarra o callback ao pedido que o originou. Sem ele, qualquer
 *   site manda o navegador de uma vítima ao callback com um `code` do atacante,
 *   e a conta da vítima acaba vinculada ao GitHub de outra pessoa;
 * - o `state` serve uma vez só. Reaproveitar um capturado seria o mesmo ataque
 *   com um passo a mais;
 * - o código de handoff serve uma vez só, e não é o token;
 * - `redirectTo` externo é podado — senão o Hub vira um redirecionador aberto
 *   para phishing com a credibilidade do domínio junto;
 * - **e-mail já cadastrado e não verificado NÃO vincula sozinho.** É o buraco
 *   que entregaria a conta a quem cadastrasse o endereço de outra pessoa;
 * - e-mail verificado nas duas pontas vincula, e a segunda entrada cai na mesma
 *   conta em vez de criar outra;
 * - identidade sem e-mail verificado não cria conta — seria irrecuperável.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { body, createHarness, probeServices, registerAndLogin, uniqueEmail, type TestHarness } from './support.js';
import type { GitHubClient, GitHubIdentity } from '../modules/auth/github.js';

const probe = await probeServices();

/**
 * GitHub de mentira.
 *
 * Devolve a identidade que o teste mandar. O `code` vira a chave para o teste
 * conseguir mais de uma identidade na mesma suíte.
 */
function fakeGitHub(identities: Record<string, GitHubIdentity>): GitHubClient {
  return {
    exchangeCode: (code: string) => {
      if (identities[code] === undefined) {
        throw new Error(`código inesperado no teste: ${code}`);
      }
      return Promise.resolve(`token-de-${code}`);
    },
    fetchIdentity: (accessToken: string) => {
      const code = accessToken.replace('token-de-', '');
      const identity = identities[code];

      if (identity === undefined) {
        throw new Error(`token inesperado no teste: ${accessToken}`);
      }

      return Promise.resolve(identity);
    },
  };
}

const OCTOCAT: GitHubIdentity = {
  providerAccountId: '583231',
  username: 'octocat',
  displayName: 'The Octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
  email: null,
};

describe.skipIf(!probe.ok)('login com GitHub', () => {
  let harness: TestHarness;
  const identities: Record<string, GitHubIdentity> = {};

  beforeAll(async () => {
    harness = await createHarness({
      prefix: 'prometheon_github',
      githubClient: fakeGitHub(identities),
    });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** Dispara o começo do fluxo e devolve o `state` que a API emitiu. */
  async function startFlow(redirectTo?: string): Promise<{ state: string; location: string }> {
    const response = await harness.app.inject({
      method: 'GET',
      url: redirectTo === undefined
        ? '/v1/auth/oauth/github'
        : `/v1/auth/oauth/github?redirectTo=${encodeURIComponent(redirectTo)}`,
    });

    expect(response.statusCode).toBe(302);

    const location = response.headers.location as string;

    return { state: new URL(location).searchParams.get('state') ?? '', location };
  }

  /** Percorre o callback e devolve o destino para onde o navegador foi. */
  async function callback(code: string, state: string): Promise<URL> {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth/github/callback?code=${code}&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(302);

    return new URL(response.headers.location as string);
  }

  it('manda para o GitHub pedindo só identidade', async () => {
    const { location } = await startFlow();
    const url = new URL(location);

    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('state')).toBeTruthy();

    // O escopo é o ponto: `repo` aqui faria a tela de entrada pedir acesso ao
    // código da pessoa só para dizer o nome dela.
    const scopes = url.searchParams.get('scope') ?? '';

    expect(scopes).toContain('read:user');
    expect(scopes).not.toContain('repo');
  });

  it('recusa callback com state desconhecido, expirado ou reusado', async () => {
    identities['code-state'] = { ...OCTOCAT, providerAccountId: '1001', email: uniqueEmail('gh-state') };

    // Inventado: nunca foi emitido por esta API.
    const forjado = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/github/callback?code=code-state&state=state-que-ninguem-emitiu',
    });

    expect(forjado.statusCode).toBe(302);
    expect(forjado.headers.location as string).toContain('/login?provider=');
    expect(forjado.headers.location as string).not.toContain('/auth/callback');

    // Legítimo, mas usado duas vezes.
    const { state } = await startFlow();
    const primeira = await callback('code-state', state);

    expect(primeira.pathname).toBe('/auth/callback');

    const segunda = await harness.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth/github/callback?code=code-state&state=${encodeURIComponent(state)}`,
    });

    expect(new URL(segunda.headers.location as string).pathname).toBe('/login');
  });

  it('poda destino externo para não virar redirecionador aberto', async () => {
    identities['code-redirect'] = {
      ...OCTOCAT,
      providerAccountId: '1002',
      email: uniqueEmail('gh-redirect'),
    };

    const { state } = await startFlow('https://phishing.example/roubado');
    const target = await callback('code-redirect', state);

    // O `next` precisa ser interno. Se o destino externo passasse, um link do
    // próprio Hub levaria a pessoa ao site do atacante — com a confiança do
    // domínio legítimo embutida.
    expect(target.searchParams.get('next')).toBe('/app');
  });

  it('poda também o destino protocol-relative', async () => {
    identities['code-slashes'] = {
      ...OCTOCAT,
      providerAccountId: '1003',
      email: uniqueEmail('gh-slashes'),
    };

    // `//evil.com` começa com barra mas é URL absoluta, e o navegador obedece.
    const { state } = await startFlow('//evil.example/x');
    const target = await callback('code-slashes', state);

    expect(target.searchParams.get('next')).toBe('/app');
  });

  it('cria a conta na primeira entrada e reencontra a mesma na segunda', async () => {
    const email = uniqueEmail('gh-novo');

    identities['code-novo'] = { ...OCTOCAT, providerAccountId: '2001', email };

    const primeiro = await callback('code-novo', (await startFlow()).state);
    const code = primeiro.searchParams.get('code') ?? '';

    const exchanged = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth/exchange',
      payload: { code },
    });

    expect(exchanged.statusCode).toBe(200);

    const session = body<{ data: { user: { id: string; email: string; emailVerified: boolean } } }>(
      exchanged,
    ).data;

    expect(session.user.email).toBe(email);
    // Nasce verificada: o provedor acabou de confirmar o endereço, e pedir uma
    // segunda confirmação do que já foi provado é cerimônia.
    expect(session.user.emailVerified).toBe(true);

    // Segunda entrada: mesma conta, não uma nova.
    const segundo = await callback('code-novo', (await startFlow()).state);
    const outraSessao = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth/exchange',
      payload: { code: segundo.searchParams.get('code') ?? '' },
    });

    expect(outraSessao.statusCode).toBe(200);
    expect(
      body<{ data: { user: { id: string } } }>(outraSessao).data.user.id,
      'a segunda entrada precisa cair na mesma conta',
    ).toBe(session.user.id);
  });

  it('o código de handoff serve uma vez só', async () => {
    identities['code-handoff'] = {
      ...OCTOCAT,
      providerAccountId: '2002',
      email: uniqueEmail('gh-handoff'),
    };

    const target = await callback('code-handoff', (await startFlow()).state);
    const code = target.searchParams.get('code') ?? '';

    const primeira = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth/exchange',
      payload: { code },
    });

    expect(primeira.statusCode).toBe(200);

    // O código aparece na barra de endereços e vai para o histórico. Se servisse
    // duas vezes, quem lesse o histórico entraria na conta.
    const repetida = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth/exchange',
      payload: { code },
    });

    expect(repetida.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('NÃO vincula sozinho a conta local cujo e-mail nunca foi verificado', async () => {
    const email = uniqueEmail('gh-naoverificado');

    // Simula o ataque: alguém cadastra o endereço de outra pessoa e nunca o
    // confirma, esperando que a vítima entre pelo GitHub.
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Impostor', email, password: 'senha-longa-do-impostor', acceptedTerms: true },
    });

    expect(registered.statusCode).toBe(202);

    identities['code-naoverificado'] = { ...OCTOCAT, providerAccountId: '3001', email };

    const target = await callback('code-naoverificado', (await startFlow()).state);

    // Não pode ter emitido handoff nenhum: a vítima seria jogada dentro da conta
    // que o impostor criou com o endereço dela.
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('provider')).toBe('IDENTITY_LINK_REQUIRED');
  });

  it('vincula quando as duas pontas estão verificadas', async () => {
    const user = await registerAndLogin(harness, {
      name: 'Dona Verificada',
      email: uniqueEmail('gh-verificada'),
      password: 'senha-longa-de-teste-gh',
      organizationName: 'Org GH',
    });

    identities['code-verificada'] = { ...OCTOCAT, providerAccountId: '3002', email: user.email };

    const target = await callback('code-verificada', (await startFlow()).state);

    expect(target.pathname).toBe('/auth/callback');

    const exchanged = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth/exchange',
      payload: { code: target.searchParams.get('code') ?? '' },
    });

    expect(exchanged.statusCode).toBe(200);
    expect(
      body<{ data: { user: { id: string } } }>(exchanged).data.user.id,
      'precisa entrar na conta que já existia, não criar outra',
    ).toBe(user.userId);
  });

  it('não cria conta para identidade sem e-mail verificado no provedor', async () => {
    identities['code-sememail'] = { ...OCTOCAT, providerAccountId: '4001', email: null };

    const target = await callback('code-sememail', (await startFlow()).state);

    // Sem endereço não há recuperação, convite nem aviso de segurança: a conta
    // ficaria irrecuperável no dia em que a pessoa perdesse o acesso ao GitHub.
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('provider')).toBe('PROVIDER_REJECTED');
  });

  it('trata desistência na tela do GitHub como decisão, não como erro', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/oauth/github/callback?error=access_denied',
    });

    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location as string).searchParams.get('provider')).toBe(
      'cancelled',
    );
  });
});

describe.skipIf(probe.ok)('login com GitHub (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
