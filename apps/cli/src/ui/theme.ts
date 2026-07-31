/**
 * Cores do Prometheon no terminal.
 *
 * São as mesmas do painel do VS Code, com uma diferença que importa: o terminal
 * não garante cor nenhuma. Fundo claro, tema de baixo contraste, `NO_COLOR`,
 * saída canalizada para um arquivo — em todos esses casos o texto precisa
 * continuar legível **sem** a cor. Por isso nada aqui carrega significado
 * sozinho: a cor acompanha um símbolo ou uma palavra, nunca os substitui.
 */

export const palette = {
  /** Roxo da marca. Títulos e o que identifica o Prometheon. */
  brand: '#7c3aed',
  /** Violeta de apoio, para segundo plano de destaque. */
  accent: '#a855f7',
  /** Ciano: atividade em curso. */
  activity: '#22d3ee',
  /** Laranja: algo executando que merece atenção. */
  running: '#ff7a18',
  /** Âmbar: aviso — não impede seguir. */
  warn: '#ffc857',
  /** Verde: concluído com sucesso. */
  ok: '#22c55e',
  /** Vermelho: falhou. */
  fail: '#ef4444',
  /** Cinza: texto de apoio, sempre secundário ao conteúdo. */
  muted: '#a1a1aa',
} as const;

/**
 * Símbolos de estado.
 *
 * ASCII no Windows fora do Terminal moderno: o console legado não desenha estes
 * glifos e mostra caixas vazias, o que é pior do que um sinal simples. A
 * verificação é do ambiente, não do sistema — o Windows Terminal define
 * `WT_SESSION` e desenha tudo.
 */
const unicodeSupported =
  process.platform !== 'win32' ||
  process.env['WT_SESSION'] !== undefined ||
  process.env['TERM_PROGRAM'] === 'vscode';

export const symbols = unicodeSupported
  ? {
      ok: '✔',
      fail: '✖',
      warn: '▲',
      pending: '·',
      arrow: '→',
      bullet: '◆',
      line: '─',
    }
  : {
      ok: '+',
      fail: 'x',
      warn: '!',
      pending: '.',
      arrow: '->',
      bullet: '*',
      line: '-',
    };

/**
 * O nome desenhado grande.
 *
 * Só aparece em comando interativo e quando a saída é um terminal de verdade —
 * arte ASCII num log ou num pipe é ruído que atrapalha quem for ler depois.
 */
export const wordmark = [
  '██████╗ ██████╗  ██████╗ ███╗   ███╗███████╗████████╗██╗  ██╗███████╗ ██████╗ ███╗   ██╗',
  '██╔══██╗██╔══██╗██╔═══██╗████╗ ████║██╔════╝╚══██╔══╝██║  ██║██╔════╝██╔═══██╗████╗  ██║',
  '██████╔╝██████╔╝██║   ██║██╔████╔██║█████╗     ██║   ███████║█████╗  ██║   ██║██╔██╗ ██║',
  '██╔═══╝ ██╔══██╗██║   ██║██║╚██╔╝██║██╔══╝     ██║   ██╔══██║██╔══╝  ██║   ██║██║╚██╗██║',
  '██║     ██║  ██║╚██████╔╝██║ ╚═╝ ██║███████╗   ██║   ██║  ██║███████╗╚██████╔╝██║ ╚████║',
  '╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝',
] as const;

/** Versão curta, para terminal estreito. */
export const wordmarkCompact = [
  '╔═╗╦═╗╔═╗╔╦╗╔═╗╔╦╗╦ ╦╔═╗╔═╗╔╗╔',
  '╠═╝╠╦╝║ ║║║║║╣  ║ ╠═╣║╣ ║ ║║║║',
  '╩  ╩╚═╚═╝╩ ╩╚═╝ ╩ ╩ ╩╚═╝╚═╝╝╚╝',
] as const;

/**
 * A marca cabe na largura disponível?
 *
 * Desenho cortado ao meio é pior do que não desenhar: vira uma sequência de
 * caracteres sem sentido que ainda ocupa seis linhas da tela.
 */
export function wordmarkFor(columns: number): readonly string[] | null {
  if (columns >= 92) {
    return wordmark;
  }

  if (columns >= 32) {
    return wordmarkCompact;
  }

  return null;
}
