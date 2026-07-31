/**
 * Conversão de política gravada em JSON para a camada que `authorize()` espera.
 *
 * As colunas `organizations.policy` e `project_settings.policy` são JSON livre.
 * Só as chaves reconhecidas passam, e qualquer coisa fora do formato é
 * ignorada: política malformada não pode virar permissão concedida por acidente.
 */

import { isPermission, type Permission } from '@prometheon/permissions';

export interface PolicyLayer {
  readonly deny?: readonly Permission[];
  readonly allow?: readonly Permission[];
}

function permissionList(value: unknown): Permission[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is Permission => isPermission(item));
}

/** Devolve `undefined` quando não há política utilizável. */
export function toPolicyLayer(policy: unknown): PolicyLayer | undefined {
  if (policy === null || typeof policy !== 'object') {
    return undefined;
  }

  const record = policy as Record<string, unknown>;
  const deny = permissionList(record['deny']);
  const allow = permissionList(record['allow']);

  if (deny === undefined && allow === undefined) {
    return undefined;
  }

  return {
    ...(deny === undefined ? {} : { deny }),
    ...(allow === undefined ? {} : { allow }),
  };
}
