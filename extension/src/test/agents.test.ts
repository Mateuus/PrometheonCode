import * as assert from 'node:assert/strict';
import { AgentRegistry, UnknownAgentError } from '../agents/AgentRegistry';
import { MockAgentAdapter } from '../agents/MockAgentAdapter';
import { getApi } from './helpers';

suite('Registro de agentes', () => {
  test('os adaptadores são registrados, e o mock é o principal de partida', async () => {
    const api = await getApi();

    assert.deepEqual(
      api.registry.list().map((adapter) => adapter.id),
      ['mock', 'claude-code', 'codex-cli'],
    );

    // O mock vem primeiro **de propósito**: o registro promove a principal quem
    // chega primeiro, e o principal precisa ser algo que sempre responde. O
    // Claude Code assume depois, e só se o CLI existir de fato — numa máquina
    // sem ele, o painel continuaria mudo na primeira mensagem.
    assert.equal(api.registry.main.id, 'mock');
    assert.equal(api.registry.main.transport, 'mock');
    assert.equal(api.core.snapshot.mainAgentId, 'mock');
  });

  test('o adaptador do Claude Code declara transporte de CLI e sabe editar', async () => {
    const api = await getApi();
    const claude = api.registry.get('claude-code');

    assert.ok(claude, 'o Claude Code precisa estar registrado');
    assert.equal(claude?.transport, 'cli');
    // O modo Agent Team só é oferecido a quem sabe delegar; sem esta capacidade
    // declarada, a opção apareceria e falharia depois de o usuário escolher.
    assert.equal(claude?.capabilities.delegate, true);
    assert.equal(claude?.capabilities.edit, true);
  });

  test('o adaptador do Codex declara o vocabulário de esforço dele', async () => {
    const api = await getApi();
    const codex = api.registry.get('codex-cli');

    assert.ok(codex, 'o Codex precisa estar registrado');
    assert.equal(codex?.transport, 'cli');
    // Os nomes são os que a interface do Codex mostra; a escala por baixo é a
    // mesma do Prometheon. `ultracode` fica de fora: é degrau do Claude Code.
    assert.equal(codex?.effortLabels?.low, 'Light');
    assert.equal(codex?.effortLabels?.max, 'Ultra');
    assert.equal(codex?.effortLabels?.ultracode, undefined);
    // Sem delegação: o `codex exec` não abre subagentes, e oferecer o modo
    // Agent Team com ele escolhido falharia depois da escolha.
    assert.equal(codex?.capabilities.delegate, false);
  });

  test('o painel oferece os dois provedores ao criar conta', async () => {
    const api = await getApi();

    // É o que alimenta o seletor "Provedor" do formulário de conta: se um
    // adaptador não estiver aqui, ele não existe para quem usa o painel.
    assert.deepEqual(
      api.core.snapshot.providers.map((provider) => provider.id),
      ['claude-code', 'codex-cli'],
    );
    assert.equal(
      api.core.snapshot.providers.find((provider) => provider.id === 'codex-cli')?.name,
      'Codex',
    );
  });

  test('summaries reporta todos, com a disponibilidade real de cada um', async () => {
    const api = await getApi();
    const summaries = await api.registry.summaries();

    assert.deepEqual(
      summaries.map((summary) => summary.id),
      ['mock', 'claude-code', 'codex-cli'],
    );

    const mock = summaries.find((summary) => summary.id === 'mock');
    assert.equal(mock?.available, true);

    // A disponibilidade do Claude Code depende de haver CLI e conta na máquina
    // que roda o teste, então não é afirmada — o que importa é que ela seja
    // consultada de verdade, e não presumida.
    const claude = summaries.find((summary) => summary.id === 'claude-code');
    assert.equal(typeof claude?.available, 'boolean');
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
