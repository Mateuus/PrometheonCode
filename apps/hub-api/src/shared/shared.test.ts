/**
 * Cursor, hash de token e código de dispositivo.
 *
 * Testes puros: nada aqui abre conexão.
 */

import { describe, expect, it } from 'vitest';

import {
  generateUserCode,
  hashToken,
  normalizeUserCode,
  randomToken,
  safeEqual,
} from './crypto.js';
import { buildPage, decodeCursor, encodeCursor } from './cursor.js';
import { ApiError, isApiError, tooManyRequests } from './errors.js';

describe('cursor de paginação', () => {
  it('sobrevive à ida e à volta', () => {
    const payload = { at: 1_785_000_000_123, id: '01JQZX9K7M4E5N6P7R8S9T0V1W' };
    const decoded = decodeCursor(encodeCursor(payload));

    expect(decoded).toEqual(payload);
  });

  it('é opaco para o cliente', () => {
    const cursor = encodeCursor({ at: 1_785_000_000_000, id: '01JQZX9K7M4E5N6P7R8S9T0V1W' });

    // Base64url: nada de `+`, `/` ou `=` para escapar em URL.
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('recusa cursor adulterado', () => {
    expect(() => decodeCursor('nao-e-um-cursor')).toThrow(ApiError);
    expect(() => decodeCursor(Buffer.from('123.curto').toString('base64url'))).toThrow(ApiError);
  });

  it('lê um item a mais para responder `hasMore` sem contar a tabela', () => {
    const rows = [1, 2, 3, 4].map((value) => ({
      id: `01JQZX9K7M4E5N6P7R8S9T0V${String(value)}W`,
      createdAt: new Date(1_785_000_000_000 + value),
    }));

    const page = buildPage(rows, 3, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    expect(page.items).toHaveLength(3);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextCursor).not.toBeNull();

    const last = page.items.at(-1);

    expect(decodeCursor(page.pageInfo.nextCursor as string)).toEqual({
      at: last?.createdAt.getTime(),
      id: last?.id,
    });
  });

  it('não anuncia próxima página quando os itens acabam', () => {
    const page = buildPage([{ id: 'a', createdAt: new Date(1) }], 3, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    expect(page.pageInfo.hasMore).toBe(false);
    expect(page.pageInfo.nextCursor).toBeNull();
  });
});

describe('tokens', () => {
  it('gera 256 bits em base64url', () => {
    const token = randomToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(randomToken()).not.toBe(token);
  });

  it('o hash é estável, hexadecimal e não reversível ao valor', () => {
    const token = randomToken();
    const digest = hashToken(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(digest);
    expect(digest).not.toContain(token);
  });

  it('compara em tempo constante sem estourar em tamanhos diferentes', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('código de dispositivo', () => {
  it('usa o alfabeto sem letras ambíguas, no formato XXXX-XXXX', () => {
    for (let index = 0; index < 50; index += 1) {
      // Sem I, L, O nem U: ninguém confunde `0` com `O` lendo em voz alta.
      expect(generateUserCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('normaliza o que o usuário digita', () => {
    expect(normalizeUserCode('r5rw vzwh')).toBe('R5RW-VZWH');
    expect(normalizeUserCode('R5RWVZWH')).toBe('R5RW-VZWH');
    expect(normalizeUserCode('  r5rw-vzwh  ')).toBe('R5RW-VZWH');
  });
});

describe('erros da API', () => {
  it('carrega código estável, status e `Retry-After`', () => {
    const error = tooManyRequests('Devagar.', new Date(Date.now() + 30_000));

    expect(isApiError(error)).toBe(true);
    expect(error.statusCode).toBe(429);
    expect(error.code).toBe('RATE_LIMITED');
    expect(Number(error.headers?.['retry-after'])).toBeGreaterThan(0);
  });
});
