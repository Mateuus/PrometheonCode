import { permissionsOf, type Permission, type Role } from '@prometheon/permissions';
import type { MessageKey } from '@/i18n/catalog';
import type { Translate } from '@/i18n/dictionary';

/**
 * Papéis na interface.
 *
 * A tabela de permissões mora em `@prometheon/permissions` (`Docs/09`), e é de
 * lá que sai qualquer decisão de "mostrar ou não este botão". Aqui só existe o
 * texto de cada papel.
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

/** Atalho de leitura para a interface; a API continua sendo quem decide. */
export function viewerCan(role: Role, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}
