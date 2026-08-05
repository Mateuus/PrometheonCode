import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from '../logger';
import { resolveCodexExecutable } from '../providers/CodexAdapter';
import type { ProviderProfile } from '../providers/types';
import type { EffortLevel } from '../core/types';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  StartAgentInput,
} from './AgentAdapter';

/**
 * Executa o Codex CLI de verdade.
 *
 * O modo não interativo é `codex exec --json`, que emite JSONL — um objeto por
 * linha. Cada linha vira um `AgentEvent`, o mesmo contrato que o Claude Code e
 * o mock cumprem; o resto da extensão não sabe qual dos três está do outro
 * lado. O vocabulário abaixo foi conferido no CLI 0.142.5.
 *
 * **O prompt vai por stdin**, como no Claude Code e pelo mesmo motivo: linha de
 * comando tem limite de tamanho, aparece na lista de processos e passa pelas
 * aspas do sistema operacional.
 *
 * **Nada aqui interpreta o que o agente decidiu fazer**: a tradução é de forma.
 */

/** Tempo para o processo sair sozinho depois de um pedido de interrupção. */
const GRACEFUL_EXIT_MS = 3_000;

interface RunningSession {
  readonly id: string;
  readonly profile: ProviderProfile;
  /** Caminho já resolvido do CLI: o `spawn` não espera promessa. */
  readonly executable: string;
  readonly workspaceFolder: string | undefined;
  readonly model: string | undefined;
  readonly effort: EffortLevel | undefined;
  readonly systemPrompt: string | undefined;
  readonly workMode: StartAgentInput['workMode'];
  readonly autonomy: StartAgentInput['autonomy'];
  readonly readOnly: boolean;
  /** Identificador que o CLI dá à conversa; é o que permite retomá-la. */
  threadId: string | null;
  child: ChildProcessWithoutNullStreams | null;
  interrupted: boolean;
}

export class CodexAgentAdapter implements AgentAdapter {
  // O id casa com o `providerId` da conta: é por ele que o núcleo resolve
  // qual adaptador executa um perfil de agente.
  readonly id = 'codex-cli';
  readonly displayName = 'Codex';
  readonly transport = 'cli' as const;

  /**
   * Vocabulário do Codex. A API aceita `none|minimal|low|medium|high|xhigh|max`
   * (conferido no CLI 0.142.5), então a escala do Prometheon casa inteira; os
   * nomes são os que a interface do Codex mostra. Sem `ultracode`: aquele
   * degrau é do Claude Code, e oferecê-lo aqui prometeria o que não existe.
   */
  readonly effortLabels: Partial<Record<EffortLevel, string>> = {
    low: 'Light',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Ultra',
  };

  readonly capabilities: AgentCapabilities = {
    chat: true,
    edit: true,
    // O Codex executa sozinho, mas não delega a subagentes pelo `exec`.
    delegate: false,
    terminal: true,
  };

  private readonly sessions = new Map<string, RunningSession>();

  constructor(
    private readonly logger: Logger,
    private readonly resolveProfile: () => Promise<ProviderProfile | undefined>,
  ) {}

