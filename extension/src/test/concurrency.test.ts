import * as assert from 'node:assert/strict';
import { ConcurrencyGuard } from '../agents/ConcurrencyGuard';

suite('ConcurrencyGuard', () => {
  test('a segunda reserva do mesmo agente de uma vaga é recusada', () => {
    // O caso real: três delegações no mesmo turno, todas chegando juntas.
    // Contar quem já está na lista de ativos deixava as três passarem, porque
    // nenhuma tinha entrado nela ainda quando as outras conferiram.
    const guard = new ConcurrencyGuard();
    assert.equal(guard.tryReserve('pesquisador', 'Pesquisador', 1, 6).ok, true);

    const second = guard.tryReserve('pesquisador', 'Pesquisador', 1, 6);
    assert.equal(second.ok, false);
    assert.match(second.ok ? '' : second.reason, /already at that limit/);
    assert.equal(guard.running, 1);
  });

  test('o teto da máquina vale mesmo com agentes diferentes', () => {
    const guard = new ConcurrencyGuard();
    for (let i = 0; i < 2; i += 1) {
      assert.equal(guard.tryReserve(`a${String(i)}`, 'A', 3, 2).ok, true);
    }
    const refused = guard.tryReserve('outro', 'Outro', 3, 2);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.reason, /globalConcurrency/);
  });

  test('liberar devolve a vaga, e liberar demais não deixa o contador negativo', () => {
    const guard = new ConcurrencyGuard();
    guard.tryReserve('x', 'X', 1, 6);
    guard.release('x');
    assert.equal(guard.running, 0);
    guard.release('x');
    guard.release('nunca-reservado');
    assert.equal(guard.running, 0);
    // E a vaga liberada volta a existir de verdade.
    assert.equal(guard.tryReserve('x', 'X', 1, 6).ok, true);
  });
});
