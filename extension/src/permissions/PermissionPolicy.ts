import type { BypassGrant } from '../core/types';
import type {
  PermissionAction,
  PermissionContext,
  PermissionRequest,
  PermissionResult,
} from './types';

/** Ações que alteram o ambiente. Proibidas no modo Plan. */
const MUTATING: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  'file.write',
  'terminal.run',
  'git.write',
  'git.init',
]);

/** Ações sem efeito colateral: liberadas em qualquer modo. */
const SAFE: ReadonlySet<PermissionAction> = new Set<PermissionAction>(['file.read']);

/**
 * Ações que sempre exigem confirmação interativa, independentemente da
 * autonomia. `git.init` está aqui porque a spec exige confirmação explícita, e
 * `hub.network` porque bypass não deve autorizar tráfego de rede.
 */
const ALWAYS_ASK: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  'git.init',
  'hub.network',
]);

/** Ações consideradas de risco: no modo Auto elas pausam para aprovação. */
const RISKY: ReadonlySet<PermissionAction> = new Set<PermissionAction>([
  'terminal.run',
  'git.write',
]);

const WORKTREE_PREFIX = '.prometheon/worktrees/';

/** O escopo do bypass cobre esta ação/alvo? */
function bypassCovers(grant: BypassGrant, request: PermissionRequest): boolean {
  if (request.action === 'agent.delegate') {
    return true;
  }
  if (!MUTATING.has(request.action)) {
    return false;
  }
  switch (grant.scope) {
    case 'agent-worktrees': {
      // Sem alvo identificável não há como afirmar que a ação é dentro de um
      // worktree — o escopo mais restrito não pode assumir isso.
      const target = request.target?.replace(/\\/g, '/');
      return target !== undefined && target.includes(WORKTREE_PREFIX);
    }
    case 'current-project':
    case 'selected-workspace':
      return true;
  }
}

/**
 * Avalia uma permissão. Função pura, sem dependência do VS Code, para poder ser
 * testada isoladamente.
 *
 * Precedência, da mais forte para a mais fraca:
 *  1. `deny` da política do projeto;
 *  2. restrições do modo de trabalho;
 *  3. ações seguras;
 *  4. `ask` da política do projeto e ações que sempre perguntam;
 *  5. bypass ativo dentro do escopo;
 *  6. nível de autonomia.
 */
export function evaluatePermission(
  request: PermissionRequest,
  context: PermissionContext,
): PermissionResult {
  const { action } = request;

  if (context.projectPolicy.deny.includes(action)) {
    return {
      decision: 'deny',
      source: 'project-policy',
      reason: `A política do projeto proíbe "${action}".`,
    };
  }

  if (context.workMode === 'plan' && MUTATING.has(action)) {
    return {
      decision: 'deny',
      source: 'work-mode',
      reason: `O modo Plan não permite "${action}".`,
    };
  }

  if (action === 'agent.delegate' && context.workMode !== 'agent-team') {
    return {
      decision: 'deny',
      source: 'work-mode',
      reason: 'Delegar para workers exige o modo Agent Team.',
    };
  }

  if (SAFE.has(action)) {
    return { decision: 'allow', source: 'safe-action', reason: `"${action}" não tem efeito colateral.` };
  }

  if (context.projectPolicy.ask.includes(action)) {
    return {
      decision: 'ask',
      source: 'project-policy',
      reason: `A política do projeto exige confirmação para "${action}".`,
    };
  }

  if (ALWAYS_ASK.has(action)) {
    return {
      decision: 'ask',
      source: 'always-ask',
      reason: `"${action}" sempre exige confirmação explícita.`,
    };
  }

  if (context.bypass !== null && bypassCovers(context.bypass, request)) {
    return {
      decision: 'allow',
      source: 'bypass',
      reason: `Bypass ativo no escopo "${context.bypass.scope}".`,
    };
  }

  switch (context.autonomy) {
    case 'auto':
      return RISKY.has(action)
        ? { decision: 'ask', source: 'autonomy', reason: `Auto pausa em "${action}".` }
        : { decision: 'allow', source: 'autonomy', reason: `Auto libera "${action}".` };
    case 'bypass':
      // Autonomia em Bypass sem concessão válida (por exemplo depois de
      // reiniciar) volta a pedir aprovação.
      return {
        decision: 'ask',
        source: 'autonomy',
        reason: 'Bypass não está autorizado nesta sessão.',
      };
    case 'manual':
      return { decision: 'ask', source: 'autonomy', reason: 'Manual pede aprovação.' };
  }
}
