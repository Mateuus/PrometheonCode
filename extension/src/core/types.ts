/** Tipos centrais compartilhados entre extensão e webview. */

import type { TokenUsage } from '../providers/UsageTracker';

export type WorkMode = 'plan' | 'edit' | 'agent-team';
export type Autonomy = 'manual' | 'auto' | 'bypass';
export type ChatType = 'local' | 'web';

export const WORK_MODES: readonly WorkMode[] = ['plan', 'edit', 'agent-team'];
export const AUTONOMY_LEVELS: readonly Autonomy[] = ['manual', 'auto', 'bypass'];
export const CHAT_TYPES: readonly ChatType[] = ['local', 'web'];

/** Rótulos da interface. A UI do produto é em inglês (ver Docs/PROMETHEON_INICIO_EXTENSAO.md). */
export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  plan: 'Plan',
  edit: 'Edit',
  'agent-team': 'Agent Team',
};

export const WORK_MODE_DESCRIPTIONS: Record<WorkMode, string> = {
  plan: 'Analysis and planning only.',
  edit: 'A single agent may edit inside the allowed scope.',
  'agent-team': 'The main agent may delegate work to workers.',
};

export const AUTONOMY_LABELS: Record<Autonomy, string> = {
  manual: 'Manual',
  auto: 'Auto',
  bypass: 'Bypass permissions',
};

export const AUTONOMY_DESCRIPTIONS: Record<Autonomy, string> = {
  manual: 'Ask for approval on relevant actions.',
  auto: 'Approve safe actions and pause on risky ones.',
  bypass: 'No interactive approval inside the authorized scope.',
};

export type BypassScope = 'agent-worktrees' | 'current-project' | 'selected-workspace';
export type BypassDuration = 'one-task' | 'current-session';

export const BYPASS_SCOPES: readonly BypassScope[] = [
  'agent-worktrees',
  'current-project',
  'selected-workspace',
];
export const BYPASS_DURATIONS: readonly BypassDuration[] = ['one-task', 'current-session'];

export const BYPASS_SCOPE_LABELS: Record<BypassScope, string> = {
  'agent-worktrees': 'Agent worktrees',
  'current-project': 'Current project',
  'selected-workspace': 'Selected workspace',
};

export const BYPASS_DURATION_LABELS: Record<BypassDuration, string> = {
  'one-task': 'One task',
  'current-session': 'Current session',
};

export const BYPASS_CONFIRMATION_MESSAGE =
  'Bypass permissions allows agents to execute actions without interactive approval inside the selected scope.';

/**
 * Autorização temporária de bypass. Vive somente em memória: reiniciar a
 * extensão ou trocar de workspace a descarta (nunca é persistida).
 */
export interface BypassGrant {
  readonly scope: BypassScope;
  readonly duration: BypassDuration;
  readonly grantedAt: number;
  /** Workspace em que o bypass foi concedido; trocar de workspace o cancela. */
  readonly workspaceKey: string | null;
}

export type ActiveAgentStatus =
  | 'idle'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AgentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly transport: 'cli' | 'api' | 'mock';
  readonly available: boolean;
}

export interface ActiveAgentSummary {
  readonly sessionId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly role: 'main' | 'worker';
  readonly status: ActiveAgentStatus;
  readonly task: string | null;
}

export type HubState = 'local-only' | 'disconnected' | 'connecting' | 'connected' | 'error';

export const HUB_STATE_LABELS: Record<HubState, string> = {
  'local-only': 'Local only',
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
};

export interface HubConnectionStatus {
  readonly state: HubState;
  /** Detalhe já sanitizado, seguro para exibir. */
  readonly detail?: string;
}

export interface WorkspaceStatus {
  /** Existe `.prometheon/prometheon.yaml` na pasta aberta. */
  readonly configured: boolean;
  readonly folderName: string | null;
  readonly hasGit: boolean;
  /** Pasta Prometheon externa escolhida pelo usuário, quando houver. */
  readonly externalFolder: string | null;
  /** Usuário optou por seguir sem workspace compartilhado nesta sessão. */
  readonly skipped: boolean;
}

/**
 * Conta de provedor como a interface a exibe. Só metadados: nada aqui vem do
 * conteúdo do diretório de credenciais.
 */
