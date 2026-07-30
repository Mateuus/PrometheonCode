/**
 * Execução do Claude Code.
 *
 * Roda o CLI em modo não interativo e devolve os eventos conforme eles chegam.
 * Quem consome decide o que fazer com eles — desenhar numa timeline, imprimir
 * no terminal, mandar para o Hub.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { permissionModeFor, translateLine } from './claude-stream.js';
import type { AgentEvent, Autonomy, WorkMode } from './events.js';

/** Tempo para o processo sair sozinho depois de um pedido de interrupção. */
const GRACEFUL_EXIT_MS = 3_000;

export interface ClaudeRunOptions {
  readonly prompt: string;
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  /** Pasta em que o agente trabalha. Sem ela, o diretório atual do processo. */
  readonly cwd?: string | undefined;
  /** Caminho do executável. Sem ele, `claude` no PATH. */
  readonly executable?: string | undefined;
  /**
   * Diretório isolado de credenciais.
   *
   * É o que separa uma conta de outra: dois valores diferentes usam logins
   * diferentes, mesmo havendo outra conta ativa na máquina.
   */
  readonly configDirectory?: string | undefined;
  /** Conversa a retomar. Sem ela, o agente começa sem contexto anterior. */
  readonly resumeSessionId?: string | undefined;
  /** Cancela o run. O processo recebe um pedido de saída, depois é morto. */
  readonly signal?: AbortSignal | undefined;
}

export interface ClaudeRun {
  /** Eventos conforme chegam. Termina quando o processo termina. */
  readonly events: AsyncIterable<AgentEvent>;
  /**
   * Identificador da conversa, disponível depois que o run começa a produzir.
   *
   * É função, e não valor, porque só é conhecido quando o CLI o anuncia — ler
   * antes disso devolveria nulo e a próxima mensagem perderia o contexto.
   */
  sessionId(): string | null;
}

/**
 * Dispara o Claude Code e traduz a saída.
 *
 * **O prompt vai por stdin, nunca como argumento.** Linha de comando tem limite
 * de tamanho (baixo no Windows), fica visível na lista de processos da máquina e
 * passa por uma camada de aspas do sistema operacional. Um prompt com aspas ou
 * quebra de linha — que é a regra, não a exceção — viraria um comando diferente
 * do pretendido.
 */
export function runClaude(options: ClaudeRunOptions): ClaudeRun {
  let cliSessionId: string | null = options.resumeSessionId ?? null;

  const child = spawn(options.executable ?? 'claude', argumentsFor(options), {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: environmentFor(options.configDirectory),
    windowsHide: true,
  });

  // O prompt entra por stdin e a entrada é fechada em seguida: sem isso o CLI
  // fica esperando mais dados e o run nunca termina.
  child.stdin.write(options.prompt);
  child.stdin.end();

  const failure = collectFailure(child);
  let interrupted = false;

  const abort = (): void => {
    interrupted = true;
    stop(child);
  };

  options.signal?.addEventListener('abort', abort, { once: true });

  async function* iterate(): AsyncIterable<AgentEvent> {
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.trim() === '') {
          continue;
        }

        const translated = translateLine(line);

        if (translated.cliSessionId !== null) {
          cliSessionId = translated.cliSessionId;
        }

        for (const event of translated.events) {
          yield event;
        }
      }

      const code = await failure.exitCode;

      if (interrupted) {
        yield { type: 'cancelled' };
        return;
      }

      if (code !== 0) {
        yield { type: 'failed', error: describeExit(code, failure.stderr()) };
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);

      // Quem parou de iterar no meio deixaria o processo rodando — e um agente
      // órfão continua trabalhando, e gastando, sem ninguém escutando.
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    }
  }

  return { events: iterate(), sessionId: () => cliSessionId };
}

/** Confere se o CLI existe e responde. */
export async function claudeIsAvailable(options: {
  executable?: string | undefined;
  configDirectory?: string | undefined;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(options.executable ?? 'claude', ['--version'], {
      env: environmentFor(options.configDirectory),
      windowsHide: true,
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Versão do CLI, ou nulo quando ele não responde. */
export async function claudeVersion(options: {
  executable?: string | undefined;
  configDirectory?: string | undefined;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(options.executable ?? 'claude', ['--version'], {
      env: environmentFor(options.configDirectory),
      windowsHide: true,
    });

    let output = '';

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      // "2.1.198 (Claude Code)" — só a primeira palavra interessa.
      resolve(code === 0 ? (output.trim().split(/\s+/, 1)[0] ?? null) : null);
    });
  });
}

function argumentsFor(options: ClaudeRunOptions): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    // Sem `--verbose` o CLI resume a saída e os eventos de ferramenta não saem;
    // quem acompanha não veria nada acontecer enquanto o agente trabalha.
    '--verbose',
    '--permission-mode',
    permissionModeFor(options.workMode, options.autonomy),
  ];

  if (options.resumeSessionId !== undefined) {
    args.push('--resume', options.resumeSessionId);
  }

  return args;
}

function environmentFor(configDirectory: string | undefined): NodeJS.ProcessEnv {
  return configDirectory === undefined
    ? { ...process.env }
    : { ...process.env, CLAUDE_CONFIG_DIR: configDirectory };
}

/**
 * Pede a saída e, se ela não vier, força.
 *
 * O intervalo existe porque o CLI grava o estado da conversa ao sair; matar de
 * imediato perderia o histórico, e a mensagem seguinte começaria sem contexto.
 */
function stop(child: ChildProcessWithoutNullStreams): void {
  child.kill('SIGTERM');

  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }, GRACEFUL_EXIT_MS);

  // `unref` para o temporizador não segurar o processo vivo se tudo já acabou.
  timer.unref?.();
  child.once('close', () => clearTimeout(timer));
}

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

function describeExit(code: number | null, stderr: string): { name: string; message: string } {
  const detail = stderr.trim();

  return {
    name: 'ClaudeCodeError',
    message:
      detail === ''
        ? `Claude Code exited with code ${String(code)}.`
        : detail.split('\n').slice(-3).join('\n'),
  };
}
