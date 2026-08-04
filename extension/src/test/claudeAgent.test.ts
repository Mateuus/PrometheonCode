import * as assert from 'node:assert/strict';
import {
  argumentsFor,
  permissionModeFor,
  promptWith,
  readUsage,
  safeName,
  translateLine,
} from '../agents/ClaudeCodeAgentAdapter';
import type { AgentEvent } from '../agents/AgentAdapter';

/**
 * Tradução da saída do Claude Code.
 *
 * O que estes testes protegem é a fronteira com um programa que não é nosso. O
 * NDJSON pertence ao CLI e muda entre versões — o valor aqui não é confirmar
 * que o formato de hoje funciona, e sim que um formato inesperado não derruba
 * o run.
 */
suite('Claude Code — tradução do stream', () => {
  const eventsOf = (line: string): readonly AgentEvent[] => translateLine(line).events;

  // Estes três reproduzem a saída real do CLI ao receber `/compact` com
  // `--resume`, verificada contra a versão instalada nesta máquina.
  test('a compactação em andamento vira um passo na timeline', () => {
    const events = eventsOf(
      JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }),
    );

    assert.deepEqual(events, [
      {
        type: 'tool.requested',
        toolId: 'prometheon-compact',
        tool: 'Compact',
        title: 'Summarizing the conversation',
      },
    ]);
  });

  test('a compactação que falha fecha o passo com o motivo do CLI', () => {
    const events = eventsOf(
      JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        compact_error: 'Not enough messages to compact.',
      }),
    );

    assert.deepEqual(events, [
      {
        type: 'tool.completed',
        toolId: 'prometheon-compact',
        detail: 'Not enough messages to compact.',
        failed: true,
      },
    ]);
  });

  test('o init anuncia o modelo em uso, e o resto dele é descartado', () => {
    // `system/init` lista dezenas de ferramentas e servidores MCP a cada run.
    // Só o modelo interessa: é dele que sai o tamanho real do contexto.
    const events = eventsOf(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-5[1m]',
        tools: ['Read', 'Write'],
        mcp_servers: [{ name: 'algum', status: 'connected' }],
      }),
    );

    assert.deepEqual(events, [{ type: 'model', model: 'claude-opus-5[1m]' }]);
  });

  test('init sem modelo não vira evento pela metade', () => {
    assert.deepEqual(
      eventsOf(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'] })),
      [],
    );
  });

  test('texto do assistente vira delta', () => {
    const events = eventsOf(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Olá' }] },
      }),
    );

    assert.deepEqual(events, [{ type: 'delta', text: 'Olá' }]);
  });

  test('uso de ferramenta vira tool.requested com alvo legível', () => {
    const events = eventsOf(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01',
              name: 'Write',
              input: { file_path: '/repo/src/app/Server.ts', content: 'a\nb\nc' },
            },
          ],
        },
      }),
    );

    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.type, 'tool.requested');

    if (event?.type === 'tool.requested') {
      assert.equal(event.tool, 'Write');
      // Só o nome do arquivo: o caminho inteiro estoura a largura da timeline e
      // a parte que identifica está no fim.
      assert.equal(event.title, 'Server.ts');
      assert.equal(event.detail, '3 lines');
    }
  });

  test('comando de terminal é resumido a uma linha', () => {
    const events = eventsOf(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_02',
              name: 'Bash',
              input: { command: 'npm test\n# segunda linha que não cabe' },
            },
          ],
        },
      }),
    );

    const [event] = events;

    if (event?.type === 'tool.requested') {
      assert.equal(event.title, 'npm test');
    } else {
      assert.fail('esperava tool.requested');
    }
  });

  test('resultado de ferramenta com erro é marcado como falha', () => {
    const events = eventsOf(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              is_error: true,
              content: 'ENOENT: no such file',
            },
          ],
        },
      }),
    );

    const [event] = events;
    assert.equal(event?.type, 'tool.completed');

    if (event?.type === 'tool.completed') {
      assert.equal(event.toolId, 'toolu_01');
      // Sem esta marca a interface desenharia a ferramenta como concluída com
      // sucesso, e o usuário só descobriria o erro lendo a saída.
      assert.equal(event.failed, true);
    }
  });

  test('o identificador da conversa é aprendido para retomar depois', () => {
    const { cliSessionId } = translateLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }),
    );

    // Sem guardar isto, a segunda mensagem começaria uma conversa nova e o
    // agente não lembraria do que acabou de fazer.
    assert.equal(cliSessionId, 'abc-123');
  });

  test('resultado final traz o texto e o uso', () => {
    const events = eventsOf(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Pronto.',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
      }),
    );

    const [event] = events;
    assert.equal(event?.type, 'completed');

    if (event?.type === 'completed') {
      assert.equal(event.text, 'Pronto.');
      // Tokens de cache entram no total: eles foram cobrados, e um número menor
      // do que a conta do provedor é a pior direção para um número errado.
      assert.deepEqual(event.usage, { input: 105, output: 20 });
    }
  });

  test('resultado com is_error vira falha, não resposta', () => {
    const events = eventsOf(
      JSON.stringify({ type: 'result', is_error: true, result: 'Recusado.' }),
    );

    const [event] = events;
    assert.equal(event?.type, 'failed');

    if (event?.type === 'failed') {
      assert.equal(event.error.message, 'Recusado.');
    }
  });

  // -------------------------------------------------------------------------
  // O que importa de verdade: não quebrar com o inesperado
  // -------------------------------------------------------------------------

  test('linha que não é JSON é ignorada sem lançar', () => {
    assert.deepEqual(eventsOf('isto não é json'), []);
    assert.deepEqual(eventsOf(''), []);
    assert.deepEqual(eventsOf('null'), []);
  });

  test('tipo desconhecido é ignorado em vez de derrubar o run', () => {
    // Uma versão nova do CLI vai inventar tipos. Falhar aqui transformaria uma
    // atualização do Claude Code numa quebra do Prometheon.
    assert.deepEqual(eventsOf(JSON.stringify({ type: 'coisa_do_futuro', x: 1 })), []);
  });

  test('campos ausentes não viram evento pela metade', () => {
    // `tool_use` sem `id` não tem como ser ligado ao resultado depois; emitir
    // deixaria um bloco eternamente "em andamento" na tela.
    assert.deepEqual(
      eventsOf(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Write' }] },
        }),
      ),
      [],
    );
  });

  test('uso zerado não vira evento', () => {
    assert.equal(readUsage({ input_tokens: 0, output_tokens: 0 }), null);
    assert.equal(readUsage(null), null);
    assert.equal(readUsage('nada'), null);
  });

  // -------------------------------------------------------------------------
  // Permissões
  // -------------------------------------------------------------------------

  test('modo de planejamento vence a autonomia automática', () => {
    // Quem escolheu "só planejar" não espera edição alguma, mesmo tendo deixado
    // a autonomia no automático. Entre as duas, a mais restritiva respeita a
    // intenção.
    assert.equal(
      permissionModeFor({ content: '', workMode: 'plan', autonomy: 'bypass' }),
      'plan',
    );
  });

  test('cada autonomia mapeia para um modo que o CLI reconhece', () => {
    // A lista do CLI é `acceptEdits | auto | bypassPermissions | manual |
    // dontAsk | plan`. Mandar um nome fora dela deixava o agente sem permissão
    // para executar nada — ele respondia que o prompt de permissão o recusou,
    // e o usuário não tinha onde aprovar.
    const modes = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
    for (const autonomy of ['manual', 'auto', 'bypass'] as const) {
      const mode = permissionModeFor({ content: '', workMode: 'edit', autonomy });
      assert.ok(modes.includes(mode), `${autonomy} virou "${mode}", que o CLI não conhece`);
    }

    assert.equal(
      permissionModeFor({ content: '', workMode: 'edit', autonomy: 'manual' }),
      'manual',
    );
    // Automático precisa executar de verdade: `acceptEdits` libera a edição de
    // arquivo mas continua pedindo aprovação para comando, e não há ninguém
    // para aprovar numa sessão sem terminal.
    assert.equal(
      permissionModeFor({ content: '', workMode: 'edit', autonomy: 'auto' }),
      'auto',
    );
    assert.equal(
      permissionModeFor({ content: '', workMode: 'edit', autonomy: 'bypass' }),
      'bypassPermissions',
    );
  });
});

