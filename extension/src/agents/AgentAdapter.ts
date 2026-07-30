import type {
  ActiveAgentStatus,
  Autonomy,
  SerializedError,
  WorkMode,
} from '../core/types';

export type AgentTransport = 'cli' | 'api' | 'mock';

export interface AgentCapabilities {
  readonly chat: boolean;
  readonly edit: boolean;
  /** Pode delegar trabalho a workers (necessário para o modo Agent Team). */
  readonly delegate: boolean;
  readonly terminal: boolean;
}

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly startedAt: number;
}

export interface StartAgentInput {
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  /** Caminho da pasta de trabalho, quando houver workspace aberto. */
  readonly workspaceFolder?: string;
  readonly role?: 'main' | 'worker';
  readonly task?: string;
}

export interface AgentInput {
  readonly content: string;
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
}

export type AgentEvent =
  | { readonly type: 'status'; readonly status: ActiveAgentStatus }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'completed'; readonly text: string }
  | { readonly type: 'failed'; readonly error: SerializedError }
  | { readonly type: 'cancelled' };

/**
 * Contrato de qualquer agente controlado pelo Prometheon. Adaptadores reais
 * (Claude Code, Codex CLI, Gemini CLI…) implementarão esta mesma interface.
 */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly transport: AgentTransport;
  readonly capabilities: AgentCapabilities;

  isAvailable(): Promise<boolean>;
  start(input: StartAgentInput): Promise<AgentSession>;
  send(sessionId: string, message: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
}
