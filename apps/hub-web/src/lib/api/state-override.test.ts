import { describe, expect, it } from 'vitest';
import { applyForcedState, isForcedState, readForcedState } from './state-override';
import { success } from './result';

describe('estados forçados pela URL', () => {
  it('ignora o parâmetro quando os dados de exemplo estão desligados', () => {
    expect(readForcedState({ state: 'offline' }, false)).toBeUndefined();
  });

  it('lê o parâmetro quando os dados de exemplo estão ligados', () => {
    expect(readForcedState({ state: 'offline' }, true)).toBe('offline');
    expect(readForcedState({ state: ['forbidden'] }, true)).toBe('forbidden');
  });

  it('recusa valor que não é um dos sete estados', () => {
    expect(readForcedState({ state: 'explode' }, true)).toBeUndefined();
    expect(isForcedState('stale')).toBe(true);
    expect(isForcedState('explode')).toBe(false);
  });

  it('converte o resultado no estado pedido', async () => {
    const original = success(['a', 'b']);

    await expect(applyForcedState('offline', original)).resolves.toMatchObject({
      ok: false,
      kind: 'offline',
    });
    await expect(applyForcedState('forbidden', original)).resolves.toMatchObject({
      ok: false,
      kind: 'forbidden',
    });
    await expect(applyForcedState('error', original)).resolves.toMatchObject({
      ok: false,
      kind: 'error',
    });
    await expect(applyForcedState('empty', original, [])).resolves.toMatchObject({
      ok: true,
      data: [],
    });
    await expect(applyForcedState('stale', original)).resolves.toMatchObject({
      ok: true,
      stale: true,
    });
  });

  it('deixa o resultado intacto quando nada é forçado', async () => {
    const original = success(1);
    await expect(applyForcedState(undefined, original)).resolves.toBe(original);
  });

  it('mantém o dado carregado no estado de reconexão', async () => {
    // Reconectar é problema do canal ao vivo; o que já chegou continua válido.
    const original = success(42);
    await expect(applyForcedState('reconnecting', original)).resolves.toMatchObject({
      ok: true,
      data: 42,
    });
  });
});
