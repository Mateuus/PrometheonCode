/**
 * Papéis e permissões (`Docs/09`).
 *
 * O mapa de papel para permissões vive aqui porque é contrato público: o Hub
 * Web e a extensão desenham a interface a partir dele, e o servidor continua
 * sendo a autoridade que decide de fato.
 */

import { z } from 'zod';

export const ORGANIZATION_ROLES = [
  'owner',
  'admin',
  'maintainer',
  'developer',
  'reviewer',
  'viewer',
] as const;

export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);

export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

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

export const permissionSchema = z.enum(PERMISSIONS);

export type Permission = z.infer<typeof permissionSchema>;

const VIEWER: readonly Permission[] = ['chat.read', 'agent.observe'];

const REVIEWER: readonly Permission[] = [
  ...VIEWER,
  'knowledge.propose',
  'knowledge.review',
];

const DEVELOPER: readonly Permission[] = [
  ...VIEWER,
  'chat.write',
  'task.create',
  'agent.message',
  'knowledge.propose',
];

const MAINTAINER: readonly Permission[] = [
  ...new Set([
    ...DEVELOPER,
    ...REVIEWER,
    'project.create',
    'project.configure',
    'task.assign',
    'agent.start_remote',
    'knowledge.approve',
  ] as const),
];

const ADMIN: readonly Permission[] = [
  ...new Set([...MAINTAINER, 'members.invite', 'audit.read'] as const),
];

const OWNER: readonly Permission[] = [...PERMISSIONS];

/** Permissões concedidas por papel, do mais amplo ao mais restrito. */
export const ROLE_PERMISSIONS: Readonly<
  Record<OrganizationRole, readonly Permission[]>
> = Object.freeze({
  owner: Object.freeze(OWNER),
  admin: Object.freeze(ADMIN),
  maintainer: Object.freeze(MAINTAINER),
  developer: Object.freeze(DEVELOPER),
  reviewer: Object.freeze(REVIEWER),
  viewer: Object.freeze(VIEWER),
});

/** Ordem de precedência: índice menor significa papel mais poderoso. */
export const ROLE_RANK: Readonly<Record<OrganizationRole, number>> =
  Object.freeze(
    Object.fromEntries(
      ORGANIZATION_ROLES.map((role, index) => [role, index]),
    ) as Record<OrganizationRole, number>,
  );

/** Verificação auxiliar; a decisão final é sempre do servidor. */
export function roleHasPermission(
  role: OrganizationRole,
  permission: Permission,
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
