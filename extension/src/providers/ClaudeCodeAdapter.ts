import { execFile } from 'node:child_process';
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
 * Adaptador do Claude Code. Os comandos abaixo foram verificados no CLI 2.1.x:
 * `claude auth login|logout|status --json` e a variável `CLAUDE_CONFIG_DIR`,
 * que isola de fato a conta — com um diretório vazio, `auth status` responde
 * `loggedIn: false` mesmo havendo outra conta ativa na máquina.
 *
 * O login roda em um terminal do VS Code, e não capturado por nós: é fluxo
 * oficial, interativo, e o token é escrito pelo próprio CLI dentro do diretório
 * isolado. O Prometheon nunca lê esse diretório.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly providerId = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly configEnvironmentVariable = 'CLAUDE_CONFIG_DIR';

  constructor(private readonly logger: Logger) {}

  async detectInstallation(profile?: ProviderProfile): Promise<ProviderInstallation> {
    const executable = this.executable(profile);
    try {
      const { stdout } = await run(executable, ['--version'], { timeout: COMMAND_TIMEOUT_MS });
      // "2.1.198 (Claude Code)" — só a primeira palavra interessa.
      const version = stdout.trim().split(/\s+/, 1)[0];
      return {
        installed: true,
        ...(version === undefined ? {} : { version }),
        executablePath: executable,
      };
    } catch {
      return {
        installed: false,
        detail: `Claude Code CLI not found (${executable}). Install it and reopen this panel.`,
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
      // A dica aparece antes de qualquer coisa: a conta que entrar aqui é a que
      // este perfil vai usar, e nenhuma outra.
      message: `Signing in to "${profile.name}". This profile uses ${this.configEnvironmentVariable}=${profile.configDirectory}`,
    });
    terminal.show(true);
    terminal.sendText(`${this.quote(this.executable(profile))} auth login`);
    this.logger.info(`Login iniciado para o perfil ${profile.id}.`);
  }

  async logout(profile: ProviderProfile): Promise<void> {
    try {
      await this.exec(profile, ['auth', 'logout']);
      this.logger.info(`Logout concluído para o perfil ${profile.id}.`);
    } catch {
      // `logout` sem sessão sai com código diferente de zero; não é falha real.
      this.logger.info(`Logout do perfil ${profile.id} sem sessão ativa.`);
    }
  }

  async getAuthStatus(profile: ProviderProfile): Promise<AuthStatus> {
    const first = await this.tryAuthStatus(profile);
    if (first !== null) {
      return first;
    }
    // Uma releitura cobre o tropeço transitório — CLI ocupado, antivírus
    // segurando o spawn — sem transformar uma sessão OAuth válida em
    // "desconectado" na interface por causa de um blip.
    const second = await this.tryAuthStatus(profile);
    return (
      second ?? {
        authenticated: false,
        message: 'Could not read the authentication status of this profile.',
      }
    );
  }

  /** Uma tentativa de `auth status`. `null` é falha sem resposta utilizável. */
  private async tryAuthStatus(profile: ProviderProfile): Promise<AuthStatus | null> {
    try {
      const stdout = await this.exec(profile, ['auth', 'status', '--json']);
      return parseAuthStatus(stdout);
    } catch (error) {
      // Não autenticado sai com código 1 e ainda imprime o JSON no stdout.
      const stdout = stdoutOf(error);
      return stdout === null ? null : parseAuthStatus(stdout);
    }
  }

  /**
   * O CLI não expõe uma lista de modelos, e inventar uma seria pior que não ter:
   * o usuário escolheria um modelo que a conta dele talvez não tenha.
   */
  listModels(_profile: ProviderProfile): Promise<readonly ModelInfo[]> {
    return Promise.resolve([]);
  }

  private executable(profile?: ProviderProfile): string {
    return profile?.executablePath ?? 'claude';
  }

  /** Executa um comando do CLI já isolado no diretório do perfil. */
  private async exec(profile: ProviderProfile, args: readonly string[]): Promise<string> {
    const { stdout } = await run(this.executable(profile), [...args], {
      timeout: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        [this.configEnvironmentVariable]: profile.configDirectory,
      },
    });
    return stdout;
  }

  private quote(value: string): string {
    return value.includes(' ') ? `"${value}"` : value;
  }
}

/** Erro do `execFile` carrega o stdout já produzido; ele ainda é útil aqui. */
function stdoutOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'stdout' in error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' && stdout.trim() !== '' ? stdout : null;
  }
  return null;
}

/**
 * Converte a saída de `claude auth status --json`. Campos desconhecidos são
 * ignorados: o formato pertence ao CLI e pode mudar entre versões.
 */
export function parseAuthStatus(stdout: string): AuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { authenticated: false, message: 'Unexpected output from the CLI.' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { authenticated: false, message: 'Unexpected output from the CLI.' };
  }

  const record = parsed as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : undefined;

  return {
    authenticated: record['loggedIn'] === true,
    ...optional('accountLabel', text('email')),
    ...optional('organization', text('orgName')),
    ...optional('plan', text('subscriptionType')),
    ...optional('authMethod', text('authMethod')),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
