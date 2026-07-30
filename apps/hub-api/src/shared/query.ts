/**
 * Peças de consulta compartilhadas pelos repositórios.
 *
 * São as três coisas que todo módulo precisa e que nenhum ORM resolve sozinho:
 * paginação por keyset, busca textual com `LIKE` seguro e a leitura do número de
 * linhas que um `UPDATE` afetou — que aqui não é estatística, é a decisão do
 * banco sobre quem venceu uma corrida.
 */

import type { SelectQueryBuilder, UpdateResult, DeleteResult } from 'typeorm';

import type { CursorPayload } from './cursor.js';

/**
 * Linhas afetadas por um `UPDATE` ou `DELETE`.
 *
 * Vale reforçar o que este número significa nos repositórios: um `UPDATE`
 * condicional (`… WHERE version = ?`, `… WHERE claimed_by_user_id = ?`) que
 * afeta zero linhas não falhou — ele perdeu a corrida, ou a pré-condição deixou
 * de valer. Trocar isso por uma leitura seguida de escrita reabriria a janela
 * entre as duas.
 */
export function affectedRows(result: UpdateResult | DeleteResult): number {
  return result.affected ?? 0;
}

/** Escapa os curingas do `LIKE` para que a busca trate `%` e `_` como texto. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Aplica a condição de keyset descendente: `(created_at, id) < (cursor.at, cursor.id)`.
 *
 * O par completo é necessário porque `created_at` não é único; sem o desempate
 * por `id`, registros criados no mesmo milissegundo apareceriam duas vezes ou
 * sumiriam entre páginas.
 *
 * `alias` é o alias da tabela no query builder e `columns` são os **nomes das
 * propriedades da entidade** — o TypeORM traduz para as colunas físicas.
 */
export function applyKeyset<T extends object>(
  query: SelectQueryBuilder<T>,
  alias: string,
  columns: { createdAt: string; id: string },
  after: CursorPayload | undefined,
): SelectQueryBuilder<T> {
  if (after === undefined) {
    return query;
  }
  const at = new Date(after.at);
  return query.andWhere(
    `(${alias}.${columns.createdAt} < :keysetAt OR ` +
      `(${alias}.${columns.createdAt} = :keysetAt AND ${alias}.${columns.id} < :keysetId))`,
    { keysetAt: at, keysetId: after.id },
  );
}
