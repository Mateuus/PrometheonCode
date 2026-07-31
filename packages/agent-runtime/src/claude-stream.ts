/**
 * Tradução da saída do Claude Code.
 *
 * O CLI emite NDJSON — um objeto JSON por linha. Cada linha vira um `AgentEvent`.
 *
 * Tudo aqui é função pura: é a parte que mais merece teste e a que menos
 * precisa de um processo de verdade para ser exercitada. E é a fronteira com um
 * programa que não é nosso — o formato pertence ao Claude Code e ganha campos
 * entre versões.
 *
 * **Nada aqui interpreta o que o agente decidiu fazer.** A tradução é de forma:
 * o que o CLI chama de `tool_use` vira `tool.requested`. Se este arquivo
 * começar a decidir o que executar, a decisão passa a viver em dois lugares.
 */

import type { AgentEvent, Autonomy, TokenUsage, WorkMode } from './events.js';

/** O que a tradução aprende com a linha, além dos eventos. */
export interface TranslationResult {
  readonly events: readonly AgentEvent[];
  /**
   * Identificador da conversa anunciado pelo CLI, quando a linha o traz.
   *
   * Guardá-lo é o que permite a mensagem seguinte continuar a mesma conversa em
   * vez de começar do zero, sem o contexto do que acabou de acontecer.
   */
  readonly cliSessionId: string | null;
}

/**
 * Converte uma linha do CLI em eventos.
 *
 * Formato desconhecido é ignorado em silêncio, e não tratado como erro:
 * derrubar o run porque apareceu um tipo novo transformaria uma atualização do
 * Claude Code numa quebra do Prometheon.
 */
export function translateLine(line: string): TranslationResult {
  let payload: unknown;

  try {
    payload = JSON.parse(line);
  } catch {
    return { events: [], cliSessionId: null };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { events: [], cliSessionId: null };
  }

  const event = payload as Record<string, unknown>;
  const rawSessionId = event['session_id'];
  const cliSessionId =
    typeof rawSessionId === 'string' && rawSessionId !== '' ? rawSessionId : null;

  const events: AgentEvent[] = [];

  switch (event['type']) {
    case 'assistant':
      events.push(...fromAssistant(event));
      break;

    case 'user':
      events.push(...fromToolResults(event));
      break;

    case 'result':
      events.push(fromResult(event));
      break;

    default:
      break;
  }

  return { events, cliSessionId };
}

function* fromAssistant(event: Record<string, unknown>): Generator<AgentEvent> {
  const message = event['message'];

  if (typeof message !== 'object' || message === null) {
    return;
  }

  const content = (message as Record<string, unknown>)['content'];

  if (Array.isArray(content)) {
    for (const part of content) {
      yield* fromContentPart(part);
    }
  }

  const usage = readUsage((message as Record<string, unknown>)['usage']);

  if (usage !== null) {
    yield { type: 'usage', delta: usage };
  }
}

function* fromContentPart(part: unknown): Generator<AgentEvent> {
  if (typeof part !== 'object' || part === null) {
    return;
  }

  const block = part as Record<string, unknown>;
  const kind = block['type'];

  if (kind === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
    yield { type: 'delta', text: block['text'] };
    return;
  }

  if (kind === 'thinking') {
    // O conteúdo do raciocínio não é exibido — só que ele existiu. A duração não
    // vem no evento, então fica em zero e quem mostra omite o tempo.
    yield { type: 'thought', durationMs: 0 };
    return;
  }

  if (kind === 'tool_use') {
    const id = block['id'];
    const name = block['name'];

    // Sem `id` não há como ligar ao resultado depois; emitir deixaria um bloco
    // eternamente "em andamento" na tela.
    if (typeof id !== 'string' || typeof name !== 'string') {
      return;
    }

    const input = (block['input'] ?? {}) as Record<string, unknown>;
    const detail = describeDetail(input);

    yield {
      type: 'tool.requested',
      toolId: id,
      tool: name,
      title: describeTarget(name, input),
      ...(detail === null ? {} : { detail }),
    };
  }
}

