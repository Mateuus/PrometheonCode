/**
 * Tokens de uso único e denylist de sessão, no Redis.
 *
 * DECISÃO DE PROJETO — por que Redis e não uma tabela:
 *
 * O schema de `@prometheon/database` (49 tabelas, já migrado) não tem tabela
 * para token de verificação de e-mail nem para recuperação de senha. Criar uma
 * exigiria migração no pacote de outro agente, no meio de uma rodada em que ele
 * está sendo escrito em paralelo. Estes tokens, além disso, têm exatamente o
 * perfil que o Redis resolve melhor: vida curta (30 minutos a 24 horas),
 * expiração automática, consumo atômico e nenhum valor histórico. Perder um
 * numa reinicialização do Redis custa ao usuário um clique em "reenviar".
 *
 * O que **não** vive aqui: refresh token e credencial de dispositivo. Esses são
 * permanentes, precisam de rastro para investigar reuso, e já têm tabela.
 *
 * Regra em todas as chaves: a chave é o **hash** do token, nunca o token. Quem
 * conseguir ler o Redis não consegue montar um link válido.
 */

import { AUTH_SETTINGS } from '../../config/index.js';
import { hashToken, randomToken } from '../../shared/crypto.js';
import type { RedisClient } from '../../plugins/redis.js';

export type SingleUseTokenKind = 'email-verification' | 'password-reset';

const PREFIX: Readonly<Record<SingleUseTokenKind, string>> = {
  'email-verification': 'auth:verify:',
  'password-reset': 'auth:reset:',
};

const TTL: Readonly<Record<SingleUseTokenKind, number>> = {
  'email-verification': AUTH_SETTINGS.emailVerificationTtlSeconds,
  'password-reset': AUTH_SETTINGS.passwordResetTtlSeconds,
};

export interface IssuedSingleUseToken {
  /** Valor puro. Vai para o e-mail e some daqui. */
  readonly token: string;
  readonly expiresInSeconds: number;
}

export async function issueSingleUseToken(
  redis: RedisClient,
  kind: SingleUseTokenKind,
  userId: string,
): Promise<IssuedSingleUseToken> {
  const token = randomToken();
  const ttl = TTL[kind];

  await redis.set(`${PREFIX[kind]}${hashToken(token)}`, userId, 'EX', ttl);

  return { token, expiresInSeconds: ttl };
}

/**
 * Consome o token e devolve o usuário.
 *
 * `GETDEL` é uma única operação no servidor: dois pedidos simultâneos com o
 * mesmo token não conseguem ambos receber o valor. É o que faz "uso único" ser
 * verdade sob concorrência, e não só na leitura sequencial do código.
 */
export async function consumeSingleUseToken(
  redis: RedisClient,
  kind: SingleUseTokenKind,
  token: string,
): Promise<string | null> {
  return redis.getdel(`${PREFIX[kind]}${hashToken(token)}`);
}

// ---------------------------------------------------------------------------
// `state` do login por provedor externo
// ---------------------------------------------------------------------------

const OAUTH_STATE_PREFIX = 'auth:oauth-state:';

/**
 * Dez minutos: o suficiente para a pessoa ler a tela de consentimento do
 * provedor e decidir, curto o bastante para um `state` capturado não servir
 * depois. O fluxo inteiro leva segundos.
 */
const OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthStatePayload {
  /** Para onde mandar o navegador quando o login terminar. */
  readonly redirectTo: string;
  /**
   * Quem pediu, quando o fluxo é de **vinculação** — alguém já autenticado
   * ligando o GitHub à conta que já tem. Nulo é login comum.
   *
   * Guardar aqui, e não num parâmetro da URL de volta, é o que impede alguém de
   * trocar o alvo da vinculação no meio do caminho.
   */
  readonly userId: string | null;
}

/**
 * Emite o `state` que amarra o callback ao pedido que o originou.
 *
 * Sem isso, qualquer site consegue mandar o navegador de uma vítima ao callback
 * com um `code` do atacante — e a conta do Hub da vítima acabaria vinculada ao
 * GitHub de outra pessoa, que passaria a entrar nela quando quisesse.
 *
 * Como nos outros tokens deste arquivo, a chave é o hash: quem ler o Redis não
 * consegue montar um callback válido.
 */
