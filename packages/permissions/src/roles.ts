/**
 * Papéis e permissões do Hub, conforme `Docs/09_AUTH_SECURITY_PERMISSIONS.md`.
 *
 * Este pacote é puro: não conhece banco, HTTP nem framework. Ele responde uma
 * pergunta e só uma — "esta ação é permitida neste contexto?" — para que a
 * mesma resposta valha na API, no worker e no Core local.
 */

export const ROLES = ['owner', 'admin', 'maintainer', 'developer', 'reviewer', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'organization.manage',
  'members.invite',
  'project.create',
  'project.configure',
  'chat.read',
  'chat.write',
  'task.create',
  'task.assign',
  'agent.observe',
  'agent.message',
  'agent.start_remote',
  'knowledge.propose',
  'knowledge.review',
  'knowledge.approve',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissões de cada papel.
 *
 * Escrito por extenso, sem herança entre papéis. Herança economiza linhas e
 * cobra caro depois: quando alguém acrescenta uma permissão ao papel de baixo,
 * ela sobe silenciosamente para todos os de cima. Aqui, conceder algo a alguém
 * exige dizer o nome de quem recebe.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: [...PERMISSIONS],
  admin: [
    'organization.manage',
    'members.invite',
    'project.create',
    'project.configure',
    'chat.read',
    'chat.write',
    'task.create',
    'task.assign',
    'agent.observe',
    'agent.message',
    'agent.start_remote',
    'knowledge.propose',
    'knowledge.review',
    'knowledge.approve',
    'audit.read',
  ],
  maintainer: [
    'project.create',
    'project.configure',
    'chat.read',
    'chat.write',
    'task.create',
    'task.assign',
    'agent.observe',
    'agent.message',
    'agent.start_remote',
    'knowledge.propose',
    'knowledge.review',
    'knowledge.approve',
  ],
  developer: [
    'chat.read',
    'chat.write',
    'task.create',
    'agent.observe',
    'agent.message',
    'agent.start_remote',
    'knowledge.propose',
  ],
  reviewer: [
    'chat.read',
    'chat.write',
    'agent.observe',
    'knowledge.propose',
    'knowledge.review',
    'knowledge.approve',
  ],
  viewer: ['chat.read', 'agent.observe'],
};

/** Ordem de senioridade, para comparações do tipo "pode alterar este membro?". */
const ROLE_RANK: Readonly<Record<Role, number>> = {
  owner: 5,
  admin: 4,
  maintainer: 3,
  developer: 2,
  reviewer: 1,
  viewer: 0,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * Um membro só administra quem está estritamente abaixo dele. Sem o "estrito",
 * dois admins poderiam se rebaixar mutuamente, e uma organização consegue ficar
 * sem ninguém capaz de administrá-la.
 */
export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}
