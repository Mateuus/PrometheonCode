/**
 * Conversa com o GitHub durante o login.
 *
 * O que a API precisa do GitHub é pouco: trocar o `code` por um access token e
 * perguntar quem é o dono dele. O token do provedor morre nesta função — não vai
 * para o banco, não vai para o log e não volta para o cliente. `user_identities`
 * guarda o identificador da conta e mais nada; credencial para ler repositório é
 * outro fluxo, cifrada em `git_connections`.
 *
 * A interface existe para o teste não depender da rede. Um teste que chama o
 * GitHub de verdade falha quando a internet cai, quando o rate limit estoura e
 * quando alguém revoga o app — e nenhuma dessas falhas diz algo sobre o código.
 */

import { badGateway } from '../../shared/errors.js';

/** Identidade que o GitHub confirma. Só o que o Hub realmente usa. */
export interface GitHubIdentity {
  /** `id` numérico da conta, estável mesmo se a pessoa trocar de login. */
  providerAccountId: string;
  /** `login` do GitHub — o `@fulano`. */
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  /**
   * E-mail primário **verificado pelo GitHub**, ou nulo.
   *
   * Nulo tem dois casos que valem a mesma coisa aqui: a pessoa não tem e-mail
   * verificado, ou só tem endereços não confirmados. Em ambos, o Hub não pode
   * usar o endereço para achar uma conta existente — seria vincular por um dado
   * que ninguém provou.
   */
  email: string | null;
}

export interface GitHubClient {
  exchangeCode(code: string): Promise<string>;
  fetchIdentity(accessToken: string): Promise<GitHubIdentity>;
}

interface GitHubClientOptions {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  /** Trocável no teste; em produção é sempre o `fetch` global. */
  fetchImpl?: typeof fetch;
}

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';

/**
 * Monta a URL para onde o navegador é mandado.
 *
 * `state` é obrigatório e não tem valor padrão de propósito: sem ele, qualquer
 * site consegue disparar o callback e ligar a conta do GitHub de um atacante à
 * sessão de quem estiver logado no Hub.
 */
export function authorizationUrl(input: {
  clientId: string;
  callbackUrl: string;
  scopes: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);

  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  url.searchParams.set('scope', input.scopes);
  url.searchParams.set('state', input.state);
  // Força a tela de consentimento a não reaproveitar silenciosamente uma
  // autorização anterior de outra conta do GitHub na mesma máquina.
  url.searchParams.set('allow_signup', 'true');

  return url.toString();
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const call = options.fetchImpl ?? fetch;

  return {
    async exchangeCode(code: string): Promise<string> {
      const response = await call(TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          redirect_uri: options.callbackUrl,
        }),
      });

      if (!response.ok) {
        throw badGateway('The identity provider did not answer.', 'PROVIDER_UNAVAILABLE');
      }

      // O GitHub responde 200 com `{ error }` no corpo quando o código é
      // inválido ou já foi usado — conferir só o status deixaria passar.
      const payload = (await response.json()) as {
        access_token?: string;
        error?: string;
      };

      if (typeof payload.access_token !== 'string' || payload.access_token === '') {
        throw badGateway('The identity provider rejected the authorization.', 'PROVIDER_REJECTED');
      }

      return payload.access_token;
    },

    async fetchIdentity(accessToken: string): Promise<GitHubIdentity> {
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'prometheon-hub',
        'x-github-api-version': '2022-11-28',
      };

      const profile = await call(`${API_URL}/user`, { headers });

      if (!profile.ok) {
        throw badGateway('The identity provider did not answer.', 'PROVIDER_UNAVAILABLE');
      }

      const user = (await profile.json()) as {
        id?: number;
        login?: string;
        name?: string | null;
        avatar_url?: string | null;
        email?: string | null;
      };

      if (typeof user.id !== 'number' || typeof user.login !== 'string') {
        throw badGateway('The identity provider answered in an unexpected shape.', 'PROVIDER_REJECTED');
      }

      return {
        providerAccountId: String(user.id),
        username: user.login,
        displayName: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
        email: await primaryVerifiedEmail(call, headers, user.email ?? null),
      };
    },
  };
}

/**
 * E-mail primário confirmado.
 *
 * `/user` devolve `email: null` para quem marcou o endereço como privado, que é
 * a configuração recomendada pelo próprio GitHub. Sem consultar `/user/emails`,
 * o cadastro quebraria exatamente para quem cuida da privacidade.
 *
 * O endereço de `/user` também passa por aqui: ele não diz se está verificado, e
 * um e-mail não confirmado não pode servir para achar conta existente.
 */
async function primaryVerifiedEmail(
  call: typeof fetch,
  headers: Record<string, string>,
  fallback: string | null,
): Promise<string | null> {
  const response = await call(`${API_URL}/user/emails`, { headers });

  if (!response.ok) {
    // Sem o escopo `user:email` a chamada responde 403. Não é motivo para
    // derrubar o login: a pessoa entra e o Hub trata a identidade como sem
    // e-mail, que é o caminho conservador.
    return null;
  }

  const emails = (await response.json()) as {
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }[];

  if (!Array.isArray(emails)) {
    return null;
  }

  const verified = emails.filter((entry) => entry.verified === true && typeof entry.email === 'string');
  const primary = verified.find((entry) => entry.primary === true) ?? verified[0];

  if (primary?.email !== undefined) {
    return primary.email.toLowerCase();
  }

  // O endereço de `/user` só serve se ele aparecer confirmado na lista.
  return fallback !== null && verified.some((entry) => entry.email === fallback)
    ? fallback.toLowerCase()
    : null;
}
