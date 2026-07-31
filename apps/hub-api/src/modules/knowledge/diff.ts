/**
 * Diferença entre a versão proposta e a vigente.
 *
 * Existe porque o `Docs/10` coloca o revisor no caminho: revisar sem ver o que
 * mudou é carimbar. O algoritmo é o LCS clássico por linhas, com um teto — a
 * matriz é quadrática, e um documento de dez mil linhas em cada lado viraria
 * cem milhões de células para desenhar uma tela. Acima do teto, o diff cai para
 * "prefixo e sufixo comuns, miolo substituído", que continua correto e é o que
 * ferramentas de linha de comando fazem quando desistem do detalhe.
 */

export interface DiffLine {
  kind: 'added' | 'removed' | 'context';
  baseLine: number | null;
  proposedLine: number | null;
  text: string;
}

export interface DiffResult {
  added: number;
  removed: number;
  lines: DiffLine[];
}

/** Acima disto o LCS é abandonado em favor do recorte por prefixo e sufixo. */
const MAX_LCS_LINES = 800;

function splitLines(value: string): string[] {
  if (value === '') {
    return [];
  }

  return value.replace(/\r\n/g, '\n').split('\n');
}

/** Tabela de comprimentos do LCS. Só é chamada dentro do teto. */
function lcsTable(base: readonly string[], proposed: readonly string[]): Int32Array[] {
  const rows: Int32Array[] = Array.from(
    { length: base.length + 1 },
    () => new Int32Array(proposed.length + 1),
  );

  for (let index = base.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const next = rows[index + 1]!;

    for (let other = proposed.length - 1; other >= 0; other -= 1) {
      row[other] =
        base[index] === proposed[other]
          ? (next[other + 1]!) + 1
          : Math.max(next[other]!, row[other + 1]!);
    }
  }

  return rows;
}

function walkLcs(base: readonly string[], proposed: readonly string[]): DiffResult {
  const table = lcsTable(base, proposed);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let index = 0;
  let other = 0;

  while (index < base.length && other < proposed.length) {
    if (base[index] === proposed[other]) {
      lines.push({
        kind: 'context',
        baseLine: index + 1,
        proposedLine: other + 1,
        text: base[index]!,
      });
      index += 1;
      other += 1;
      continue;
    }

    const keepBase = (table[index + 1]!)[other]!;
    const keepProposed = (table[index]!)[other + 1]!;

    if (keepBase >= keepProposed) {
      lines.push({
        kind: 'removed',
        baseLine: index + 1,
        proposedLine: null,
        text: base[index]!,
      });
      removed += 1;
      index += 1;
    } else {
      lines.push({
        kind: 'added',
        baseLine: null,
        proposedLine: other + 1,
        text: proposed[other]!,
      });
      added += 1;
      other += 1;
    }
  }

  for (; index < base.length; index += 1) {
    lines.push({
      kind: 'removed',
      baseLine: index + 1,
      proposedLine: null,
      text: base[index]!,
    });
    removed += 1;
  }

  for (; other < proposed.length; other += 1) {
    lines.push({
      kind: 'added',
      baseLine: null,
      proposedLine: other + 1,
      text: proposed[other]!,
    });
    added += 1;
  }

  return { added, removed, lines };
}

/** Recorte barato: mantém prefixo e sufixo iguais e substitui o miolo. */
function coarseDiff(base: readonly string[], proposed: readonly string[]): DiffResult {
  let start = 0;

  while (start < base.length && start < proposed.length && base[start] === proposed[start]) {
    start += 1;
  }

  let endBase = base.length - 1;
  let endProposed = proposed.length - 1;

  while (endBase >= start && endProposed >= start && base[endBase] === proposed[endProposed]) {
    endBase -= 1;
    endProposed -= 1;
  }

  const lines: DiffLine[] = [];

  for (let index = 0; index < start; index += 1) {
    lines.push({
      kind: 'context',
      baseLine: index + 1,
      proposedLine: index + 1,
      text: base[index]!,
    });
  }

  for (let index = start; index <= endBase; index += 1) {
    lines.push({
      kind: 'removed',
      baseLine: index + 1,
      proposedLine: null,
      text: base[index]!,
    });
  }

  for (let index = start; index <= endProposed; index += 1) {
    lines.push({
      kind: 'added',
      baseLine: null,
      proposedLine: index + 1,
      text: proposed[index]!,
    });
  }

  for (let offset = 0; endBase + 1 + offset < base.length; offset += 1) {
    const baseIndex = endBase + 1 + offset;
    const proposedIndex = endProposed + 1 + offset;

    lines.push({
      kind: 'context',
      baseLine: baseIndex + 1,
      proposedLine: proposedIndex + 1,
      text: base[baseIndex]!,
    });
  }

  return {
    added: Math.max(0, endProposed - start + 1),
    removed: Math.max(0, endBase - start + 1),
    lines,
  };
}

/** Diferença por linhas entre o conteúdo vigente e o proposto. */
export function diffLines(baseContent: string, proposedContent: string): DiffResult {
  const base = splitLines(baseContent);
  const proposed = splitLines(proposedContent);

  if (base.length > MAX_LCS_LINES || proposed.length > MAX_LCS_LINES) {
    return coarseDiff(base, proposed);
  }

  return walkLcs(base, proposed);
}
