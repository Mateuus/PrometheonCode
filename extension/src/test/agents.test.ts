import * as assert from 'node:assert/strict';
import { AgentRegistry, UnknownAgentError } from '../agents/AgentRegistry';
import { MockAgentAdapter } from '../agents/MockAgentAdapter';
import { getApi } from './helpers';

suite('Registro de agentes', () => {
  test('o MockAgentAdapter é registrado e vira Main Agent', async () => {
    const api = await getApi();

    assert.deepEqual(
      api.registry.list().map((adapter) => adapter.id),
      ['mock'],
    );
    assert.equal(api.registry.main.id, 'mock');
    assert.equal(api.registry.main.displayName, 'Mock Agent');
    assert.equal(api.registry.main.transport, 'mock');
    assert.equal(api.core.snapshot.mainAgentId, 'mock');
  });

  test('summaries reporta disponibilidade', async () => {
    const api = await getApi();
    const summaries = await api.registry.summaries();
    assert.deepEqual(summaries, [
      { id: 'mock', displayName: 'Mock Agent', transport: 'mock', available: true },
    ]);
  });

  test('selecionar um agente inexistente não muda o Main Agent', async () => {
    const api = await getApi();
    await api.core.setMainAgent('agente-que-nao-existe');
    assert.equal(api.core.snapshot.mainAgentId, 'mock');
  });

  test('o registro rejeita ids desconhecidos com erro tipado', () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());

    assert.throws(() => registry.setMain('outro'), UnknownAgentError);
    assert.equal(registry.main.id, 'mock');
  });

  test('a interface não depende do adaptador concreto', async () => {
    // Um segundo adaptador com outro id passa a ser selecionável sem que nada
    // além do registro precise mudar.
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());

    const clone = new MockAgentAdapter() as unknown as { id: string; displayName: string };
    clone.id = 'mock-2';
    clone.displayName = 'Second Mock';
    registry.register(clone as unknown as MockAgentAdapter);

    registry.setMain('mock-2');
    assert.equal(registry.main.id, 'mock-2');
    assert.deepEqual(
      registry.list().map((adapter) => adapter.id),
      ['mock', 'mock-2'],
    );
  });
});
