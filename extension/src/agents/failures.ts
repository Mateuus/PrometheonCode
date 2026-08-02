/**
 * Leitura da falha de um agente worker.
 *
 * Quando uma delegação morre, o orquestrador recebe de volta uma linha de
 * texto — e é só com ela que ele decide o próximo passo. "Error: request
 * failed" não permite decidir nada: ele tenta de novo, falha de novo, e queima
 * o pedido inteiro em repetição. Já "a conta deste agente está sem saldo, use
 * outra" leva a uma ação certa na primeira tentativa.
 *
 * Por isso classificamos a causa e dizemos o que fazer com ela. O texto
 * original vai junto sempre: a classificação é palpite sobre a frase do CLI, e
 * quem lê precisa poder discordar dela.
 */

export type AgentFailureKind =
  /** Acabou o saldo, a cota ou a janela de uso da conta. */
  | 'quota'
  /** A conta precisa entrar de novo. */
  | 'auth'
  /** O CLI do provedor não está instalado ou não foi encontrado. */
  | 'unavailable'
  /** Sobrecarga, rede ou tempo esgotado — tende a passar sozinho. */
  | 'transient'
  /** Nada reconhecido; vale o texto do provedor. */
  | 'unknown';

export interface AgentFailure {
  readonly kind: AgentFailureKind;
  /** O que o orquestrador deve fazer a seguir, em inglês (vai para o modelo). */
  readonly advice: string;
  /** Frase curta para o usuário, já classificada. */
  readonly summary: string;
}

interface Rule {
  readonly kind: AgentFailureKind;
  readonly pattern: RegExp;
  readonly advice: string;
  readonly summary: string;
}

/**
 * A ordem é deliberada: um erro de cota costuma trazer também um código HTTP
 * que casaria com "transitório", e retentar nesse caso só gasta tempo.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'unavailable',
    pattern: /\bENOENT\b|command not found|is not recognized|no such file or directory/i,
    advice:
      'The CLI for this agent is not installed on this machine. Do not retry it. Delegate to an agent from a different provider, or tell the user to install it.',
    summary: 'the CLI is not installed on this machine',
  },
  {
    kind: 'quota',
    pattern:
      /usage limit|quota|credit balance|insufficient credit|out of credit|billing|\b429\b|rate.?limit|too many requests|exceeded your current/i,
    advice:
      'This account has no budget left right now. Do not retry the same agent. Delegate to an agent bound to a different account, or report to the user that the quota ran out.',
    summary: 'the account ran out of quota or credit',
  },
  {
    kind: 'auth',
    pattern:
      /unauthorized|authentication|not logged in|invalid api key|invalid.*token|\b401\b|\b403\b|session (has )?expired|please (run )?.*login/i,
    advice:
      'This account is no longer signed in. Do not retry it. Tell the user to reconnect the account in Prometheon settings, and use another agent meanwhile if one fits.',
    summary: 'the account needs to sign in again',
  },
  {
    kind: 'transient',
    pattern:
      /overloaded|\b5\d\d\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network error|temporarily unavailable/i,
    advice:
      'This was a temporary provider error. You may delegate the same task one more time; if it fails again, stop and report it to the user.',
    summary: 'the provider had a temporary error',
  },
];

/**
 * Classifica a mensagem de erro de um worker.
 *
 * Uma mensagem vazia é falha também — CLI que morre sem dizer nada é o caso
 * mais comum de processo derrubado por falta de memória.
 */
export function describeAgentFailure(message: string): AgentFailure {
  const text = message.trim();
  if (text === '') {
    return {
      kind: 'unknown',
      advice:
        'The agent process ended without saying why. Try once with a smaller task; if it ends the same way, report it to the user.',
      summary: 'it ended without reporting a reason',
    };
  }

  const rule = RULES.find((candidate) => candidate.pattern.test(text));
  return rule === undefined
    ? {
        kind: 'unknown',
        advice:
          'Decide from the message above whether retrying makes sense. If you cannot tell, report it to the user instead of retrying.',
        summary: text,
      }
    : { kind: rule.kind, advice: rule.advice, summary: rule.summary };
}
