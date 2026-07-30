/** Tipos centrais compartilhados entre extensão e webview. */

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

export interface UiNotification {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}
