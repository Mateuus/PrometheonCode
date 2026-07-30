/**
 * Cursor de paginação.
 *
 * O `Docs/06` pede paginação por cursor, e o `Docs/03` fixa ULID como
 * identificador — que já ordena por tempo de criação. O cursor é, então, o par
 * `(createdAt, id)` codificado em base64url: opaco para o cliente, suficiente
 * para o `WHERE` seguir exatamente de onde parou, sem pular nem repetir item
 * quando algo é inserido no meio.
 */

import { badRequest } from './errors.js';

export interface CursorPayload {
  /** Instante do último item da página anterior, em milissegundos. */
  readonly at: number;
  /** ULID do último item, para desempatar registros do mesmo milissegundo. */
  readonly id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(`${payload.at}.${payload.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let decoded: string;

  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw badRequest('VALIDATION_FAILED', 'The pagination cursor is malformed.', {
      fields: [{ path: 'cursor', message: 'is not a valid cursor' }],
    });
  }

  const separator = decoded.indexOf('.');
  const at = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (separator === -1 || !Number.isSafeInteger(at) || id.length !== 26) {
    throw badRequest('VALIDATION_FAILED', 'The pagination cursor is malformed.', {
      fields: [{ path: 'cursor', message: 'is not a valid cursor' }],
    });
  }

  return { at, id };
}

export interface PageInfo {
  nextCursor: string | null;
  previousCursor: string | null;
  hasMore: boolean;
}

export interface CursorPage<T> {
  // `items` é mutável de propósito: é este objeto que vai direto para o
  // serializador da resposta, e um `readonly T[]` não satisfaz o schema Zod.
  items: T[];
  pageInfo: PageInfo;
}

/**
 * Monta a página a partir de `limit + 1` linhas lidas do banco.
 *
 * Ler um item a mais é o que responde `hasMore` sem um `COUNT(*)` — que, numa
 * tabela grande, custa muito mais que a própria página.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
  previousCursor: string | null = null,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);

  return {
    items,
    pageInfo: {
      nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
      previousCursor,
      hasMore,
    },
  };
}
