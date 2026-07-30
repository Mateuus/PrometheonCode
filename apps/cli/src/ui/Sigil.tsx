import { Box, Text } from 'ink';
import { palette } from './theme.js';

/**
 * O símbolo do Prometheon desenhado no terminal.
 *
 * A chama entre quatro nós, como no ícone do produto: o fogo que Prometeu
 * roubou, cercado pela malha de agentes que o carregam.
 *
 * **Meio-blocos dobram a resolução.** Um caractere de terminal é cerca de duas
 * vezes mais alto que largo; desenhar um pixel por caractere produziria uma
 * figura achatada. Com `▀`, a cor da frente pinta a metade de cima e a de fundo
 * pinta a de baixo — cada caractere carrega dois pixels, e o resultado fica na
 * proporção certa.
 */

/**
 * Cada caractere é um pixel. Espaço é transparente: o fundo do terminal passa.
 *
 * Oito linhas de pixel viram quatro de terminal — a altura de um cabeçalho de
 * três linhas, mais uma de folga. Um símbolo maior do que o texto que ele
 * acompanha rouba a atenção do que a pessoa foi ler.
 */
const PIXELS = [
  '  P   P  ',
  ' v     v ',
  'v   f   v',
  'P  fFf  P',
  'P  fFf  P',
  'v   F   v',
  ' v     v ',
  '  P   P  ',
] as const;

const COLORS: Readonly<Record<string, string>> = {
  P: palette.brand,
  v: palette.accent,
  F: palette.running,
  f: palette.warn,
};

/** O símbolo pintado. */
export function Sigil() {
  const rows = PIXELS;
  const lines: { top: string; bottom: string }[] = [];

  for (let index = 0; index < rows.length; index += 2) {
    lines.push({ top: rows[index] ?? '', bottom: rows[index + 1] ?? '' });
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>
          {renderRow(line.top, line.bottom)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Uma linha de terminal a partir de duas de pixels.
 *
 * Caracteres vizinhos com as mesmas cores são agrupados num só elemento: uma
 * linha de 16 pixels viraria 16 elementos, e o Ink recalcularia o layout de
 * cada um a cada quadro.
 */
function renderRow(top: string, bottom: string): React.ReactNode[] {
  const cells: React.ReactNode[] = [];
  const width = Math.max(top.length, bottom.length);

  let run = '';
  let runTop: string | undefined;
  let runBottom: string | undefined;

  const flush = (key: number): void => {
    if (run === '') {
      return;
    }

    cells.push(
      <Text
        key={key}
        {...(runTop === undefined ? {} : { color: runTop })}
        {...(runBottom === undefined ? {} : { backgroundColor: runBottom })}
      >
        {run}
      </Text>,
    );

    run = '';
  };

  for (let column = 0; column < width; column += 1) {
    const upper = COLORS[top[column] ?? ' '];
    const lower = COLORS[bottom[column] ?? ' '];

    if (upper !== runTop || lower !== runBottom) {
      flush(column);
      runTop = upper;
      runBottom = lower;
    }

    // Metade de cima pintada pela cor de frente, metade de baixo pelo fundo.
    // Sem cor nenhuma, o espaço deixa o fundo do terminal aparecer.
    run += upper === undefined && lower === undefined ? ' ' : '▀';
  }

  flush(width);

  return cells;
}
