import type { Autonomy, BypassGrant, WorkMode } from '../core/types';

export type PermissionAction =
  | 'file.read'
  | 'file.write'
  | 'terminal.run'
  | 'git.write'
  | 'git.init'
  | 'agent.delegate'
  | 'hub.network';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** Qual regra produziu a decisão. Usado em diagnósticos e testes. */
export type PermissionSource =
  | 'project-policy'
  | 'work-mode'
  | 'safe-action'
  | 'always-ask'
  | 'bypass'
  | 'autonomy';

export interface ProjectPolicy {
  /** Ações proibidas no projeto. Vence qualquer autonomia, inclusive bypass. */
  readonly deny: readonly PermissionAction[];
  /** Ações que sempre exigem confirmação, mesmo com bypass ativo. */
  readonly ask: readonly PermissionAction[];
}

export const EMPTY_PROJECT_POLICY: ProjectPolicy = { deny: [], ask: [] };

export interface PermissionRequest {
  readonly action: PermissionAction;
  /** Caminho ou recurso alvo, quando aplicável. Usado para avaliar o escopo do bypass. */
  readonly target?: string;
}

export interface PermissionContext {
  readonly workMode: WorkMode;
  readonly autonomy: Autonomy;
  readonly bypass: BypassGrant | null;
  readonly projectPolicy: ProjectPolicy;
}

export interface PermissionResult {
  readonly decision: PermissionDecision;
  readonly source: PermissionSource;
  readonly reason: string;
}
