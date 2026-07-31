// O backoff é a peça que não pode ser conferida "no olho": um erro aqui só
// aparece em produção, na forma de retentativa sincronizada derrubando o
// serviço que estava se recuperando.

import { describe, expect, it } from 'vitest';

import { backoffDelay, nextAttemptAt } from './backoff.js';

const options = { baseMs: 1_000, maxMs: 60_000 } as const;

describe('backoff exponencial com jitter', () => {
  it('dobra a cada tentativa quando o jitter está desligado', () => {
    const jitterless = { ...options, jitter: 'none' } as const;
    expect(backoffDelay(1, jitterless)).toBe(1_000);
    expect(backoffDelay(2, jitterless)).toBe(2_000);
    expect(backoffDelay(3, jitterless)).toBe(4_000);
    expect(backoffDelay(4, jitterless)).toBe(8_000);
  });

  it('respeita o teto', () => {
    const jitterless = { ...options, jitter: 'none' } as const;
    expect(backoffDelay(20, jitterless)).toBe(60_000);
    expect(backoffDelay(100, jitterless)).toBe(60_000);
  });

  it('mantém o jitter "equal" entre metade e o degrau inteiro', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const step = Math.min(1_000 * 2 ** (attempt - 1), 60_000);
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = backoffDelay(attempt, options);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(step / 2));
        expect(delay).toBeLessThanOrEqual(step);
      }
    }
  });

  it('espalha as retentativas: dois clientes não voltam no mesmo instante', () => {
    const delays = new Set(
      Array.from({ length: 200 }, () => backoffDelay(5, options)),
    );
    // Com jitter de verdade, 200 sorteios não colapsam num punhado de valores.
    expect(delays.size).toBeGreaterThan(50);
  });

  it('o jitter "full" pode chegar perto de zero, o "equal" não', () => {
    const random = (): number => 0;
    expect(backoffDelay(3, { ...options, jitter: 'full', random })).toBe(0);
    expect(backoffDelay(3, { ...options, jitter: 'equal', random })).toBe(2_000);
  });

  it('nunca devolve valor negativo nem fracionário', () => {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const delay = backoffDelay(attempt, options);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('projeta o próximo instante a partir do relógio informado', () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const at = nextAttemptAt(1, { ...options, jitter: 'none' }, now);
    expect(at.toISOString()).toBe('2026-07-30T12:00:01.000Z');
  });
});
