// Geração de ULID: formato, monotonicidade e tempo embutido.

import { beforeEach, describe, expect, it } from 'vitest';

import { isUlid, newId, resetIdState, ULID_LENGTH, ulidTime } from './id.js';

describe('newId', () => {
  beforeEach(() => {
    resetIdState();
  });

  it('gera 26 caracteres do alfabeto de Crockford', () => {
    const id = newId();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(isUlid(id)).toBe(true);
    // Sem I, L, O e U — as letras que se confundem com dígitos.
    expect(id).not.toMatch(/[ILOU]/);
  });

  it('mantém a ordem lexicográfica dentro do mesmo milissegundo', () => {
    const now = 1_760_000_000_000;
    const ids = Array.from({ length: 1000 }, () => newId(now));

    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
    // Todos carimbam o mesmo instante: a ordem veio da parte aleatória.
    expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(1);
  });

  it('mantém a ordem quando o tempo avança', () => {
    const first = newId(1_760_000_000_000);
    const second = newId(1_760_000_000_001);
    const third = newId(1_760_000_001_000);
    expect([first, second, third].sort()).toEqual([first, second, third]);
  });

  it('não anda para trás quando o relógio recua', () => {
    const before = newId(1_760_000_000_500);
    const afterClockJump = newId(1_760_000_000_100);
    expect(afterClockJump > before).toBe(true);
    // O carimbo preservado é o maior instante já visto, não o do relógio.
    expect(ulidTime(afterClockJump)).toBe(1_760_000_000_500);
  });

  it('devolve o instante de criação', () => {
    const now = Date.now();
    expect(ulidTime(newId(now))).toBe(now);
  });

  it('recusa texto que não é ULID', () => {
    expect(isUlid('abc')).toBe(false);
    // Minúsculas e as letras ambíguas não pertencem ao alfabeto.
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
    expect(() => ulidTime('não-é-ulid')).toThrow(/ULID/);
  });
});