export interface AccountSummary {
  readonly profileId: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly configDirectory: string;
  readonly cliInstalled: boolean;
  readonly cliVersion?: string;
  readonly authenticated: boolean;
  readonly accountLabel?: string;
  readonly organization?: string;
  readonly plan?: string;
  readonly authMethod?: string;
  readonly message?: string;
  /** Tokens contados pelo Prometheon nesta máquina, não pelo provedor. */
  readonly usage: {
    readonly today: { readonly input: number; readonly output: number };
    readonly last7Days: { readonly input: number; readonly output: number };
    readonly total: { readonly input: number; readonly output: number };
    readonly runs: number;
    readonly lastRunAt: number | null;
  };
}

/** Situação do ditado, para a interface saber se e como oferecer o microfone. */
export interface SpeechStatus {
  /** Há motor de voz pronto. Sem isso o botão fica desabilitado, com o motivo. */
  readonly available: boolean;
  readonly state: 'idle' | 'listening' | 'transcribing';
  /** Texto já pronto para exibir, explicando por que o ditado está indisponível. */
  readonly detail?: string;
}

/**
 * O que o agente está fazendo agora, mostrado acima do composer enquanto o run
 * acontece. `label` é curto ("Thinking…"); `detail` diz qual perfil e conta
 * estão em uso — o documento exige que isso nunca fique escondido.
 */
export interface ActivityStatus {
  readonly phase: 'idle' | 'sending' | 'thinking' | 'working' | 'waiting';
  readonly label: string;
  readonly detail?: string;
  readonly startedAt: number | null;
  /**
   * Tokens contados até agora neste run. Some quando o run acaba: o número que
   * fica é o da mensagem, reportado pelo agente no fim.
   */
  readonly usage?: TokenUsage;
}

export interface UiNotification {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

// ---------- Agent Profiles ----------

/**
 * Papel de um agente (Docs/PROMETHEON_MULTI_PROVIDER_AGENT_PROFILES.md §6).
 * Não confundir com `ActiveAgentSummary.role`, que diz apenas quem lidera a
 * execução em andamento.
 */
export type AgentRole =
  | 'orchestrator'
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'researcher'
  | 'tester'
  | 'custom';

export const AGENT_ROLES: readonly AgentRole[] = [
  'orchestrator',
  'planner',
  'implementer',
  'reviewer',
  'researcher',
  'tester',
  'custom',
];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator',
  planner: 'Planner',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  tester: 'Tester',
  custom: 'Custom',
};

export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  orchestrator: 'Leads the work and delegates to the other agents.',
  planner: 'Breaks the task down before anything is edited.',
  implementer: 'Writes and changes code inside the allowed scope.',
  reviewer: 'Reads the diff and reports risks.',
  researcher: 'Explores the codebase and gathers context.',
  tester: 'Runs and writes tests for the change.',
  custom: 'A role you define through the system prompt.',
};

/**
 * Autonomia de um Agent Profile. É a lista do documento (§6) e não a do
 * seletor do composer: aqui `bypass` é sempre temporário, por perfil.
 */
export type AgentAutonomyMode = 'manual' | 'auto' | 'bypass-temporary';

export const AGENT_AUTONOMY_MODES: readonly AgentAutonomyMode[] = [
  'manual',
  'auto',
  'bypass-temporary',
];

export const AGENT_AUTONOMY_MODE_LABELS: Record<AgentAutonomyMode, string> = {
  manual: 'Manual',
  auto: 'Auto',
  'bypass-temporary': 'Bypass (temporary)',
};

export const AGENT_AUTONOMY_MODE_DESCRIPTIONS: Record<AgentAutonomyMode, string> = {
  manual: 'Ask for approval on relevant actions.',
  auto: 'Approve safe actions and pause on risky ones.',
  'bypass-temporary': 'No interactive approval; never persisted across restarts.',
};

export type ContextStrategy = 'isolated' | 'project' | 'team';

export const CONTEXT_STRATEGIES: readonly ContextStrategy[] = ['isolated', 'project', 'team'];

export const CONTEXT_STRATEGY_LABELS: Record<ContextStrategy, string> = {
  isolated: 'Isolated',
  project: 'Project',
  team: 'Team',
};

export const CONTEXT_STRATEGY_DESCRIPTIONS: Record<ContextStrategy, string> = {
  isolated: 'Only the task and the files handed to the agent.',
  project: 'Repository context and the Prometheon Brain.',
  team: 'Authorized Hub context and shared knowledge.',
};

