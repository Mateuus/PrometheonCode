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
