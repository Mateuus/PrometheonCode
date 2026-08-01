/**
 * Substituto do módulo `vscode` para o preview no navegador.
 *
 * O template e o i18n rodam aqui fora do editor, então o esbuild aponta o
 * import `vscode` para este arquivo (ver `preview/server.mjs`). Só existe o
 * que essas duas dependências realmente usam — qualquer coisa a mais viraria
 * uma promessa falsa de compatibilidade.
 */

interface ShimUri {
  readonly fsPath: string;
  toString(): string;
}

function uri(fsPath: string): ShimUri {
  return { fsPath, toString: () => fsPath };
}

export const Uri = {
  joinPath(base: { fsPath: string }, ...segments: string[]): ShimUri {
    return uri([base.fsPath.replace(/[\\/]+$/, ''), ...segments].join('/'));
  },
  parse(value: string): ShimUri {
    return uri(value);
  },
  file(value: string): ShimUri {
    return uri(value);
  },
};

/**
 * Nunca é alcançado de verdade: o preview força um idioma explícito, e aí o
 * i18n usa o bundle carregado do disco em vez do `vscode.l10n`. Existir aqui é
 * só o que o bundle precisa para resolver o import.
 */
export const l10n = {
  t(message: string, ..._args: unknown[]): string {
    return message;
  },
};
