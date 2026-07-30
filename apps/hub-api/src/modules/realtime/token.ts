/**
 * Token curto do handshake (`Docs/08`, passo 1).
 *
 * É um JWT HS256 assinado com `AUTH_REALTIME_TOKEN_SECRET` — segredo próprio, e
 * não o do access token, para que um vazamento de log de proxy não vire uma
 * credencial de API. O que ele carrega é o mínimo para reconstruir o principal
 * sem ir ao banco: quem é, de qual sessão ou dispositivo, e qual organização
 * estava ativa.
 *
 * **Papel e permissão não entram.** Eles são resolvidos no `hello` e reavaliados
 * enquanto a conexão vive; um token que carregasse privilégio congelado seria um
 * privilégio revogado que continua valendo, que é justamente o que o `Docs/09`
 * proíbe.
 */

import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';

import { AUTH_SETTINGS, type AppConfig } from '../../config/index.js';
import { unauthenticated } from '../../shared/errors.js';
import type { PrincipalKind } from '../../shared/fastify.js';
import { REALTIME_SETTINGS } from './settings.js';

/** Público próprio: um token de realtime não é aceito pelas rotas REST. */
const REALTIME_AUDIENCE = 'prometheon-realtime';

export interface RealtimeTokenClaims {
  readonly userId: string;
  readonly kind: PrincipalKind;
  readonly sessionId: string | null;
  readonly deviceId: string | null;
  readonly organizationId: string | null;
  /** `jti`, queimado no Redis para que o token valha uma conexão só. */
  readonly tokenId: string;
  readonly expiresAt: Date;
}

function secretKey(config: AppConfig): Uint8Array {
  return Buffer.from(config.secrets.realtimeToken, 'utf8');
}

export interface IssueRealtimeTokenInput {
  readonly userId: string;
  readonly kind: PrincipalKind;
  readonly sessionId: string | null;
  readonly deviceId: string | null;
  readonly organizationId: string | null;
  readonly tokenId: string;
}

export async function issueRealtimeToken(
  config: AppConfig,
  input: IssueRealtimeTokenInput,
): Promise<{ token: string; expiresIn: number; expiresAt: Date }> {
  const expiresIn = REALTIME_SETTINGS.tokenTtlSeconds;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + expiresIn) * 1000);

  const token = await new SignJWT({
    sid: input.sessionId,
    did: input.deviceId,
    org: input.organizationId,
    knd: input.kind,
    typ: 'realtime',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(input.tokenId)
    .setIssuer(AUTH_SETTINGS.issuer)
    .setAudience(REALTIME_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(secretKey(config));

  return { token, expiresIn, expiresAt };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function verifyRealtimeToken(
  config: AppConfig,
  token: string,
): Promise<RealtimeTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: AUTH_SETTINGS.issuer,
      audience: REALTIME_AUDIENCE,
      clockTolerance: 0,
      algorithms: ['HS256'],
    });

    if (payload['typ'] !== 'realtime' || typeof payload.sub !== 'string') {
      throw unauthenticated('The realtime token is not valid.', 'TOKEN_INVALID');
    }

    if (typeof payload.jti !== 'string' || payload.jti === '') {
      throw unauthenticated('The realtime token is not valid.', 'TOKEN_INVALID');
    }

    const kind = payload['knd'] === 'device' ? 'device' : 'user';

    return {
      userId: payload.sub,
      kind,
      sessionId: optionalString(payload['sid']),
      deviceId: optionalString(payload['did']),
      organizationId: optionalString(payload['org']),
      tokenId: payload.jti,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw unauthenticated('The realtime token has expired.', 'TOKEN_EXPIRED');
    }

    throw unauthenticated('The realtime token is not valid.', 'TOKEN_INVALID');
  }
}
