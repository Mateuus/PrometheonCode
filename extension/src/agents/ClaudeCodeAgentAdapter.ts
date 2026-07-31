import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ImageAttachment } from '../chat/types';
import type { Logger } from '../logger';
import type { ProviderProfile } from '../providers/types';
import type { TokenUsage } from '../providers/UsageTracker';
import type { SerializedError } from '../core/types';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentInput,
  AgentSession,
  StartAgentInput,
} from './AgentAdapter';

/**
 * Executa o Claude Code de verdade.
 *
 * O CLI roda em modo não interativo (`--print`) emitindo NDJSON — um objeto JSON
 * por linha. Cada linha vira um `AgentEvent`, que é o mesmo contrato que o mock
 * cumpre; o resto da extensão não sabe qual dos dois está do outro lado.
 *
 * **O prompt vai por stdin, nunca como argumento.** Linha de comando tem limite
 * de tamanho (bem baixo no Windows), fica visível na lista de processos da
 * máquina e passa por uma camada de aspas do sistema operacional. Um prompt com
 * aspas ou quebra de linha — que é a regra, não a exceção — vira um comando
 * diferente do pretendido.
 *
 * **Nada aqui interpreta o que o agente decidiu fazer.** A tradução é de forma:
 * o que o CLI chama de `tool_use` vira `tool.requested`. Se este arquivo
 * começar a decidir o que executar, a decisão passa a viver em dois lugares.
 */

/** Tempo para o processo sair sozinho depois de um pedido de interrupção. */
const GRACEFUL_EXIT_MS = 3_000;

interface RunningSession {
  readonly id: string;
  readonly profile: ProviderProfile;
  readonly workspaceFolder: string | undefined;
  /** Identificador que o CLI dá à conversa; é o que permite retomá-la. */
  cliSessionId: string | null;
  child: ChildProcessWithoutNullStreams | null;
  /** Interrupção pedida por quem chamou, para distinguir de falha real. */
  interrupted: boolean;
}

