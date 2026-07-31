import { permissionsOf, type Permission, type Role } from './roles.js';

/**
 * Precedência de autorização, na ordem do `Docs/09`:
 *
 * ```text
 * política da organização
 * → política do projeto
 * → permissão do usuário
 * → modo do chat
 * → permissão do agente
 * ```
 *
 * A regra que sustenta tudo: **uma camada inferior nunca libera o que uma
 * superior nega**. Por isso a decisão percorre as camadas de cima para baixo e
 * para na primeira negação — nenhuma camada seguinte tem como reverter.
 */

/** Modo do chat, espelhando o modo de trabalho da extensão. */
export type ChatMode = 'plan' | 'edit' | 'agent-team';

export interface PolicyLayer {
  /** Nega explicitamente; vence qualquer concessão abaixo. */
  readonly deny?: readonly Permission[];
  /** Restringe o conjunto ao que está listado, quando presente. */
  readonly allow?: readonly Permission[];
}

export interface AuthorizationContext {
  readonly permission: Permission;
  /** Papel do usuário na organização. Ausente significa não-membro. */
  readonly role?: Role;
  readonly organizationPolicy?: PolicyLayer;
  readonly projectPolicy?: PolicyLayer;
  /** Concessões extras a este usuário, dentro do que as camadas acima permitem. */
  readonly userGrants?: readonly Permission[];
  readonly chatMode?: ChatMode;
  /** Ferramentas/ações que o Agent Profile pode usar, quando quem age é um agente. */
  readonly agentAllows?: readonly Permission[];
}

export type DecisionLayer =
  | 'membership'
  | 'organization'
  | 'project'
  | 'user'
  | 'chat-mode'
  | 'agent';

export interface Decision {
  readonly allowed: boolean;
  /** Camada que decidiu. Vai para a auditoria e para a mensagem de erro. */
  readonly layer: DecisionLayer;
  /** Motivo já pronto para leitura humana. */
  readonly reason: string;
}

/** Permissões que mudam o estado do trabalho, e que o modo `plan` não concede. */
const MUTATING: readonly Permission[] = [
  'organization.manage',
  'members.invite',
  'project.create',
  'project.configure',
  'task.create',
  'task.assign',
  'agent.message',
  'agent.start_remote',
  'knowledge.approve',
];

function denies(layer: PolicyLayer | undefined, permission: Permission): boolean {
  return layer?.deny?.includes(permission) === true;
}

function restricts(layer: PolicyLayer | undefined, permission: Permission): boolean {
  return layer?.allow !== undefined && !layer.allow.includes(permission);
}

export function authorize(context: AuthorizationContext): Decision {
  const { permission } = context;

  // Camada 1 — organização. Uma negação aqui encerra a decisão.
  if (denies(context.organizationPolicy, permission)) {
    return {
      allowed: false,
      layer: 'organization',
      reason: `The organization policy denies ${permission}.`,
    };
  }
  if (restricts(context.organizationPolicy, permission)) {
    return {
      allowed: false,
      layer: 'organization',
      reason: `The organization policy does not include ${permission}.`,
    };
  }

  // Camada 2 — projeto.
  if (denies(context.projectPolicy, permission)) {
    return {
      allowed: false,
      layer: 'project',
      reason: `The project policy denies ${permission}.`,
    };
  }
  if (restricts(context.projectPolicy, permission)) {
    return {
      allowed: false,
      layer: 'project',
      reason: `The project policy does not include ${permission}.`,
    };
  }

  // Camada 3 — o usuário. Sem papel não há acesso: não-membro não herda nada.
  if (context.role === undefined) {
    return {
      allowed: false,
      layer: 'membership',
      reason: 'You are not a member of this organization.',
    };
  }
  const granted =
    permissionsOf(context.role).includes(permission) ||
    context.userGrants?.includes(permission) === true;
  if (!granted) {
    return {
      allowed: false,
      layer: 'user',
      reason: `The role "${context.role}" does not include ${permission}.`,
    };
  }

  // Camada 4 — modo do chat. `plan` analisa e propõe, não muda o mundo.
  if (context.chatMode === 'plan' && MUTATING.includes(permission)) {
    return {
      allowed: false,
      layer: 'chat-mode',
      reason: `Plan mode does not allow ${permission}.`,
    };
  }

  // Camada 5 — o agente, quando é ele quem age.
  if (context.agentAllows !== undefined && !context.agentAllows.includes(permission)) {
    return {
      allowed: false,
      layer: 'agent',
      reason: `This agent profile is not allowed to ${permission}.`,
    };
  }

  return { allowed: true, layer: 'agent', reason: 'Allowed.' };
}

/** Atalho para quem só precisa do sim ou não. */
export function can(context: AuthorizationContext): boolean {
  return authorize(context).allowed;
}
