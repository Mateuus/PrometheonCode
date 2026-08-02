import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import type {
  AuthStatus,
  ModelInfo,
  ProviderAdapter,
  ProviderInstallation,
  ProviderProfile,
} from './types';

const run = promisify(execFile);

/** Nenhum comando do CLI pode travar a extensão. */
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * Onde o Codex costuma ficar quando não está no PATH.
 *
 * O instalador oficial do Windows põe o binário sob `%LOCALAPPDATA%\OpenAI\
 * Codex\bin\<hash>\codex.exe` e **não** mexe no PATH — quem instalou por ali
 * tem o CLI funcionando no terminal do app e nada em `codex --version`. Sem
 * esta busca, a conta apareceria como "CLI ausente" numa máquina onde ele está
 * instalado, que é o pior tipo de erro: verdadeiro na aparência, falso no fato.
 */
function candidatePaths(): readonly string[] {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const local = process.env['LOCALAPPDATA'] ?? (home === '' ? '' : join(home, 'AppData', 'Local'));
  const roots: string[] = [];

  if (local !== '') {
    roots.push(join(local, 'OpenAI', 'Codex', 'bin'));
  }
  if (home !== '') {
    roots.push(join(home, '.codex', 'bin'), join(home, '.local', 'bin'));
  }
  return roots;
}

/** Nome do executável nesta plataforma. */
const EXECUTABLE = process.platform === 'win32' ? 'codex.exe' : 'codex';

/**
 * Procura o binário nas pastas conhecidas. O instalador usa um diretório com
 * hash no nome, então a varredura desce um nível — o suficiente para achá-lo
 * sem sair vasculhando o disco.
 */
async function discoverExecutable(): Promise<string | null> {
  for (const root of candidatePaths()) {
    const direct = join(root, EXECUTABLE);
    if (await exists(direct)) {
      return direct;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
    } catch {
      continue;
    }
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) {
        continue;
      }
      const nested = join(root, name, EXECUTABLE);
      if (await exists(nested)) {
        return nested;
      }
    }
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Caminho utilizável do Codex: o do perfil, o do PATH, ou o que a busca achar.
 * O resultado é lembrado — sondar o disco a cada comando seria caro e inútil.
 */
let discovered: string | null | undefined;

export async function resolveCodexExecutable(profile?: ProviderProfile): Promise<string> {
  if (profile?.executablePath !== undefined && profile.executablePath !== '') {
    return profile.executablePath;
  }
  if (discovered === undefined) {
    discovered = (await onPath()) ? 'codex' : await discoverExecutable();
  }
  return discovered ?? 'codex';
}

