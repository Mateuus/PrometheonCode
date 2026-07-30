import { describe, expect, it } from 'vitest';
import { backoffDelay, statusForAttempt } from './client';

/**
 * Reconexão do canal ao vivo.
 *
 * O que estes testes protegem é o significado dos estados: "reconectando" só
 * vale enquanto ainda é razoável prometer que a conexão volta em seguida. Depois
 * disso a interface tem de dizer offline, mesmo continuando a tentar por baixo —
 * é a diferença entre informar e enrolar.
 */

describe('estado da conexão', () => {
  it('sem tentativa em curso, está online', () => {
    expect(statusForAttempt(0)).toBe('online');
  });

  it('as primeiras tentativas são reconexão', () => {
    expect(statusForAttempt(1)).toBe('reconnecting');
    expect(statusForAttempt(3)).toBe('reconnecting');
  });

  it('depois de insistir sem sucesso, a interface assume o offline', () => {
    expect(statusForAttempt(4)).toBe('offline');
    expect(statusForAttempt(30)).toBe('offline');
  });
});

describe('recuo exponencial', () => {
  it('dobra a cada tentativa', () => {
    expect(backoffDelay(1)).toBe(1_000);
    expect(backoffDelay(2)).toBe(2_000);
    expect(backoffDelay(3)).toBe(4_000);
  });

  it('para de crescer no teto, para a aba não desistir de vez', () => {
    expect(backoffDelay(20)).toBe(30_000);
  });
});
