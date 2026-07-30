// Colunas comuns a praticamente todas as tabelas do Hub.
//
// Decisões que valem para o schema inteiro:
//
// - **IDs**: ULID em `char(26)`, gerados pela aplicação. Nada de auto-increment:
//   o ID precisa existir antes do INSERT (outbox, eventos correlacionados) e
//   não pode revelar volume de negócio.
// - **Datas**: `datetime(3)` sempre em UTC. `timestamp` do MySQL converte pelo
//   fuso da sessão e tem janela limitada até 2038; `datetime` guarda o valor
//   literal e o driver do Drizzle serializa/desserializa em UTC.
// - **`version`**: contador de concorrência otimista exigido pelo `Docs/06`.
//   Quem escreve compara e incrementa.
// - **`deleted_at`**: só onde recuperação é requisito real (usuários,
//   organizações, projetos, conversas, mensagens e itens de conhecimento).
//   Nas demais tabelas a exclusão é definitiva e passa por `deletion_jobs`.
// - **Dinheiro**: inteiro na menor unidade (centavos), nunca ponto flutuante.

import { sql } from 'drizzle-orm';
import { char, datetime, int } from 'drizzle-orm/mysql-core';

import { newId } from '../id.js';

/** Chave primária ULID com geração automática do lado da aplicação. */
export function primaryId() {
  return char('id', { length: 26 })
    .primaryKey()
    .$defaultFn(() => newId());
}

/** Referência a outro ULID (chave estrangeira ou ponteiro solto). */
export function ulidColumn(name: string) {
  return char(name, { length: 26 });
}

/** `organization_id` obrigatório: todo registro de cliente é multi-tenant. */
export function organizationId() {
  return char('organization_id', { length: 26 }).notNull();
}

/** Data de criação em UTC. */
export function createdAt() {
  return datetime('created_at', { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);
}

/**
 * Data da última escrita em UTC.
 *
 * Quem atualiza é a aplicação (`$onUpdate` do Drizzle), não o MySQL: `ON UPDATE
 * CURRENT_TIMESTAMP` usa o relógio e o fuso do servidor, e queremos o mesmo
 * instante que a API registrou no evento do outbox. UPDATE feito em SQL cru
 * precisa setar a coluna explicitamente.
 */
export function updatedAt() {
  return datetime('updated_at', { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date());
}

/** Marca de exclusão lógica. Use apenas onde recuperação é requisito. */
export function deletedAt() {
  return datetime('deleted_at', { fsp: 3 });
}

/**
 * Autor do registro. Fica nulo quando a origem é o sistema.
 *
 * Sem chave estrangeira de propósito: a auditoria precisa sobreviver à exclusão
 * da conta, e uma FK `set null` em dezenas de tabelas apagaria justamente o
 * rastro que o `Docs/09` pede para preservar.
 */
export function createdBy() {
  return char('created_by', { length: 26 });
}

/** Contador de concorrência otimista. */
export function version() {
  return int('version').notNull().default(1);
}

/** Instante arbitrário em UTC. */
export function utcDatetime(name: string) {
  return datetime(name, { fsp: 3 });
}

/** Par `created_at` + `updated_at` para espalhar na definição da tabela. */
export function timestamps() {
  return { createdAt: createdAt(), updatedAt: updatedAt() };
}

/** Bloco completo de auditoria: datas, autor e versão. */
export function auditColumns() {
  return { createdAt: createdAt(), updatedAt: updatedAt(), createdBy: createdBy(), version: version() };
}