export class ClaudeCodeAgentAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly transport = 'cli' as const;

  readonly capabilities: AgentCapabilities = {
    chat: true,
    edit: true,
    delegate: true,
    terminal: true,
  };

  private readonly sessions = new Map<string, RunningSession>();

  constructor(
    private readonly logger: Logger,
    /**
     * De onde sai o perfil ativo. É uma função, e não um valor: o perfil pode
     * mudar entre uma mensagem e outra, e capturá-lo na construção prenderia o
     * adaptador à conta que estava ativa quando a extensão subiu.
     */
    private readonly resolveProfile: () => Promise<ProviderProfile | undefined>,
  ) {}

  async isAvailable(): Promise<boolean> {
    const profile = await this.resolveProfile();

    if (profile === undefined) {
      return false;
    }

    return new Promise((resolve) => {
      const child = spawn(executableOf(profile), ['--version'], {
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
      // Esta mensagem vai para a conversa. Ela precisa dizer o que fazer, e
      // não só o que falta: sem o mock atrás, é a primeira coisa que alguém vê
      // ao tentar usar o Prometheon numa instalação nova.
      throw new Error(
        'No account yet. Open the settings panel (gear icon) and add a Claude Code account to start.',
      );
    }

    const id = `claude-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this.sessions.set(id, {
      id,
      profile,
      workspaceFolder: input.workspaceFolder,
      cliSessionId: null,
      child: null,
      interrupted: false,
    });

    return { id, agentId: this.id, startedAt: Date.now() };
  }

  /**
   * Manda a mensagem e traduz a saída do CLI enquanto ela chega.
   *
   * O gerador termina quando o processo termina. Quem consome pode parar de
   * iterar a qualquer momento — o `finally` mata o processo, senão um `claude`
   * órfão continuaria trabalhando (e gastando) sem ninguém escutando.
   */
  async *send(sessionId: string, message: AgentInput): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(sessionId);

    if (session === undefined) {
      throw new Error(`Unknown agent session: ${sessionId}`);
    }

    session.interrupted = false;

    // As imagens viram arquivo antes de o processo subir: o CLI lê imagem de
    // caminho, não de base64 no meio do texto. Sem isto, quem anexasse uma
    // imagem veria o agente responder como se ela não existisse — que é pior do
    // que recusar o anexo, porque parece que o agente olhou e não achou nada.
    const attachments = await this.materialize(message.attachments);

    const child = spawn(executableOf(session.profile), argumentsFor(session, message), {
      cwd: session.workspaceFolder,
      env: environmentFor(session.profile),
      windowsHide: true,
    });

    session.child = child;

    // O prompt entra por stdin e a entrada é fechada em seguida: sem isso o CLI
    // fica esperando mais dados e o run nunca termina.
    child.stdin.write(promptWith(message.content, attachments.paths));
    child.stdin.end();

    yield { type: 'status', status: 'working' };

    const failure = collectFailure(child);

    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.trim() === '') {
          continue;
        }

        const { events, cliSessionId } = translateLine(line);

        if (cliSessionId !== null) {
          session.cliSessionId = cliSessionId;
        }

        for (const event of events) {
          yield event;
        }
      }

      const code = await failure.exitCode;

      if (session.interrupted) {
        yield { type: 'cancelled' };
        return;
      }

      if (code !== 0) {
        // A saída de erro inteira vai para o log; o usuário vê só as últimas
        // linhas. Um rastro de pilha completo na conversa afoga a resposta, e
        // sem ele em lugar nenhum não há como investigar depois.
        this.logger.error(
          `Claude Code terminou com código ${String(code)}: ${failure.stderr().trim()}`,
        );

        yield {
          type: 'failed',
          error: describeExit(code, failure.stderr()),
        };
      }
    } finally {
      session.child = null;
      // Consumidor que abandonou a iteração deixaria o processo rodando.
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }

      await attachments.cleanup();
    }
  }

  /**
   * Grava os anexos em disco e devolve os caminhos.
   *
   * O diretório é temporário e some no fim do run. Deixar imagem do usuário
   * acumulando em `%TEMP%` é vazamento silencioso: ninguém procura ali, e o que
   * foi colado numa conversa fica legível para qualquer processo da máquina.
   *
   * Uma imagem que falha ao gravar é omitida, e não derruba o run — o agente
   * responde ao texto, que continua valendo.
   */
  private async materialize(
    attachments: readonly ImageAttachment[] | undefined,
  ): Promise<{ paths: readonly string[]; cleanup: () => Promise<void> }> {
    if (attachments === undefined || attachments.length === 0) {
      return { paths: [], cleanup: async () => undefined };
    }

    const directory = await mkdtemp(join(tmpdir(), 'prometheon-anexos-'));
    const paths: string[] = [];

    for (const [index, attachment] of attachments.entries()) {
      const file = join(directory, `${String(index + 1)}-${safeName(attachment.name)}`);

      try {
        await writeFile(file, Buffer.from(attachment.data, 'base64'));
        paths.push(file);
      } catch (error) {
        this.logger.error(`Anexo ${attachment.name} não pôde ser gravado: ${String(error)}`);
      }
    }

    return {
      paths,
      cleanup: async () => {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error) {
          this.logger.debug(`Anexos temporários não removidos: ${String(error)}`);
        }
      },
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (session?.child === undefined || session.child === null) {
      return;
    }

    session.interrupted = true;

    const child = session.child;

    child.kill('SIGTERM');

    // O CLI precisa de um instante para gravar o estado da conversa; matar de
    // imediato perderia o histórico e a próxima mensagem começaria sem contexto.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        resolve();
      }, GRACEFUL_EXIT_MS);

      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async dispose(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    this.sessions.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Tradução do NDJSON
// ---------------------------------------------------------------------------

/** O que a tradução aprende com a linha, além dos eventos. */
export interface TranslationResult {
  readonly events: readonly AgentEvent[];
  /**
   * Identificador da conversa anunciado pelo CLI, quando a linha o traz.
   *
   * Guardá-lo é o que permite a segunda mensagem continuar a mesma conversa em
   * vez de começar do zero, sem o contexto do que acabou de acontecer.
   */
  readonly cliSessionId: string | null;
}

/**
 * Converte uma linha do CLI em eventos.
 *
 * Função pura de propósito: é a parte que mais merece teste e a que menos
 * precisa de um processo de verdade para ser exercitada.
 *
 * Formato desconhecido é ignorado em silêncio, e não tratado como erro. O
 * NDJSON pertence ao Claude Code e ganha campos entre versões; derrubar o run
 * porque apareceu um tipo novo transformaria uma atualização do CLI numa quebra
 * do Prometheon.
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
    // vem no evento, então fica em zero e a interface mostra o rótulo sem tempo.
    yield { type: 'thought', durationMs: 0 };
    return;
  }

  if (kind === 'tool_use') {
    const id = block['id'];
    const name = block['name'];

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
        message: typeof event['result'] === 'string' ? event['result'] : 'The agent reported a failure.',
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
 * Os campos de cache entram no total de entrada porque foram cobrados: ignorá-los
 * mostraria um número menor do que o that a conta do provedor vai cobrar, que é
 * a pior direção para um número errado.
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

/** O que a ferramenta está mexendo — o que aparece em destaque na timeline. */
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

// ---------------------------------------------------------------------------
// Processo
// ---------------------------------------------------------------------------

function executableOf(profile: ProviderProfile): string {
  return profile.executablePath ?? 'claude';
}

/**
 * Ambiente do processo.
 *
 * `CLAUDE_CONFIG_DIR` é o que isola a conta: dois perfis apontando para
 * diretórios diferentes usam credenciais diferentes, mesmo com outra conta
 * logada na máquina.
 */
function environmentFor(profile: ProviderProfile): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CONFIG_DIR: profile.configDirectory };
}

function argumentsFor(session: RunningSession, message: AgentInput): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    // Sem `--verbose` o CLI resume a saída e os eventos de ferramenta não saem;
    // a timeline ficaria vazia enquanto o agente trabalha.
    '--verbose',
    '--permission-mode',
    permissionModeFor(message),
  ];

  // O modelo escolhido na conta. Ausente deixa a decisão com o CLI, que é o
  // comportamento certo por padrão: ele acompanha os lançamentos do provedor
  // sem depender de o Prometheon ser atualizado junto.
  if (session.profile.model !== undefined && session.profile.model !== '') {
    args.push('--model', session.profile.model);
  }

  // Retomar a conversa é o que dá contexto à segunda mensagem. Sem isto, cada
  // envio começaria do zero e o agente não lembraria do que acabou de fazer.
  if (session.cliSessionId !== null) {
    args.push('--resume', session.cliSessionId);
  }

  return args;
}

/**
 * Traduz modo de trabalho e autonomia para o que o CLI entende.
 *
 * O modo de planejamento vence a autonomia: quem escolheu "só planejar" não
 * espera edição alguma, mesmo tendo deixado a autonomia no automático. Entre as
 * duas escolhas, a mais restritiva é a que respeita a intenção.
 */
export function permissionModeFor(message: AgentInput): string {
  if (message.workMode === 'plan') {
    return 'plan';
  }

  switch (message.autonomy) {
    case 'bypass':
      return 'bypassPermissions';
    case 'auto':
      return 'acceptEdits';
    default:
      return 'default';
  }
}

/** Acompanha a saída de erro e o código de término sem prender o fluxo. */
function collectFailure(child: ChildProcessWithoutNullStreams): {
  exitCode: Promise<number | null>;
  stderr: () => string;
} {
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    // Limite para um CLI em laço de erro não crescer sem fim na memória.
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });

  const exitCode = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });

  return { exitCode, stderr: () => stderr };
}

function describeExit(code: number | null, stderr: string): SerializedError {
  const detail = stderr.trim();

  return {
    name: 'ClaudeCodeError',
    message:
      detail === ''
        ? `Claude Code exited with code ${String(code)}.`
        : detail.split('\n').slice(-3).join('\n'),
  };
}

/**
 * Junta o texto e os caminhos das imagens num prompt só.
 *
 * O CLI reconhece caminho de arquivo no prompt e lê a imagem. Os caminhos vêm
 * depois do texto, em linhas próprias: no meio da frase eles atrapalhariam a
 * leitura do pedido, que é o que mais importa.
 */
export function promptWith(content: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return content;
  }

  return [content, '', ...paths].join('\n');
}

/**
 * Nome de arquivo seguro.
 *
 * O nome vem do que a pessoa colou ou arrastou, e vai virar caminho em disco.
 * Sem esta limpeza, um nome com `..` ou barra escaparia do diretório temporário
 * e escreveria onde não devia.
 */
export function safeName(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '');

  return cleaned === '' ? 'imagem.png' : cleaned.slice(0, 60);
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? value;
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? value;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