/** Limites da fronteira com a webview, usados na validação e na interface. */
export const MAX_PROFILE_NAME_LENGTH = 60;
export const MAX_MODEL_LENGTH = 120;
export const MAX_SYSTEM_PROMPT_LENGTH = 8_000;
export const MAX_TOOLS_PER_LIST = 40;
export const MAX_TOOL_NAME_LENGTH = 80;
export const MAX_CONCURRENT_SESSIONS = 16;

/**
 * Agente configurado no Prometheon. É configuração compartilhável: nada aqui
 * é credencial — a conta usada vem do `providerProfileId`, que aponta para um
 * Provider Profile local.
 */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  /** Binding obrigatório: um agente sem conta não executa (documento §15). */
  readonly providerProfileId: string;
  readonly role: AgentRole;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly autonomyMode: AgentAutonomyMode;
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly maxConcurrentSessions: number;
  readonly contextStrategy: ContextStrategy;
  readonly enabled: boolean;
}

/**
 * Agent Profile com o binding já resolvido para a interface mostrar
 * `Agent → Provider → Account` sem precisar cruzar listas.
 */
export interface AgentProfileSummary {
  readonly profile: AgentProfile;
  readonly providerName: string | null;
  readonly accountName: string | null;
  readonly accountAuthenticated: boolean;
  /** Texto pronto quando o binding quebrou ou a conta não está autenticada. */
  readonly warning?: string;
}

/** Provedor disponível para criar uma conta, como a interface o lista. */
export interface ProviderOption {
  readonly id: string;
  readonly name: string;
  /** Variável que isola a configuração, exibida ao criar a conta. */
  readonly configEnvironmentVariable: string;
}

// ---------- MCP ----------

export const MAX_MCP_NAME_LENGTH = 60;
export const MAX_MCP_COMMAND_LENGTH = 260;
export const MAX_MCP_ARGS = 32;
export const MAX_MCP_ARG_LENGTH = 400;
export const MAX_MCP_URL_LENGTH = 400;
export const MAX_MCP_ENTRIES = 24;
export const MAX_MCP_KEY_LENGTH = 80;
export const MAX_MCP_VALUE_LENGTH = 400;
export const MAX_MCP_SERVERS = 40;

/**
 * Transporte de um servidor MCP. `type` ausente no arquivo significa `stdio`,
 * que é o padrão do formato.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio (local process)',
  http: 'http',
  sse: 'sse',
};

export const MCP_TRANSPORT_DESCRIPTIONS: Record<McpTransport, string> = {
  stdio: 'Prometheon starts a local command and talks to it over stdio.',
  http: 'Connects to an MCP server over HTTP.',
  sse: 'Connects to an MCP server over server-sent events.',
};

/** Par chave/valor de `env` ou `headers`, na ordem em que aparece no arquivo. */
export interface McpKeyValue {
  readonly key: string;
  readonly value: string;
}

/**
 * Servidor MCP como a interface o edita. É a leitura do `.mcp.json` do
 * workspace, que pertence ao projeto e é lido também por outras ferramentas —
 * por isso os campos que não conhecemos são preservados na regravação e apenas
 * contados aqui.
 */
export interface McpServerSummary {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: readonly McpKeyValue[];
  readonly url?: string;
  readonly headers: readonly McpKeyValue[];
  /** `disabled: true` no arquivo desliga o servidor sem apagar a configuração. */
  readonly enabled: boolean;
  /** Quantidade de campos desconhecidos preservados nesta entrada. */
  readonly preservedFields: readonly string[];
  /** Avisos prontos para exibir: valor com cara de credencial em texto puro. */
  readonly warnings: readonly string[];
}

/** O que a interface envia para criar ou editar um servidor MCP. */
export interface McpServerDraft {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: readonly McpKeyValue[];
  readonly url?: string;
  readonly headers: readonly McpKeyValue[];
  readonly enabled: boolean;
}

/** Entrada que não pôde ser interpretada. Reportada, nunca corrigida sozinha. */
export interface McpProblem {
  readonly name: string;
  readonly detail: string;
}

export interface McpStatus {
  /** Há uma pasta aberta; sem isso não existe `.mcp.json` de projeto. */
  readonly available: boolean;
  /** O arquivo já existe em disco. */
  readonly exists: boolean;
  /** Caminho do arquivo, para a interface mostrar onde isso mora. */
  readonly file: string | null;
  readonly servers: readonly McpServerSummary[];
  readonly problems: readonly McpProblem[];
  /** Motivo já pronto para exibir quando `available` é falso. */
  readonly message?: string;
}
