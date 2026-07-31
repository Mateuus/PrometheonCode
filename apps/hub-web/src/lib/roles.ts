import { can as decide, type Permission, type Role } from '@prometheon/permissions';
import type { MessageKey } from '@/i18n/catalog';
import type { Translate } from '@/i18n/dictionary';

/**
 * Papéis na interface.
 *
 * A tabela de permissões mora em `@prometheon/permissions` (`Docs/09`), e é de
 * lá que sai qualquer decisão de "mostrar ou não este botão".
 *
 * Vale lembrar o que essa checagem é e o que não é: ela evita oferecer um botão
 * que a API vai negar. A autorização de verdade acontece na Hub API, a cada
 * requisição — esconder um botão nunca protegeu nada.
 */
const ROLE_KEYS: Record<Role, MessageKey> = {
  owner: 'members.role.owner',
  admin: 'members.role.admin',
  maintainer: 'members.role.maintainer',
  developer: 'members.role.developer',
  reviewer: 'members.role.reviewer',
  viewer: 'members.role.viewer',
};

export function roleLabel(role: Role, t: Translate): string {
  return t(ROLE_KEYS[role]);
}

/**
 * O que o usuário pode nesta organização.
 *
 * `GET /v1/organizations/:id` devolve `permissions` — a lista que o **servidor**
 * aplicou para aquele papel. Quando ela está à mão, é ela que vale: é a única
 * que não pode divergir da decisão real. Sem ela, resta a tabela local, que é a
 * mesma fonte que a API usa.
 */
export interface ViewerAccess {
  role: Role;
  permissions?: readonly Permission[] | undefined;
}

export function viewerCan(access: ViewerAccess | Role, permission: Permission): boolean {
  if (typeof access === 'string') {
    return decide({ permission, role: access });
  }
  if (access.permissions) {
    return access.permissions.includes(permission);
  }
  return decide({ permission, role: access.role });
}
