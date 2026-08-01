import { describe, expect, it } from 'vitest';
import { normalizeUserCode } from './device-code';

/**
 * Espelho do teste da hub-api (`apps/hub-api/src/shared/shared.test.ts`): as
 * duas pontas normalizam o mesmo código do mesmo jeito, e este arquivo é o que
 * denuncia se uma delas mudar sozinha.
 */
describe('normalizeUserCode', () => {
  it('aceita o que o usuário cola do editor', () => {
    expect(normalizeUserCode('r5rw vzwh')).toBe('R5RW-VZWH');
    expect(normalizeUserCode('R5RWVZWH')).toBe('R5RW-VZWH');
    expect(normalizeUserCode('  r5rw-vzwh  ')).toBe('R5RW-VZWH');
  });

  it('só hifeniza o comprimento canônico de oito símbolos', () => {
    expect(normalizeUserCode('abc')).toBe('ABC');
    expect(normalizeUserCode('abcdefghij')).toBe('ABCDEFGHIJ');
  });

  it('devolve vazio para ausência de código', () => {
    expect(normalizeUserCode(undefined)).toBe('');
    expect(normalizeUserCode(null)).toBe('');
    expect(normalizeUserCode('  --  ')).toBe('');
  });
});
