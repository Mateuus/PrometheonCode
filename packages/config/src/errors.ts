/**
 * Erro de validação da configuração.
 *
 * A regra do projeto é falhar no boot listando **todos** os problemas de uma
 * vez, para que o desenvolvedor conserte o `.env` em uma única passada em vez
 * de descobrir uma variável errada por execução.
 */

export interface ConfigIssue {
  /** Nome da variável de ambiente, por exemplo `DATABASE_HOST`. */
  readonly key: string;
  /** Descrição do problema, sem jamais repetir o valor recebido. */
  readonly message: string;
}

const HEADER = 'Invalid environment configuration.';
const FOOTER =
  'Fix the variables listed above (see .env.example) and start the process again.';

/** Monta a mensagem multilinha usada como `message` do erro. */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  const count = issues.length;
  const lines = [
    `${HEADER} ${String(count)} ${count === 1 ? 'problem' : 'problems'} found:`,
    ...issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
    '',
    FOOTER,
  ];

  return lines.join('\n');
}

export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';

  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatConfigIssues(issues));
    this.issues = issues;
  }

  /** Lista, sem repetição e em ordem, as variáveis reprovadas. */
  get invalidKeys(): readonly string[] {
    return [...new Set(this.issues.map((issue) => issue.key))];
  }
}
