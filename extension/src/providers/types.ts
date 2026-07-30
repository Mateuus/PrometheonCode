/**
 * Multi-Provider Agent Profiles — camada de provedores.
 *
 * Um `ProviderProfile` é uma conta/instalação local autenticada de um CLI. O
 * Prometheon nunca lê, copia ou transporta as credenciais: ele apenas aponta o
 * CLI para um diretório de configuração isolado e pergunta o status por lá.
 */

export type ProviderId = 'claude-code' | 'codex-cli' | 'gemini-cli' | 'kimi-cli' | (string & {});

export const PROVIDER_IDS: readonly ProviderId[] = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'kimi-cli',
];

/** Metadados de um perfil. Nada aqui é segredo — os segredos ficam no CLI. */
export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly providerId: ProviderId;
  /** Diretório isolado de configuração do CLI, fora do repositório. */
  readonly configDirectory: string;
  readonly executablePath?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProviderInstallation {
  readonly installed: boolean;
  readonly version?: string;
  /** Caminho do executável encontrado, quando houver. */
  readonly executablePath?: string;
  /** Motivo já pronto para exibir quando não estiver instalado. */
  readonly detail?: string;
}

/** Situação da conta, como o CLI a reporta. Nunca inclui token. */
export interface AuthStatus {
  readonly authenticated: boolean;
  /** Identificação amigável: e-mail, organização ou apelido da conta. */
  readonly accountLabel?: string;
  readonly organization?: string;
  /** Plano ou tipo de assinatura, quando o CLI informa. */
  readonly plan?: string;
  /** Como a conta foi autenticada (assinatura, console, chave de API…). */
  readonly authMethod?: string;
  readonly message?: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
}

/**
 * Contrato de um provedor. Cada CLI tem comandos, diretórios e formatos
 * próprios: nada aqui pode presumir o comportamento do Claude Code.
 */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly displayName: string;
  /** Nome da variável que isola a configuração, exibido na interface. */
  readonly configEnvironmentVariable: string;

  detectInstallation(profile?: ProviderProfile): Promise<ProviderInstallation>;
  createIsolatedEnvironment(profile: ProviderProfile): Promise<void>;
  /** Abre o fluxo oficial de login do CLI. O Prometheon não pede senha. */
  login(profile: ProviderProfile): Promise<void>;
  logout(profile: ProviderProfile): Promise<void>;
  getAuthStatus(profile: ProviderProfile): Promise<AuthStatus>;
  listModels(profile: ProviderProfile): Promise<readonly ModelInfo[]>;
}

/** Perfil somado ao que sabemos sobre instalação e autenticação. */
export interface ProviderProfileStatus {
  readonly profile: ProviderProfile;
  readonly providerName: string;
  readonly installation: ProviderInstallation;
  readonly auth: AuthStatus;
}
