import { randomUUID } from 'node:crypto';

/** Identificador único. Usa crypto.randomUUID quando disponível. */
export function newId(prefix?: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : randomUUID();
  return prefix === undefined ? uuid : `${prefix}_${uuid}`;
}
