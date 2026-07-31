/**
 * Perguntas que o agente faz ao usuário no meio de um run.
 *
 * O agente não conversa com a webview: ele emite `question.asked`, o núcleo
 * guarda o pedido e a interface desenha o modal. A resposta volta pelo caminho
 * inverso e só então o run continua — enquanto isso, o agente fica parado, sem
 * inventar nada por conta própria.
 */

/** Perguntas por pedido. Mais que isso vira formulário, não conversa. */
export const MAX_QUESTIONS = 4;

/** Opções por pergunta, sem contar o "Other", que a interface sempre oferece. */
export const MAX_QUESTION_OPTIONS = 4;

export const MAX_QUESTION_HEADER_LENGTH = 24;
export const MAX_QUESTION_LENGTH = 400;
export const MAX_OPTION_LABEL_LENGTH = 160;
export const MAX_OPTION_DESCRIPTION_LENGTH = 400;

/** Teto do texto livre digitado em "Other". */
export const MAX_CUSTOM_ANSWER_LENGTH = 400;

export interface AgentQuestionOption {
  readonly label: string;
  /** Linha de apoio abaixo do rótulo, explicando a escolha. */
  readonly description?: string;
}

export interface AgentQuestion {
  /** Rótulo curto da aba ("Bebida", "Escopo"). */
  readonly header: string;
  readonly question: string;
  /** Verdadeiro para caixas de seleção; falso para escolha única. */
  readonly multiSelect: boolean;
  readonly options: readonly AgentQuestionOption[];
}

export interface AgentQuestionRequest {
  /** Liga o pedido à resposta; um run só tem um pedido aberto por vez. */
  readonly requestId: string;
  readonly questions: readonly AgentQuestion[];
}

/**
 * Resposta a uma pergunta. A ordem do array de respostas acompanha a ordem das
 * perguntas do pedido — é isso que liga uma à outra, e o núcleo confere.
 */
export interface AgentQuestionAnswer {
  readonly header: string;
  /** Rótulos escolhidos entre as opções oferecidas. */
  readonly selected: readonly string[];
  /** Texto digitado em "Other", quando o usuário preferiu escrever. */
  readonly custom?: string;
}

export type AgentQuestionOutcome =
  | { readonly type: 'answered'; readonly answers: readonly AgentQuestionAnswer[] }
  /** O usuário fechou o modal, ou o run acabou antes da resposta. */
  | { readonly type: 'cancelled' };

/** Tudo o que o usuário escolheu numa pergunta, texto livre incluído. */
export function answerValues(answer: AgentQuestionAnswer): readonly string[] {
  const custom = answer.custom?.trim() ?? '';
  return custom === '' ? answer.selected : [...answer.selected, custom];
}

/** Uma linha por pergunta: `Bebida: Café`. É o que o agente recebe de volta. */
export function formatAnswers(answers: readonly AgentQuestionAnswer[]): string {
  return answers
    .map((answer) => `${answer.header}: ${answerValues(answer).join(', ')}`)
    .join('\n');
}

/** Resumo de uma linha, para a timeline do chat. */
export function summarizeAnswers(outcome: AgentQuestionOutcome): string {
  if (outcome.type === 'cancelled') {
    return 'Cancelled';
  }
  return outcome.answers.map((answer) => answerValues(answer).join(', ')).join(' · ');
}

/** Título do passo na timeline: a pergunta, ou quantas foram. */
export function questionTitle(request: AgentQuestionRequest): string {
  const [first] = request.questions;
  if (request.questions.length === 1 && first !== undefined) {
    return first.question;
  }
  return `${request.questions.length} questions`;
}
