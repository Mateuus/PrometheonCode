import { describe, expect, it } from 'vitest';
import { permissionModeFor, readUsage, translateLine } from './claude-stream.js';

/**
 * Tradução da saída do Claude Code.
 *
 * O que estes testes protegem é a fronteira com um programa que não é nosso. O
 * NDJSON pertence ao CLI e muda entre versões — o valor aqui não é confirmar
 * que o formato de hoje funciona, e sim que um formato inesperado não derruba
 * o run.
 */
describe('tradução do stream', () => {
  const eventsOf = (line: string) => translateLine(line).events;

  it('texto do assistente vira delta', () => {
    expect(
      eventsOf(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Olá' }] } }),
      ),
    ).toEqual([{ type: 'delta', text: 'Olá' }]);
  });

  it('uso de ferramenta vira tool.requested com alvo legível', () => {
    const [event] = eventsOf(
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

    // Só o nome do arquivo: o caminho inteiro estoura a largura do terminal e a
    // parte que identifica está no fim.
    expect(event).toEqual({
      type: 'tool.requested',
      toolId: 'toolu_01',
      tool: 'Write',
      title: 'Server.ts',
      detail: '3 lines',
    });
  });

  it('comando de terminal é resumido a uma linha', () => {
    const [event] = eventsOf(
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

    expect(event).toMatchObject({ title: 'npm test' });
  });

  it('resultado de ferramenta com erro é marcado como falha', () => {
    const [event] = eventsOf(
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

    // Sem esta marca, quem mostra desenharia a ferramenta como bem-sucedida e o
    // erro só apareceria para quem lesse a saída inteira.
    expect(event).toMatchObject({ type: 'tool.completed', toolId: 'toolu_01', failed: true });
  });

  it('o identificador da conversa é aprendido para retomar depois', () => {
    // Sem guardar isto, a mensagem seguinte começaria uma conversa nova e o
    // agente não lembraria do que acabou de fazer.
    expect(
      translateLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }))
        .cliSessionId,
    ).toBe('abc-123');
  });

  it('resultado final traz o texto e o uso, com os tokens de cache somados', () => {
    const [event] = eventsOf(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Pronto.',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
      }),
    );

    // Cache entra no total: foi cobrado, e um número menor do que a conta do
    // provedor é a pior direção para um número errado.
    expect(event).toEqual({
      type: 'completed',
      text: 'Pronto.',
      usage: { input: 105, output: 20 },
    });
  });

  it('resultado com is_error vira falha, não resposta', () => {
    const [event] = eventsOf(
      JSON.stringify({ type: 'result', is_error: true, result: 'Recusado.' }),
    );

    expect(event).toMatchObject({ type: 'failed', error: { message: 'Recusado.' } });
  });

  // -------------------------------------------------------------------------
  // O que importa de verdade: não quebrar com o inesperado
  // -------------------------------------------------------------------------

  it('linha que não é JSON é ignorada sem lançar', () => {
    expect(eventsOf('isto não é json')).toEqual([]);
    expect(eventsOf('')).toEqual([]);
    expect(eventsOf('null')).toEqual([]);
  });

  it('tipo desconhecido é ignorado em vez de derrubar o run', () => {
    // Uma versão nova do CLI vai inventar tipos. Falhar aqui transformaria uma
    // atualização do Claude Code numa quebra do Prometheon.
    expect(eventsOf(JSON.stringify({ type: 'coisa_do_futuro', x: 1 }))).toEqual([]);
  });

  it('tool_use sem id não vira evento pela metade', () => {
    // Sem `id` não há como ligar ao resultado depois; emitir deixaria um bloco
    // eternamente "em andamento" na tela.
    expect(
      eventsOf(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Write' }] },
        }),
      ),
    ).toEqual([]);
  });

  it('uso zerado não vira evento', () => {
    expect(readUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(readUsage(null)).toBeNull();
    expect(readUsage('nada')).toBeNull();
  });
});

describe('permissões', () => {
  it('modo de planejamento vence a autonomia automática', () => {
    // Quem escolheu "só planejar" não espera edição alguma, mesmo tendo deixado
    // a autonomia no automático. A mais restritiva respeita a intenção.
    expect(permissionModeFor('plan', 'bypass')).toBe('plan');
  });

  it('cada autonomia mapeia para o modo correspondente do CLI', () => {
    expect(permissionModeFor('edit', 'manual')).toBe('default');
    expect(permissionModeFor('edit', 'auto')).toBe('acceptEdits');
    expect(permissionModeFor('edit', 'bypass')).toBe('bypassPermissions');
  });
});
