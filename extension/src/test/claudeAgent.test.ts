import * as assert from 'node:assert/strict';
import {
  permissionModeFor,
  readUsage,
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

  test('cada autonomia mapeia para o modo correspondente do CLI', () => {
    assert.equal(
      permissionModeFor({ content: '', workMode: 'edit', autonomy: 'manual' }),
      'default',
    );
    assert.equal(
      permissionModeFor({ content: '', workMode: 'edit', autonomy: 'auto' }),
      'acceptEdits',
    );
    assert.equal(
      permissionModeFor({ content: '', workMode: 'edit', autonomy: 'bypass' }),
      'bypassPermissions',
    );
  });
});
