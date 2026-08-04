import * as assert from 'node:assert/strict';
import { BUILTIN_AGENTS, BUILTIN_AGENT_IDS, DEFAULT_MAIN_AGENT_ID } from '../agents/builtinAgents';
import { normalizeAgentProfile } from '../agents/AgentProfileStore';

suite('Equipe embutida', () => {
  test('a equipe cobre os papéis que a delegação precisa', () => {
    // Sem orquestrador não há quem delegue; sem os outros três, não há a quem.
    const roles = BUILTIN_AGENTS.map((agent) => agent.role);
    assert.deepEqual(roles, ['orchestrator', 'implementer', 'researcher', 'reviewer']);
    assert.equal(BUILTIN_AGENTS.length, BUILTIN_AGENT_IDS.length);
  });

  test('nasce sem conta, porque a conta é de cada máquina', () => {
    for (const agent of BUILTIN_AGENTS) {
      assert.equal(agent.providerProfileId, '', agent.name);
      assert.equal(agent.scope, 'builtin', agent.name);
      assert.equal(agent.enabled, true, agent.name);
    }
  });

  test('cada um traz o próprio manual', () => {
    for (const agent of BUILTIN_AGENTS) {
      assert.ok((agent.systemPrompt ?? '').length > 200, `${agent.name} sem prompt útil`);
      assert.match(agent.systemPrompt ?? '', /# Missão/);
    }
  });

  test('o principal padrão existe na equipe', () => {
    assert.ok(BUILTIN_AGENTS.some((agent) => agent.id === DEFAULT_MAIN_AGENT_ID));
  });

  test('todos passam pela validação de disco', () => {
    // É a mesma porta por onde entra um agente do repositório: se um embutido
    // não sobrevive a ela, ele também não sobreviveria a ser editado e salvo.
    for (const agent of BUILTIN_AGENTS) {
      assert.notEqual(normalizeAgentProfile({ ...agent }), null, agent.name);
    }
  });

  test('o teto do perfil não estorva a escolha do painel', () => {
    // `autonomyMode` é teto, não escolha. Em `manual`, o agente embutido
    // ignoraria o "Ignorar permissões" que a pessoa acabou de ligar: ela veria
    // o aviso de bypass ativo na barra e o agente recusando comandos, sem
    // relação visível entre as duas coisas. Quem decide de fato é o seletor.
    for (const agent of BUILTIN_AGENTS) {
      assert.equal(agent.autonomyMode, 'bypass-temporary', agent.name);
    }
  });
});
