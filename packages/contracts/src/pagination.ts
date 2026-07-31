/**
 * Paginação por cursor.
 *
 * Offset é proibido: as listagens do Hub crescem e são ordenadas por tempo, e
 * `LIMIT ... OFFSET` pula ou repete item quando algo é inserido no meio.
 */

import { z } from 'zod';

import { cursorSchema } from './primitives.js';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const sortDirectionSchema = z.enum(['asc', 'desc']);

export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * Entrada da paginação. Vem da query string, então `limit` é convertido de
 * texto.
 */
export const cursorPageQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  direction: sortDirectionSchema.default('desc'),
});

export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

export const pageInfoSchema = z.object({
  /** Cursor da próxima página, ou `null` quando acabou. */
  nextCursor: cursorSchema.nullable(),
  /** Cursor da página anterior, ou `null` na primeira. */
  previousCursor: cursorSchema.nullable(),
  hasMore: z.boolean(),
});

export type PageInfo = z.infer<typeof pageInfoSchema>;

/** Envolve o schema de item numa página com cursor. */
export function cursorPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    pageInfo: pageInfoSchema,
  });
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly pageInfo: PageInfo;
}
