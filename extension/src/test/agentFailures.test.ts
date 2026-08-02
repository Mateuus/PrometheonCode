import * as assert from 'node:assert/strict';
import { describeAgentFailure } from '../agents/failures';
import { normalizeAgentName, orchestrationInstruction } from '../core/PrometheonCore';

suite('describeAgentFailure', () => {
  test('reconhece cota esgotada e manda não repetir o mesmo agente', () => {
    const failure = describeAgentFailure('Claude usage limit reached. Your limit will reset at 3pm.');
    assert.equal(failure.kind, 'quota');
    assert.match(failure.advice, /different account/);
  });

  test('trata 429 como cota, e não como erro passageiro', () => {
    // Um 429 traz número de três dígitos, que o padrão de transitório também
    // pegaria; retentar aí só gasta o pedido do usuário.
    assert.equal(describeAgentFailure('API error 429: too many requests').kind, 'quota');
  });

  test('reconhece sessão expirada e aponta para reconectar a conta', () => {
    const failure = describeAgentFailure('401 Unauthorized: please run `claude login`');
    assert.equal(failure.kind, 'auth');
    assert.match(failure.advice, /reconnect the account/);
  });

  test('reconhece CLI ausente', () => {
    assert.equal(describeAgentFailure("spawn codex ENOENT").kind, 'unavailable');
  });

  test('erro passageiro autoriza uma segunda tentativa', () => {
    const failure = describeAgentFailure('Error 529: the model is overloaded');
    assert.equal(failure.kind, 'transient');
    assert.match(failure.advice, /one more time/);
  });

  test('mensagem vazia é falha, e diz que não houve motivo', () => {
    const failure = describeAgentFailure('   ');
    assert.equal(failure.kind, 'unknown');
    assert.match(failure.summary, /without reporting a reason/);
  });

  test('mensagem desconhecida chega inteira a quem lê', () => {
    const failure = describeAgentFailure('the tool refused to write outside the workspace');
    assert.equal(failure.kind, 'unknown');
    assert.equal(failure.summary, 'the tool refused to write outside the workspace');
  });
});

suite('Nome do agente na delegação', () => {
  test('o papel entre parênteses não invalida o nome', () => {
    // O modelo copia da lista que devolvemos e às vezes leva o papel junto;
    // isso custava uma delegação recusada e uma segunda tentativa.
    assert.equal(normalizeAgentName('GPT Pesquisador (Researcher)'), 'gpt pesquisador');
    assert.equal(normalizeAgentName('"GPT Pesquisador"'), 'gpt pesquisador');
    assert.equal(normalizeAgentName('  Claudio Main  '), 'claudio main');
  });

  test('parênteses no meio do nome ficam onde estão', () => {
    assert.equal(normalizeAgentName('Agente (beta) revisor'), 'agente (beta) revisor');
  });
});

suite('Cartilha do orquestrador', () => {
  const team = [
    { name: 'GPT Pesquisador', role: 'Researcher', description: 'Busca e resume fontes.', slots: 1 },
    { name: 'Testador', role: 'Tester', description: 'Escreve e roda testes.', slots: 3 },
  ];

  test('a equipe vai no prompt, e não atrás de uma ferramenta', () => {
    // Perguntar quem existe antes de cada tarefa custava uma ida e volta para
    // descobrir o que já era para o orquestrador saber.
    const text = orchestrationInstruction(team);
    assert.match(text, /agent: "GPT Pesquisador"/);
    assert.match(text, /agent: "Testador"/);
    assert.match(text, /can run: 3 task\(s\)/);
    assert.match(text, /do not need to look the team up first/);
  });

  test('ensina a disparar em paralelo no mesmo turno', () => {
    assert.match(orchestrationInstruction(team), /in the same turn/);
  });

  test('delegar é o padrão do modo, não algo que o usuário precise pedir', () => {
    const text = orchestrationInstruction(team);
    assert.match(text, /default is to coordinate, not to do/);
    assert.match(text, /Nobody has to ask you to delegate/);
    // E o contrário também precisa estar dito: sem a saída explícita, ele
    // delegaria um "bom dia".
    assert.match(text, /only when the user tells you to/);
  });
});

suite('Contrato assíncrono da delegação', () => {
  const team = [{ name: 'Pesquisador', role: 'Researcher', description: 'Pesquisa.', slots: 2 }];

  test('a cartilha proíbe esperar por conta própria', () => {
    // O orquestrador rodou `sleep 120` no shell para não perder o resultado.
    // Inventar espera é sintoma de contrato mal explicado, não de teimosia.
    const text = orchestrationInstruction(team);
    assert.match(text, /Delegating never blocks/);
    assert.match(text, /Never sleep, poll, or run shell commands to wait/);
    assert.match(text, /come back to you automatically/);
  });
});