function* fromToolResults(event: Record<string, unknown>): Generator<AgentEvent> {
  const message = event['message'];

  if (typeof message !== 'object' || message === null) {
    return;
  }

  const content = (message as Record<string, unknown>)['content'];

  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (typeof part !== 'object' || part === null) {
      continue;
    }

    const block = part as Record<string, unknown>;

    if (block['type'] !== 'tool_result') {
      continue;
    }

    const toolId = block['tool_use_id'];

    if (typeof toolId !== 'string') {
      continue;
    }

    const output = flattenResult(block['content']);

    yield {
      type: 'tool.completed',
      toolId,
      ...(output === null ? {} : { output }),
      ...(block['is_error'] === true ? { failed: true } : {}),
    };
  }
}

function fromResult(event: Record<string, unknown>): AgentEvent {
  // `is_error` distingue "o agente terminou dizendo que não deu" de "o agente
  // terminou". Sem isso, uma recusa apareceria como resposta normal.
  if (event['is_error'] === true) {
    return {
      type: 'failed',
      error: {
        name: 'AgentError',
        message:
          typeof event['result'] === 'string' ? event['result'] : 'The agent reported a failure.',
      },
    };
  }

  const usage = readUsage(event['usage']);

  return {
    type: 'completed',
    text: typeof event['result'] === 'string' ? event['result'] : '',
    ...(usage === null ? {} : { usage }),
  };
}

/**
 * Lê a contagem de tokens.
 *
 * Os campos de cache entram no total de entrada porque foram cobrados:
 * ignorá-los mostraria um número menor do que o que a conta do provedor vai
 * cobrar, que é a pior direção para um número errado.
 */
export function readUsage(value: unknown): TokenUsage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const usage = value as Record<string, unknown>;
  const number = (key: string): number => {
    const raw = usage[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };

  const input =
    number('input_tokens') +
    number('cache_creation_input_tokens') +
    number('cache_read_input_tokens');
  const output = number('output_tokens');

  return input === 0 && output === 0 ? null : { input, output };
}

/** O que a ferramenta está mexendo — o que aparece em destaque. */
function describeTarget(tool: string, input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern', 'url', 'command']) {
    const value = input[key];

    if (typeof value === 'string' && value !== '') {
      return key === 'command' ? firstLine(value) : basename(value);
    }
  }

  return tool;
}

/** A linha de apoio. Nulo quando não há nada de útil a dizer. */
function describeDetail(input: Record<string, unknown>): string | null {
  const content = input['content'];

  if (typeof content === 'string') {
    const lines = content.split('\n').length;
    return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  }

  const description = input['description'];

  if (typeof description === 'string' && description !== '') {
    return description;
  }

  return null;
}

/** O resultado da ferramenta vem como texto ou como lista de blocos. */
function flattenResult(value: unknown): string | null {
  if (typeof value === 'string') {
    return value === '' ? null : value;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .map((part) => {
      if (typeof part !== 'object' || part === null) {
        return '';
      }
      const block = part as Record<string, unknown>;
      return typeof block['text'] === 'string' ? block['text'] : '';
    })
    .filter((part) => part !== '')
    .join('\n');

  return text === '' ? null : text;
}

/**
 * Traduz modo de trabalho e autonomia para o que o CLI entende.
 *
 * O modo de planejamento vence a autonomia: quem escolheu "só planejar" não
 * espera edição alguma, mesmo tendo deixado a autonomia no automático. Entre as
 * duas escolhas, a mais restritiva é a que respeita a intenção.
 */
export function permissionModeFor(workMode: WorkMode, autonomy: Autonomy): string {
  if (workMode === 'plan') {
    return 'plan';
  }

  switch (autonomy) {
    case 'bypass':
      return 'bypassPermissions';
    case 'auto':
      return 'acceptEdits';
    default:
      return 'default';
  }
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? value;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