suite('Claude Code — anexos de imagem', () => {
  test('os caminhos entram depois do texto, em linhas próprias', () => {
    // No meio da frase, o caminho atrapalharia a leitura do pedido — que é o
    // que mais importa para o agente.
    assert.equal(
      promptWith('descreva esta tela', ['/tmp/a/1-tela.png']),
      'descreva esta tela\n\n/tmp/a/1-tela.png',
    );
  });

  test('sem anexo, o texto vai intacto', () => {
    assert.equal(promptWith('só texto', []), 'só texto');
  });

  test('o nome do arquivo não escapa do diretório temporário', () => {
    // O nome vem do que a pessoa colou ou arrastou e vira caminho em disco.
    // Sem a limpeza, `..` e barras escreveriam fora da pasta temporária.
    assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
    assert.equal(safeName(String.raw`..\..\windows\system32`), 'windows-system32');
    assert.equal(safeName('foto boa.png'), 'foto-boa.png');
  });

  test('nome vazio ou só pontuação vira um nome utilizável', () => {
    assert.equal(safeName(''), 'imagem.png');
    assert.equal(safeName('...'), 'imagem.png');
  });

  test('nome longo é truncado', () => {
    // Alguns sistemas de arquivos recusam nomes muito longos, e o erro
    // apareceria como falha do anexo sem explicação.
    assert.ok(safeName('a'.repeat(300)).length <= 60);
  });
});

suite('Worker de leitura — Claude Code', () => {
  const base = {
    threadId: null,
    workMode: 'edit' as const,
    autonomy: 'auto' as const,
    model: undefined,
    effort: undefined,
    workspaceFolder: undefined,
    systemPrompt: undefined,
    delegation: undefined,
    profile: { model: undefined } as never,
  };

  test('as ferramentas de escrita saem do alcance de quem só lê', () => {
    // Negar a ferramenta é diferente de pedir que ele não a use: o segundo
    // depende de o modelo obedecer.
    const args = argumentsFor({ ...base, readOnly: true } as never, {
      content: '',
      workMode: 'edit',
      autonomy: 'auto',
    });
    const at = args.indexOf('--disallowedTools');
    assert.ok(at !== -1, args.join(' '));
    assert.deepEqual(args.slice(at + 1, at + 5), ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  });

  test('quem edita não recebe restrição', () => {
    const args = argumentsFor({ ...base, readOnly: false } as never, {
      content: '',
      workMode: 'edit',
      autonomy: 'auto',
    });
    assert.equal(args.includes('--disallowedTools'), false);
  });
});