async function onPath(): Promise<boolean> {
  try {
    await run('codex', ['--version'], { timeout: COMMAND_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Adaptador do Codex CLI. Os comandos abaixo foram conferidos no CLI 0.142.5:
 * `codex login`, `codex logout`, `codex login status` e a variável `CODEX_HOME`,
 * que isola de fato a conta — o próprio `--help` do CLI diz que a autenticação
 * segue essa variável mesmo quando a configuração do usuário é ignorada.
 *
 * Como no Claude Code, o login roda num terminal do VS Code e não é capturado:
 * é fluxo oficial, e o token é escrito pelo próprio CLI dentro do diretório
 * isolado. O Prometheon nunca lê esse diretório.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly providerId = 'codex-cli' as const;
  readonly displayName = 'Codex';
  readonly configEnvironmentVariable = 'CODEX_HOME';

  constructor(private readonly logger: Logger) {}

  async detectInstallation(profile?: ProviderProfile): Promise<ProviderInstallation> {
    const executable = await this.executable(profile);
    try {
      const { stdout, stderr } = await run(executable, ['--version'], {
        timeout: COMMAND_TIMEOUT_MS,
      });
      // "codex-cli 0.142.5" — só o número interessa, venha de onde vier.
      const version = /(\d+\.\d+\.\d+)/.exec([stdout, stderr].join(' '))?.[1];
      return {
        installed: true,
        ...(version === undefined ? {} : { version }),
        executablePath: executable,
      };
    } catch {
      return {
        installed: false,
        detail: `Codex CLI not found (${executable}). Install it and reopen this panel.`,
      };
    }
  }

  async createIsolatedEnvironment(profile: ProviderProfile): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(profile.configDirectory));
  }

  /**
   * Abre o login oficial num terminal dedicado. Nada é digitado por nós e a
   * saída não é capturada — o usuário conclui o fluxo na conta dele.
   */
  async login(profile: ProviderProfile): Promise<void> {
    await this.createIsolatedEnvironment(profile);
    const terminal = vscode.window.createTerminal({
      name: `Prometheon — login ${profile.name}`,
      env: { [this.configEnvironmentVariable]: profile.configDirectory },
      message: `Signing in to "${profile.name}". This profile uses ${this.configEnvironmentVariable}=${profile.configDirectory}`,
    });
    terminal.show(true);
    terminal.sendText(`${this.quote(await this.executable(profile))} login`);
    this.logger.info(`Login do Codex iniciado para o perfil ${profile.id}.`);
  }

  async logout(profile: ProviderProfile): Promise<void> {
    try {
      await this.exec(profile, ['logout']);
      this.logger.info(`Logout do Codex concluído para o perfil ${profile.id}.`);
    } catch {
      // Sair sem sessão sai com código diferente de zero; não é falha real.
      this.logger.info(`Logout do Codex sem sessão ativa (${profile.id}).`);
    }
  }

  /**
   * `codex login status` responde em texto, não em JSON — daí a leitura por
   * linha em vez de `JSON.parse`. Formatos conhecidos: "Logged in using
   * ChatGPT", "Logged in using an API key" e "Not logged in".
   */
  async getAuthStatus(profile: ProviderProfile): Promise<AuthStatus> {
    try {
      const stdout = await this.exec(profile, ['login', 'status']);
      return parseLoginStatus(stdout);
    } catch (error) {
      const stdout = stdoutOf(error);
      if (stdout !== null) {
        return parseLoginStatus(stdout);
      }
      return {
        authenticated: false,
        message: 'Could not read the authentication status of this profile.',
      };
    }
  }

  /**
   * O CLI não lista modelos, e o catálogo do Prometheon não inventa um: o
   * campo Model do agente aceita texto livre e quem valida é o próprio Codex
   * na hora de rodar.
   */
  listModels(_profile: ProviderProfile): Promise<readonly ModelInfo[]> {
    return Promise.resolve([]);
  }

  private executable(profile?: ProviderProfile): Promise<string> {
    return resolveCodexExecutable(profile);
  }

  /**
   * Executa um comando do CLI já isolado no diretório do perfil.
   *
   * As duas saídas são juntadas de propósito: o `codex login status` responde
   * pelo **stderr** com código de saída 0 — ler só o stdout devolvia vazio e a
   * conta aparecia como desconectada logo depois de um login bem-sucedido.
   */
  private async exec(profile: ProviderProfile, args: readonly string[]): Promise<string> {
    const { stdout, stderr } = await run(await this.executable(profile), [...args], {
      timeout: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        [this.configEnvironmentVariable]: profile.configDirectory,
      },
    });
    return [stdout, stderr].join(' ').trim();
  }

  private quote(value: string): string {
    return value.includes(' ') ? `"${value}"` : value;
  }
}

/** Erro do `execFile` carrega o stdout já produzido; ele ainda é útil aqui. */
function stdoutOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  // Falhou, mas o CLI ainda pode ter dito algo — e o Codex diz pelo stderr.
  const shape = error as { stdout?: unknown; stderr?: unknown };
  const text = [shape.stdout, shape.stderr]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .trim();
  return text === '' ? null : text;
}

/**
 * Lê a saída de `codex login status`. Campos desconhecidos são ignorados: o
 * texto pertence ao CLI e pode mudar entre versões — o que não pode mudar é a
 * regra de só dizer "autenticado" quando ele afirma que está.
 */
export function parseLoginStatus(stdout: string): AuthStatus {
  const text = stdout.trim();
  if (text === '') {
    return { authenticated: false, message: 'Unexpected output from the CLI.' };
  }

  const authenticated = /logged in/i.test(text) && !/not logged in/i.test(text);
  if (!authenticated) {
    return { authenticated: false };
  }

  // "Logged in using ChatGPT" / "Logged in using an API key" — o que vem
  // depois de "using" é o método, e é a única parte reaproveitável.
  const method = /logged in using ([^\n\r.]+)/i.exec(text)?.[1]?.trim();
  // Alguns formatos trazem o e-mail da conta numa linha própria.
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text)?.[0];

  return {
    authenticated: true,
    ...(method === undefined ? {} : { authMethod: method }),
    ...(email === undefined ? {} : { accountLabel: email }),
  };
}