export async function issueOAuthState(
  redis: RedisClient,
  payload: OAuthStatePayload,
): Promise<string> {
  const state = randomToken();

  await redis.set(
    `${OAUTH_STATE_PREFIX}${hashToken(state)}`,
    JSON.stringify(payload),
    'EX',
    OAUTH_STATE_TTL_SECONDS,
  );

  return state;
}

/** Consome o `state`. Uso único, pelo mesmo `GETDEL` atômico dos demais. */
export async function consumeOAuthState(
  redis: RedisClient,
  state: string,
): Promise<OAuthStatePayload | null> {
  const raw = await redis.getdel(`${OAUTH_STATE_PREFIX}${hashToken(state)}`);

  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const { redirectTo, userId } = parsed as Record<string, unknown>;

    return {
      redirectTo: typeof redirectTo === 'string' ? redirectTo : '/',
      userId: typeof userId === 'string' ? userId : null,
    };
  } catch {
    // Valor corrompido vale o mesmo que ausente: o fluxo recomeça.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entrega da sessão ao cliente que iniciou o login
// ---------------------------------------------------------------------------

const OAUTH_HANDOFF_PREFIX = 'auth:oauth-handoff:';

/**
 * Trinta segundos: o tempo de um redirecionamento, não mais.
 *
 * O código aparece na barra de endereços, e daí vai para o histórico do
 * navegador e para o log de qualquer proxy no caminho. Uma vida curta é o que
 * garante que, quando ele vazar por um desses lugares, já não valha nada.
 */
const OAUTH_HANDOFF_TTL_SECONDS = 30;

/**
 * Guarda a identidade já confirmada atrás de um código de uso único.
 *
 * O callback do provedor termina na API, mas quem precisa da sessão é o Hub Web,
 * que roda em outro host — cookie posto pela API não chega lá. Mandar o token na
 * URL do redirecionamento resolveria e seria péssimo: o access token ficaria no
 * histórico do navegador e no `Referer` de toda requisição seguinte.
 *
 * O que viaja na URL é um código que morre em trinta segundos e só funciona uma
 * vez. E ele não guarda token nenhum, só o identificador do usuário: a sessão
 * nasce no `exchange`, exatamente como no login por senha. Guardar tokens
 * prontos no Redis significaria segredo utilizável em texto puro fora do banco,
 * que é o que este arquivo inteiro existe para evitar.
 */
export async function issueOAuthHandoff(redis: RedisClient, userId: string): Promise<string> {
  const code = randomToken();

  await redis.set(
    `${OAUTH_HANDOFF_PREFIX}${hashToken(code)}`,
    userId,
    'EX',
    OAUTH_HANDOFF_TTL_SECONDS,
  );

  return code;
}

export async function consumeOAuthHandoff(
  redis: RedisClient,
  code: string,
): Promise<string | null> {
  return redis.getdel(`${OAUTH_HANDOFF_PREFIX}${hashToken(code)}`);
}

// ---------------------------------------------------------------------------
// Denylist de sessão
// ---------------------------------------------------------------------------

const SESSION_DENY_PREFIX = 'auth:session-revoked:';

/**
 * Marca a sessão como revogada.
 *
 * O access token é um JWT e vale até expirar; a revogação da sessão precisa
 * alcançá-lo antes disso. O TTL da marca é o do access token: passado esse
 * tempo, nenhum token daquela sessão ainda existe, e a entrada some sozinha.
 *
 * O banco continua sendo a fonte da verdade (`user_sessions.revoked_at`); esta
 * chave é o atalho que evita uma consulta por requisição.
 */
export async function denySession(redis: RedisClient, sessionId: string): Promise<void> {
  await redis.set(
    `${SESSION_DENY_PREFIX}${sessionId}`,
    '1',
    'EX',
    AUTH_SETTINGS.accessTokenTtlSeconds,
  );
}

export async function isSessionDenied(
  redis: RedisClient,
  sessionId: string,
): Promise<boolean> {
  return (await redis.exists(`${SESSION_DENY_PREFIX}${sessionId}`)) === 1;
}
