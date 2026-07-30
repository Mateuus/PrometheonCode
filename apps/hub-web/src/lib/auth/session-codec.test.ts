import { describe, expect, it } from 'vitest';
import {
  accessTokenExpired,
  decodeSession,
  encodeSession,
  sessionCookieOptions,
  type Session,
} from './session-codec';

/**
 * O cookie de sessão é lido em dois lugares com capacidades diferentes: o
 * servidor do app e o middleware. Estes testes protegem o que os dois compartilham
 * — a codificação e a decisão de renovar.
 */

const session: Session = {
  accessToken: 'token-de-acesso',
  accessExpiresAt: new Date('2026-01-01T00:15:00.000Z').toISOString(),
  refreshToken: 'refresh',
  csrfToken: 'csrf',
  sessionId: '01JB7Q4X2N0000000000000001',
  user: {
    id: '01JB7Q4X2N0000000000000002',
    name: 'Fulana de Tal',
    email: 'fulana@exemplo.test',
    emailVerified: true,
  },
};

describe('codificação da sessão', () => {
  it('ida e volta preserva a sessão', () => {
    expect(decodeSession(encodeSession(session))).toEqual(session);
  });

  it('sobrevive a acento e caractere fora do ASCII', () => {
    const acentuada: Session = { ...session, user: { ...session.user, name: 'João Ção 中文' } };
    expect(decodeSession(encodeSession(acentuada))?.user.name).toBe('João Ção 中文');
  });

  it('recusa cookie ausente, corrompido ou fora do formato', () => {
    expect(decodeSession(undefined)).toBeNull();
    expect(decodeSession('não é base64url!!')).toBeNull();
    expect(decodeSession(Buffer.from('{"foo":1}', 'utf8').toString('base64url'))).toBeNull();
  });
});

describe('renovação do access token', () => {
  const at = (iso: string) => Date.parse(iso);

  it('token com folga não precisa renovar', () => {
    expect(accessTokenExpired(session, at('2026-01-01T00:05:00.000Z'))).toBe(false);
  });

  it('renova antes de vencer, não depois', () => {
    // A margem existe para o token não morrer no meio de uma navegação.
    expect(accessTokenExpired(session, at('2026-01-01T00:14:30.000Z'))).toBe(true);
  });

  it('data ilegível conta como vencida', () => {
    expect(accessTokenExpired({ ...session, accessExpiresAt: 'ontem' })).toBe(true);
  });
});

describe('opções do cookie', () => {
  it('é sempre HttpOnly e sai do subdomínio inteiro', () => {
    const options = sessionCookieOptions(false);
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
    expect(options.sameSite).toBe('lax');
  });

  it('em produção o cookie exige TLS', () => {
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
