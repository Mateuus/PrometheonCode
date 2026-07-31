/**
 * Bilhete de conexão do ditado por voz.
 *
 * Mesmo desenho do bilhete de tempo real e pelo mesmo motivo: o navegador não
 * pode ter o token de acesso, e `new WebSocket()` não manda cabeçalho. O que
 * viaja na query é um JWT curto, de uso único, que não abre nada por si só.
 *
 * O segredo é o mesmo `AUTH_REALTIME_TOKEN_SECRET`, mas o **público é outro**:
 * `prometheon-transcription`. Sem essa separação um bilhete de ditado seria
 * aceito pelo canal de eventos e vice-versa, e um vazamento em qualquer um dos
 * dois valeria pelos dois. Compartilhar a chave e separar o público dá
 * isolamento sem obrigar quem opera o Hub a gerar mais um segredo.
 */

import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';

import { AUTH_SETTINGS, type AppConfig } from '../../config/index.js';
import { unauthenticated } from '../../shared/errors.js';
import type { PrincipalKind } from '../../shared/fastify.js';
import { TRANSCRIPTION_SETTINGS } from './settings.js';

const TRANSCRIPTION_AUDIENCE = 'prometheon-transcription';

export interface TranscriptionTicketClaims {
  readonly userId: string;
  readonly kind: PrincipalKind;
  readonly organizationId: string | null;
  /** `jti`, queimado no Redis para que o bilhete valha uma conexão só. */
  readonly ticketId: string;
  readonly expiresAt: Date;
}

function secretKey(config: AppConfig): Uint8Array {
  return Buffer.from(config.secrets.realtimeToken, 'utf8');
}

export interface IssueTranscriptionTicketInput {
  readonly userId: string;
  readonly kind: PrincipalKind;
  readonly organizationId: string | null;
  readonly ticketId: string;
}

export async function issueTranscriptionTicket(
  config: AppConfig,
  input: IssueTranscriptionTicketInput,
): Promise<{ token: string; expiresIn: number; expiresAt: Date }> {
  const expiresIn = TRANSCRIPTION_SETTINGS.ticketTtlSeconds;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + expiresIn) * 1000);

  const token = await new SignJWT({
    org: input.organizationId,
    knd: input.kind,
    typ: 'transcription',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setJti(input.ticketId)
    .setIssuer(AUTH_SETTINGS.issuer)
    .setAudience(TRANSCRIPTION_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(secretKey(config));

  return { token, expiresIn, expiresAt };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function verifyTranscriptionTicket(
  config: AppConfig,
  token: string,
): Promise<TranscriptionTicketClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: AUTH_SETTINGS.issuer,
      audience: TRANSCRIPTION_AUDIENCE,
      clockTolerance: 0,
      algorithms: ['HS256'],
    });

    if (payload['typ'] !== 'transcription' || typeof payload.sub !== 'string') {
      throw unauthenticated('The transcription ticket is not valid.', 'TOKEN_INVALID');
    }

    if (typeof payload.jti !== 'string' || payload.jti === '') {
      throw unauthenticated('The transcription ticket is not valid.', 'TOKEN_INVALID');
    }

    return {
      userId: payload.sub,
      kind: payload['knd'] === 'device' ? 'device' : 'user',
      organizationId: optionalString(payload['org']),
      ticketId: payload.jti,
      expiresAt: new Date((payload.exp ?? 0) * 1000),
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw unauthenticated('The transcription ticket has expired.', 'TOKEN_EXPIRED');
    }

    throw unauthenticated('The transcription ticket is not valid.', 'TOKEN_INVALID');
  }
}