  async isAvailable(): Promise<boolean> {
    const profile = await this.resolveProfile();

    if (profile === undefined) {
      return false;
    }

    const executable = await resolveCodexExecutable(profile);

    return new Promise((resolve) => {
      const child = spawn(executable, ['--version'], {
        env: environmentFor(profile),
        windowsHide: true,
      });

      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  async start(input: StartAgentInput): Promise<AgentSession> {
    const profile = await this.resolveProfile();

    if (profile === undefined) {
      throw new Error(
        'No Codex account yet. Open the settings panel (gear icon) and add one to start.',
      );
    }

    const id = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(id, {
      id,
      profile,
      executable: await resolveCodexExecutable(profile),
      workspaceFolder: input.workspaceFolder,
      model: input.model,
      effort: input.effort,
      systemPrompt: input.systemPrompt,
      workMode: input.workMode,
      autonomy: input.autonomy,
      readOnly: input.readOnly ?? false,
      threadId: input.resumeId ?? null,
      child: null,
      interrupted: false,
    });

    return { id, agentId: this.id, startedAt: Date.now() };
  }

  async *send(sessionId: string, message: AgentInput): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(sessionId);

    if (session === undefined) {
      throw new Error(`Unknown agent session: ${sessionId}`);
    }

    session.interrupted = false;

    const child = spawn(session.executable, argumentsFor(session), {
      cwd: session.workspaceFolder,
      env: environmentFor(session.profile),
      windowsHide: true,
    });

    session.child = child;
    // O prompt entra por stdin e a entrada é fechada em seguida: sem isso o
    // CLI fica esperando mais dados e o run nunca termina.
    child.stdin.write(promptWith(session, message.content));
    child.stdin.end();

    yield { type: 'status', status: 'working' };

    const failure = collectFailure(child);
    let answered = false;

    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.trim() === '') {
          continue;
        }

        const { events, threadId } = translateCodexLine(line);

        if (threadId !== null && session.threadId === null) {
          session.threadId = threadId;
          this.logger.info(`Codex: conversa ${threadId} iniciada na sessão ${session.id}.`);
        }

        for (const event of events) {
          if (event.type === 'completed') {
            answered = true;
          }
          yield event;
        }
      }

      const code = await failure.exitCode;

      if (session.interrupted) {
        yield { type: 'cancelled' };
        return;
      }

      if (!answered) {
        // Terminou sem resposta: é falha, e o motivo mais útil é o stderr do
        // processo. Silenciar aqui deixaria a conversa parada sem explicação.
        yield {
          type: 'failed',
          error: {
            name: 'CodexRunFailed',
            message: failureMessage(failure.stderr(), code),
            code: 'codex.run-failed',
          },
        };
      }
    } finally {
      session.child = null;
      if (child.exitCode === null) {
        child.kill();
      }
    }
  }

  resumeId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.threadId ?? null;
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const child = session?.child;

    if (session === undefined || child === null || child === undefined) {
      return;
    }

    session.interrupted = true;
    child.kill();
    // Uma janela para o processo sair sozinho; passou disso, vai à força.
    await new Promise((resolve) => setTimeout(resolve, GRACEFUL_EXIT_MS));
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }

  async dispose(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    this.sessions.delete(sessionId);
  }
}

/** O prompt inclui as instruções do Prometheon quando a sessão é nova. */
function promptWith(session: RunningSession, content: string): string {
  // O Codex não tem `--append-system-prompt`: as instruções entram no corpo do
  // primeiro turno, e o `resume` mantém o contexto nos seguintes.
  if (session.threadId !== null || session.systemPrompt === undefined || session.systemPrompt === '') {
    return content;
  }
  return `${session.systemPrompt}\n\n---\n\n${content}`;
}

function environmentFor(profile: ProviderProfile): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: profile.configDirectory };
}

export function argumentsFor(session: RunningSession): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check'];

  // Retomar a conversa é o que dá contexto à segunda mensagem; sem isto cada
  // envio começaria do zero.
  if (session.threadId !== null) {
    args.splice(1, 0, 'resume');
    args.push(session.threadId);
  }

  if (session.model !== undefined && session.model !== '') {
    args.push('--model', session.model);
  }

  // O esforço é configuração, não flag: `-c model_reasoning_effort=<nível>`.
  // A escala do Prometheon casa com a do Codex, menos `ultracode`, que é do
  // Claude Code — aqui ele vale como `xhigh`, o degrau equivalente.
  if (session.effort !== undefined) {
    const effort = session.effort === 'ultracode' ? 'xhigh' : session.effort;
    args.push('-c', `model_reasoning_effort="${effort}"`);
  }

  // `codex exec` não tem aprovação: não há humano no meio de um run não
  // interativo. O controle é a sandbox, e o bypass tem flag própria — a de
  // sandbox sozinha não desliga a política de aprovação embutida.
  if (session.autonomy === 'bypass' && session.workMode !== 'plan') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', sandboxFor(session));
  }

  if (session.workspaceFolder !== undefined) {
    args.push('--cd', session.workspaceFolder);
  }

  return args;
}

/**
 * Modo de trabalho e autonomia viram sandbox do Codex.
 *
 * Planejar é leitura pura; editar precisa de escrita no workspace; bypass é o
 * acesso total, e só chega aqui porque alguém o concedeu explicitamente.
 */
export function sandboxFor(session: {
  workMode: StartAgentInput['workMode'];
  autonomy: StartAgentInput['autonomy'];
  readOnly?: boolean;
}): string {
  // Worker de leitura e modo de planejamento chegam no mesmo lugar: sem escrita.
  if (session.workMode === 'plan' || session.readOnly === true) {
    return 'read-only';
  }
  // Bypass em modo de edição não passa por aqui: ele usa a flag própria do
  // Codex, que desliga sandbox e aprovações de uma vez.
  return session.autonomy === 'bypass' ? 'danger-full-access' : 'workspace-write';
}

