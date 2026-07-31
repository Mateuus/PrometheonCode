/**
 * Access token.
 *
 * É um JWT HS256 assinado com `AUTH_ACCESS_TOKEN_SECRET`, emitido pela `jose`.
 * HS256 e não RS256 porque quem assina e quem verifica são o mesmo serviço: um
 * par de chaves só acrescentaria gestão de chave pública sem resolver nada que
 * já não esteja resolvido.
 *
 * O que o token carrega é o mínimo para autorizar sem ir ao banco: quem é
 * (`sub`), de qual sessão (`sid`) e qual organização está ativa (`org`). Papel e
 * permissão **não** entram — eles mudam sem que o token mude, e um token que
 * carrega privilégio congelado é um privilégio revogado que continua valendo.
 */

import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';

import { AUTH_SETTINGS, type AppConfig } from '../../config/index.js';
import { unauthenticated } from '../../shared/errors.js';

/**
 * Prefixo da credencial de dispositivo.
 *
 * Access token e credencial de dispositivo chegam no mesmo header
 * `Authorization`. Tentar verificar um como se fosse o outro produziria erro
 * confuso; o prefixo torna a distinção explícita e custa um `startsWith`.
 */
export const DEVICE_TOKEN_PREFIX = 'pdt_';

export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string | null;
  /** Identificador do próprio token, para rastrear em auditoria. */
  readonly tokenId: string;
  readonly expiresAt: Date;
}

/** Segredo em bytes. Base64url no `.env`, cru aqui. */
function secretKey(config: AppConfig): Uint8Array {
  return Buffer.from(config.secrets.accessToken, 'utf8');
}

export interface IssueAccessTokenInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string | null;
  readonly tokenId: string;
}

export async function issueAccessToken(
  config: AppConfig,
  input: IssueAccessTokenInput,
): Promise<{ token: string; expiresIn: number; expiresAt: Date }> {
  const expiresIn = AUTH_SETTINGS.accessTokenTtlSeconds;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + expiresIn) * 1000);

  const token = await new SignJWT({
    sid: input.sessionId,
    org: input.organizationId,
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(input.tokenId)
    .setIssuer(AUTH_SETTINGS.issuer)
    .setAudience(AUTH_SETTINGS.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(secretKey(config));

  return { token, expiresIn, expiresAt };
}

export async function verifyAccessToken(
  config: AppConfig,
  token: string,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: AUTH_SETTINGS.issuer,
      audience: AUTH_SETTINGS.audience,
      // Sem tolerância de relógio: emissor e verificador são o mesmo processo.
      clockTolerance: 0,
      algorithms: ['HS256'],
    });

    if (payload['typ'] !== 'access' || typeof payload.sub !== 'string') {
      throw unauthenticated('The access token is not valid.', 'TOKEN_INVALID');
    }

    const sessionId = payload['sid'];
    const organizationId = payload['org'];

    if (typeof sessionId !== 'string') {
      throw unauthenticated('The access token is not valid.', 'TOKEN_INVALID');
    }

    return {
      userId: payload.sub,
      sessionId,
      organizationId: typeof organizationId === 'string' ? organizationId : null,
      tokenId: typeof payload.jti === 'string' ? payload.jti : '',
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw unauthenticated('The access token has expired.', 'TOKEN_EXPIRED');
    }

    // Assinatura inválida, formato quebrado, emissor errado: tudo vira a mesma
    // resposta. Detalhar qual verificação falhou ajuda quem está forjando.
    throw unauthenticated('The access token is not valid.', 'TOKEN_INVALID');
  }
}
