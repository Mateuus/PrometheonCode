import * as assert from 'node:assert/strict';
import { evaluatePermission } from '../permissions/PermissionPolicy';
import { EMPTY_PROJECT_POLICY } from '../permissions/types';
import { normalizeConfig } from '../workspace/types';
import { getApi } from './helpers';

suite('Persistência de preferências', () => {
  test('Work Mode é persistido no estado local', async () => {
    const api = await getApi();

    await api.core.setWorkMode('agent-team');
    assert.equal(api.core.snapshot.workMode, 'agent-team');
    assert.equal(api.localState.getWorkMode(), 'agent-team');

    await api.core.setWorkMode('edit');
    assert.equal(api.localState.getWorkMode(), 'edit');
  });

  test('Autonomy é persistida no estado local', async () => {
    const api = await getApi();

    await api.core.setAutonomy('auto');
    assert.equal(api.core.snapshot.autonomy, 'auto');
    assert.equal(api.localState.getAutonomy(), 'auto');

    await api.core.setAutonomy('manual');
    assert.equal(api.localState.getAutonomy(), 'manual');
  });

  test('o Main Agent escolhido é persistido', async () => {
    const api = await getApi();
    await api.core.setMainAgent('mock');
    assert.equal(api.localState.getMainAgentId('outro'), 'mock');
  });
});

suite('Bypass não persiste', () => {
  test('gravar bypass no estado local é ignorado', async () => {
    const api = await getApi();
    await api.localState.setAutonomy('auto');

    await api.localState.setAutonomy('bypass');
    assert.notEqual(api.localState.getAutonomy(), 'bypass');
    assert.equal(api.localState.getAutonomy(), 'auto');

    await api.localState.setAutonomy('manual');
  });

  test('bypass no prometheon.yaml é normalizado para manual', () => {
    const config = normalizeConfig(
      { version: 1, orchestration: { autonomy: 'bypass', workMode: 'edit' } },
      'fixture',
    );
    assert.equal(config.orchestration.autonomy, 'manual');
    assert.equal(config.orchestration.workMode, 'edit');
  });

  test('sem concessão em memória, o nível bypass não autoriza nada', () => {
    // Estado equivalente a "extensão reiniciada": não há BypassGrant.
    const result = evaluatePermission(
      { action: 'terminal.run' },
      {
        workMode: 'edit',
        autonomy: 'bypass',
        bypass: null,
        projectPolicy: EMPTY_PROJECT_POLICY,
      },
    );
    assert.equal(result.decision, 'ask');
  });

  test('a sessão começa sem bypass ativo', async () => {
    const api = await getApi();
    assert.equal(api.core.snapshot.bypass, null);
    assert.equal(api.core.isBypassActive, false);
  });
});