export interface CodexTranslation {
  readonly events: readonly AgentEvent[];
  readonly threadId: string | null;
}

/**
 * Traduz uma linha do JSONL do Codex.
 *
 * O formato foi capturado do CLI 0.142.5: `thread.started` traz o id da
 * conversa, `turn.started`/`turn.completed`/`turn.failed` delimitam o turno, e
 * `item.completed` carrega o que aconteceu — mensagem do agente, raciocínio,
 * comando executado, alteração de arquivo, erro. Tipo desconhecido é ignorado
 * de propósito: um CLI que ganha um item novo não pode derrubar o run.
 */
export function translateCodexLine(line: string): CodexTranslation {
  let payload: unknown;

  try {
    payload = JSON.parse(line);
  } catch {
    // Linha que não é JSON é log do CLI, não evento.
    return { events: [], threadId: null };
  }

  if (!isRecord(payload)) {
    return { events: [], threadId: null };
  }

  switch (payload['type']) {
    case 'thread.started': {
      const threadId = text(payload['thread_id']);
      return { events: [], threadId };
    }

    case 'turn.started':
      return { events: [{ type: 'status', status: 'working' }], threadId: null };

    case 'turn.completed': {
      const usage = readUsage(payload['usage']);
      return {
        events: usage === null ? [] : [{ type: 'usage', delta: usage }],
        threadId: null,
      };
    }

    case 'turn.failed':
      return {
        events: [
          {
            type: 'failed',
            error: {
              name: 'CodexTurnFailed',
              message: readErrorMessage(payload['error']) ?? 'The Codex turn failed.',
              code: 'codex.turn-failed',
            },
          },
        ],
        threadId: null,
      };

    case 'error':
      return {
        events: [
          {
            type: 'failed',
            error: {
              name: 'CodexError',
              message: text(payload['message']) ?? 'The Codex CLI reported an error.',
              code: 'codex.error',
            },
          },
        ],
        threadId: null,
      };

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return {
        events: translateItem(payload['item'], payload['type'] === 'item.completed'),
        threadId: null,
      };

    default:
      return { events: [], threadId: null };
  }
}

/** Um item do turno vira o evento equivalente do contrato do Prometheon. */
function translateItem(raw: unknown, completed: boolean): readonly AgentEvent[] {
  if (!isRecord(raw)) {
    return [];
  }
  const id = text(raw['id']) ?? 'item';

  switch (raw['type']) {
    case 'agent_message': {
      const content = text(raw['text']) ?? text(raw['message']);
      return completed && content !== null ? [{ type: 'completed', text: content }] : [];
    }

    case 'reasoning': {
      // O Codex entrega o raciocínio já resumido; o contrato daqui só carrega
      // a duração, então o texto vira um passo de pensamento sem corpo.
      return completed ? [{ type: 'thought', durationMs: 0 }] : [];
    }

    case 'command_execution': {
      const command = text(raw['command']) ?? '';
      if (!completed) {
        return [
          {
            type: 'tool.requested',
            toolId: id,
            tool: 'Bash',
            title: firstLine(command),
            ...(command === '' ? {} : { detail: command }),
          },
        ];
      }
      const output = text(raw['aggregated_output']) ?? text(raw['output']);
      const exit = raw['exit_code'];
      return [
        {
          type: 'tool.completed',
          toolId: id,
          ...(output === null ? {} : { output }),
          ...(typeof exit === 'number' && exit !== 0 ? { failed: true } : {}),
        },
      ];
    }

    case 'file_change': {
      const changes = Array.isArray(raw['changes']) ? raw['changes'] : [];
      const paths = changes
        .map((change) => (isRecord(change) ? text(change['path']) : null))
        .filter((path): path is string => path !== null);
      if (!completed) {
        const edit = editFromChanges(changes);
        return [
          {
            type: 'tool.requested',
            toolId: id,
            tool: 'Edit',
            title: paths[0] ?? 'files',
            ...(paths.length > 1 ? { detail: `${String(paths.length)} files` } : {}),
            ...(edit === null ? {} : { edit }),
          },
        ];
      }
      return [{ type: 'tool.completed', toolId: id }];
    }

    case 'mcp_tool_call': {
      const server = text(raw['server']) ?? 'mcp';
      const tool = text(raw['tool']) ?? 'tool';
      return completed
        ? [{ type: 'tool.completed', toolId: id }]
        : [{ type: 'tool.requested', toolId: id, tool: 'MCP', title: `${server}.${tool}` }];
    }

    case 'web_search': {
      const query = text(raw['query']) ?? '';
      return completed
        ? [{ type: 'tool.completed', toolId: id }]
        : [{ type: 'tool.requested', toolId: id, tool: 'Search', title: query }];
    }

    case 'error': {
      // Erro de item é aviso do CLI (modelo desconhecido, por exemplo) e não
      // derruba o turno: vira um passo, e o turno decide o desfecho.
      const message = text(raw['message']);
      return message === null
        ? []
        : [
            { type: 'tool.requested', toolId: id, tool: 'Codex', title: firstLine(message) },
            { type: 'tool.completed', toolId: id, output: message, failed: true },
          ];
    }

    default:
      return [];
  }
}

