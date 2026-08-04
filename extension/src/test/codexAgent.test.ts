import * as assert from 'node:assert/strict';
import {
  argumentsFor,
  failureMessage,
  sandboxFor,
  translateCodexLine,
} from '../agents/CodexAgentAdapter';
import { parseLoginStatus } from '../providers/CodexAdapter';

/**
 * O formato coberto aqui foi capturado do CLI 0.142.5 rodando de verdade
 * (`codex exec --json`), não de documentação.
 */
suite('Codex — tradução do JSONL', () => {
  test('thread.started devolve o id que permite retomar a conversa', () => {
    const result = translateCodexLine(
      '{"type":"thread.started","thread_id":"019fbf0a-9efc-7761-9f17-215b65ccc41b"}',
    );
    assert.equal(result.threadId, '019fbf0a-9efc-7761-9f17-215b65ccc41b');
    assert.deepEqual(result.events, []);
  });

  test('a mensagem do agente vira a resposta concluída', () => {
    const { events } = translateCodexLine(
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}',
    );
    assert.deepEqual(events, [{ type: 'completed', text: 'OK' }]);
  });

  test('turn.failed vira falha com a mensagem do CLI', () => {
    const { events } = translateCodexLine(
      '{"type":"turn.failed","error":{"message":"model not supported"}}',
    );
    assert.equal(events[0]?.type, 'failed');
    assert.match(
      String(events[0]?.type === 'failed' ? events[0].error.message : ''),
      /model not supported/,
    );
  });

  test('comando executado abre e fecha o mesmo passo pelo id', () => {
    const started = translateCodexLine(
      '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"npm test"}}',
    );
    const done = translateCodexLine(
      '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"npm test","exit_code":1,"aggregated_output":"boom"}}',
    );
    assert.equal(started.events[0]?.type, 'tool.requested');
    assert.equal(
      started.events[0]?.type === 'tool.requested' ? started.events[0].toolId : '',
      'c1',
    );
    assert.equal(done.events[0]?.type, 'tool.completed');
    // Código de saída diferente de zero precisa marcar falha: um passo vermelho
    // é a diferença entre "rodou" e "rodou e quebrou".
    assert.equal(done.events[0]?.type === 'tool.completed' ? done.events[0].failed : false, true);
  });

  test('uso de tokens vira delta de usage', () => {
    const { events } = translateCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":8}}',
    );
    assert.deepEqual(events, [{ type: 'usage', delta: { input: 120, output: 8 } }]);
  });

  test('linha que não é JSON e tipo desconhecido não derrubam o run', () => {
    // O CLI mistura logs com o JSONL, e ganha tipos novos entre versões.
    assert.deepEqual(translateCodexLine('2026-08-01 ERROR algo').events, []);
    assert.deepEqual(translateCodexLine('{"type":"item.completed","item":{"type":"x"}}').events, []);
    assert.deepEqual(translateCodexLine('{"type":"futuro"}').events, []);
  });
});

suite('Codex — sandbox', () => {
  test('planejar é leitura pura', () => {
    assert.equal(sandboxFor({ workMode: 'plan', autonomy: 'manual' }), 'read-only');
  });

  test('editar escreve no workspace', () => {
    assert.equal(sandboxFor({ workMode: 'edit', autonomy: 'manual' }), 'workspace-write');
    assert.equal(sandboxFor({ workMode: 'edit', autonomy: 'auto' }), 'workspace-write');
  });

  test('bypass é o único caminho para acesso total', () => {
    assert.equal(sandboxFor({ workMode: 'edit', autonomy: 'bypass' }), 'danger-full-access');
    // E nem assim em modo de planejamento: lá não há edição para liberar.
    assert.equal(sandboxFor({ workMode: 'plan', autonomy: 'bypass' }), 'read-only');
  });

  test('os argumentos não trazem flag que o `codex exec` não conhece', () => {
    // Regressão: `--ask-for-approval` existe no Codex interativo e não no
    // `exec` — o CLI morria no parser antes de rodar qualquer coisa, e a
    // delegação inteira falhava por causa de uma flag inventada.
    const args = argumentsFor({
      threadId: null,
      workMode: 'edit',
      autonomy: 'manual',
      model: undefined,
      effort: undefined,
      workspaceFolder: undefined,
      systemPrompt: undefined,
    } as Parameters<typeof argumentsFor>[0]);
    assert.ok(!args.includes('--ask-for-approval'), args.join(' '));
    assert.ok(args.includes('--sandbox'));
    assert.deepEqual(args.slice(0, 3), ['exec', '--json', '--skip-git-repo-check']);
  });

  test('bypass usa a flag própria, e não a sandbox', () => {
    const args = argumentsFor({
      threadId: null,
      workMode: 'edit',
      autonomy: 'bypass',
      model: undefined,
      effort: undefined,
      workspaceFolder: undefined,
      systemPrompt: undefined,
    } as Parameters<typeof argumentsFor>[0]);
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('--sandbox'));
  });
});

suite('Codex — status de login', () => {
  test('reconhece a sessão do ChatGPT', () => {
    const status = parseLoginStatus('Logged in using ChatGPT\n');
    assert.equal(status.authenticated, true);
    assert.equal(status.authMethod, 'ChatGPT');
  });

  test('"Not logged in" nunca vira autenticado', () => {
    // A frase contém "logged in": uma checagem ingênua diria que há sessão.
    assert.equal(parseLoginStatus('Not logged in').authenticated, false);
  });

  test('saída vazia é desconhecida, não sessão válida', () => {
    assert.equal(parseLoginStatus('   ').authenticated, false);
  });

  test('a resposta vinda pelo stderr conta como resposta', () => {
    // O `codex login status` sai com código 0 e escreve tudo no **stderr**.
    // Ler só o stdout devolvia vazio, e a conta aparecia como desconectada
    // logo depois de um login bem-sucedido — foi o que aconteceu na prática.
    const joined = ['', 'Logged in using ChatGPT'].join(' ').trim();
    assert.equal(parseLoginStatus(joined).authenticated, true);
  });
});

suite('Worker de leitura', () => {
  test('o Codex de leitura roda na sandbox de leitura', () => {
    assert.equal(sandboxFor({ workMode: 'edit', autonomy: 'auto', readOnly: true }), 'read-only');
    // Sem a marca, editar continua sendo o normal.
    assert.equal(sandboxFor({ workMode: 'edit', autonomy: 'auto' }), 'workspace-write');
  });
});

suite('Codex — mensagem de falha', () => {
  test('o anúncio de leitura do prompt não é a causa da falha', () => {
    // O Codex conta o que está fazendo pelo stderr; apresentar isso como erro
    // manda o usuário caçar um defeito que não existe.
    const message = failureMessage('Reading prompt from stdin...\n', 1);
    assert.match(message, /exited with code 1/);
    assert.ok(!message.includes('Reading prompt'), message);
  });

  test('o erro de verdade sobrevive à limpeza', () => {
    const message = failureMessage(
      'Reading prompt from stdin...\n\nerror: unexpected argument --foo\n',
      2,
    );
    assert.equal(message, 'error: unexpected argument --foo');
  });

  test('stderr vazio vira uma frase que admite não saber', () => {
    assert.match(failureMessage('   \n', null), /said nothing about why/);
  });
});