function readUsage(raw: unknown): { input: number; output: number } | null {
  if (!isRecord(raw)) {
    return null;
  }
  const input = number(raw['input_tokens']) ?? number(raw['cached_input_tokens']) ?? 0;
  const output = number(raw['output_tokens']) ?? 0;
  return input === 0 && output === 0 ? null : { input, output };
}

function readErrorMessage(raw: unknown): string | null {
  if (isRecord(raw)) {
    return text(raw['message']);
  }
  return text(raw);
}

/**
 * O que a edição tira e põe, a partir do que o Codex reporta em `file_change`.
 *
 * Ele pode descrever a mudança de duas formas, e as duas são aceitas aqui: um
 * diff unificado — o formato do `git diff`, com `-` e `+` no começo da linha —
 * ou o conteúdo antigo e o novo em campos separados. Nenhuma das duas veio a
 * ser observada numa execução real: o CLI instalado aqui não roda com esta
 * conta, e escrever só para o formato que eu adivinhasse seria pior do que
 * aceitar os dois. Quando nada disso vier, o passo continua como antes, sem
 * diff — degradar para o comportamento de ontem é aceitável; inventar um diff
 * errado não é.
 */
function editFromChanges(changes: readonly unknown[]): {
  removed?: string;
  added?: string;
} | null {
  const removed: string[] = [];
  const added: string[] = [];

  for (const change of changes) {
    if (!isRecord(change)) {
      continue;
    }
    const unified = text(change['diff']) ?? text(change['unified_diff']) ?? text(change['patch']);
    if (unified !== null) {
      for (const line of unified.split('\n')) {
        // `---` e `+++` são cabeçalho de arquivo, não conteúdo alterado.
        if (line.startsWith('---') || line.startsWith('+++')) {
          continue;
        }
        if (line.startsWith('-')) {
          removed.push(line.slice(1));
        } else if (line.startsWith('+')) {
          added.push(line.slice(1));
        }
      }
      continue;
    }

    const before = text(change['old_content']) ?? text(change['before']);
    const after = text(change['new_content']) ?? text(change['after']) ?? text(change['content']);
    if (before !== null) {
      removed.push(before);
    }
    if (after !== null) {
      added.push(after);
    }
  }

  if (removed.length === 0 && added.length === 0) {
    return null;
  }
  return {
    ...(removed.length === 0 ? {} : { removed: removed.join('\n') }),
    ...(added.length === 0 ? {} : { added: added.join('\n') }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? value;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/**
 * Linhas que o Codex escreve no stderr sem que nada tenha dado errado.
 *
 * Ele conta o que está fazendo por ali — "Reading prompt from stdin..." é
 * anúncio, não defeito. Repassá-las como causa da falha faz o usuário caçar um
 * erro que não existe, enquanto o motivo verdadeiro fica escondido.
 */
const CODEX_NOISE = [
  /^Reading prompt from stdin/i,
  /^\s*$/,
  // Linha de log com carimbo de tempo e nivel: informacao de execucao, nao falha.
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(INFO|DEBUG|TRACE)/,
];

/** O que dizer quando o processo termina sem responder. */
export function failureMessage(stderr: string, code: number | null): string {
  const meaningful = stderr
    .split('\n')
    .filter((line) => !CODEX_NOISE.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim();
  return meaningful === ''
    ? `The Codex CLI exited with code ${String(code)} without answering, and said nothing about why.`
    : meaningful;
}

/** Acompanha a saída de erro e o código de término sem prender o fluxo. */
function collectFailure(child: ChildProcessWithoutNullStreams): {
  exitCode: Promise<number | null>;
  stderr: () => string;
} {
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitCode = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });

  return { exitCode, stderr: () => stderr };
}

export type { RunningSession as CodexRunningSession };
