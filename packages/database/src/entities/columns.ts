// Colunas comuns a praticamente todas as tabelas do Hub.
//
// Decisões que valem para o schema inteiro:
//
// - **IDs**: ULID em `char(26)`, gerados pela aplicação. Nada de auto-increment:
//   o ID precisa existir antes do INSERT (outbox, eventos correlacionados) e
//   não pode revelar volume de negócio.
// - **Datas**: `datetime(3)` sempre em UTC. `timestamp` do MySQL converte pelo
//   fuso da sessão e tem janela limitada até 2038; `datetime` guarda o valor
//   literal e o driver, configurado em `timezone: 'Z'`, lê e escreve em UTC.
// - **`version`**: contador de concorrência otimista exigido pelo `Docs/06`.
//   Quem escreve compara e incrementa. Não é a coluna `@VersionColumn` do
//   TypeORM de propósito: o incremento é feito por `UPDATE … SET version =
//   version + 1 WHERE version = ?`, para que a decisão seja do banco.
// - **`deleted_at`**: só onde recuperação é requisito real (usuários,
//   organizações, projetos, conversas, mensagens e itens de conhecimento).
//   Nas demais tabelas a exclusão é definitiva e passa por `deletion_jobs`.
//   Também não usa `@DeleteDateColumn`: o filtro é explícito nas consultas,
//   e um filtro invisível esconderia linhas de quem lê o SQL.
// - **Dinheiro**: inteiro na menor unidade (centavos), nunca ponto flutuante.
//
// Os helpers devolvem opções de coluna do `EntitySchema`, não decorators. Ver
// `entities/index.ts` para o porquê de `EntitySchema` em vez de classes.

import type { EntitySchemaColumnOptions } from 'typeorm';

/**
 * `bigint unsigned` lido como número.
 *
 * O MySQL devolve `BIGINT` como string quando o valor não cabe em um double; o
 * `supportBigNumbers`/`bigNumberStrings` do pool já pede número, e o
 * transformador fecha a garantia para o caso em que o driver devolve texto.
 * Todos os `bigint` do schema são contadores e tamanhos — nenhum chega perto de
 * 2^53, então a conversão nunca perde precisão.
 */
const bigintAsNumber = {
  from: (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value),
  to: (value: unknown): unknown => value,
};

/** Chave primária ULID. O valor é gerado pela aplicação (`newId()`). */
export function primaryId(): EntitySchemaColumnOptions {
  return { type: 'char', length: 26, primary: true, name: 'id' };
}

/** Referência a outro ULID (chave estrangeira ou ponteiro solto). */
export function ulidColumn(name: string): EntitySchemaColumnOptions {
  return { type: 'char', length: 26, name, nullable: true };
}

/** Referência a outro ULID, obrigatória. */
export function requiredUlidColumn(name: string): EntitySchemaColumnOptions {
  return { type: 'char', length: 26, name, nullable: false };
}

/** `organization_id` obrigatório: todo registro de cliente é multi-tenant. */
export function organizationId(): EntitySchemaColumnOptions {
  return { type: 'char', length: 26, name: 'organization_id', nullable: false };
}

/** Data de criação em UTC. */
export function createdAt(): EntitySchemaColumnOptions {
  return {
    type: 'datetime',
    precision: 3,
    name: 'created_at',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP(3)',
  };
}

/**
 * Data da última escrita em UTC.
 *
 * Quem atualiza é a aplicação, não o MySQL: `ON UPDATE CURRENT_TIMESTAMP` usa o
 * relógio e o fuso do servidor, e queremos o mesmo instante que a API registrou
 * no evento do outbox. Todo `UPDATE` seta a coluna explicitamente.
 */
export function updatedAt(): EntitySchemaColumnOptions {
  return {
    type: 'datetime',
    precision: 3,
    name: 'updated_at',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP(3)',
  };
}

/** Marca de exclusão lógica. Use apenas onde recuperação é requisito. */
export function deletedAt(): EntitySchemaColumnOptions {
  return { type: 'datetime', precision: 3, name: 'deleted_at', nullable: true };
}

/**
 * Autor do registro. Fica nulo quando a origem é o sistema.
 *
 * Sem chave estrangeira de propósito: a auditoria precisa sobreviver à exclusão
 * da conta, e uma FK `set null` em dezenas de tabelas apagaria justamente o
 * rastro que o `Docs/09` pede para preservar.
 */
export function createdBy(): EntitySchemaColumnOptions {
  return { type: 'char', length: 26, name: 'created_by', nullable: true };
}

/** Contador de concorrência otimista. */
export function version(): EntitySchemaColumnOptions {
  return { type: 'int', name: 'version', nullable: false, default: 1 };
}

/** Instante arbitrário em UTC, opcional. */
export function utcDatetime(name: string): EntitySchemaColumnOptions {
  return { type: 'datetime', precision: 3, name, nullable: true };
}

/** Instante arbitrário em UTC, obrigatório. */
export function requiredUtcDatetime(name: string): EntitySchemaColumnOptions {
  return { type: 'datetime', precision: 3, name, nullable: false };
}

/** `bigint unsigned` obrigatório, lido como número. */
export function unsignedBigint(
  name: string,
  options: { default?: number } = {},
): EntitySchemaColumnOptions {
  return {
    type: 'bigint',
    name,
    unsigned: true,
    nullable: false,
    transformer: bigintAsNumber,
    ...(options.default === undefined ? {} : { default: options.default }),
  };
}

/** `bigint unsigned` opcional, lido como número. */
export function nullableUnsignedBigint(name: string): EntitySchemaColumnOptions {
  return { type: 'bigint', name, unsigned: true, nullable: true, transformer: bigintAsNumber };
}

/** Coluna de enum do MySQL, obrigatória. */
export function enumColumn(
  name: string,
  values: readonly string[],
  options: { default?: string } = {},
): EntitySchemaColumnOptions {
  return {
    type: 'enum',
    name,
    enum: [...values],
    nullable: false,
    ...(options.default === undefined ? {} : { default: options.default }),
  };
}

/** `varchar` opcional. */
export function text(name: string, length: number): EntitySchemaColumnOptions {
  return { type: 'varchar', name, length, nullable: true };
}

/** `varchar` obrigatório, com valor padrão opcional. */
export function requiredText(
  name: string,
  length: number,
  options: { default?: string } = {},
): EntitySchemaColumnOptions {
  return {
    type: 'varchar',
    name,
    length,
    nullable: false,
    ...(options.default === undefined ? {} : { default: options.default }),
  };
}

/** Coluna `json`. O driver serializa e desserializa; o valor é objeto ou array. */
export function jsonColumn(name: string, options: { nullable?: boolean } = {}): EntitySchemaColumnOptions {
  return { type: 'json', name, nullable: options.nullable ?? true };
}

/** Par `created_at` + `updated_at` para espalhar na definição da entidade. */
export function timestamps(): { createdAt: EntitySchemaColumnOptions; updatedAt: EntitySchemaColumnOptions } {
  return { createdAt: createdAt(), updatedAt: updatedAt() };
}

/** Bloco completo de auditoria: datas, autor e versão. */
export function auditColumns(): {
  createdAt: EntitySchemaColumnOptions;
  updatedAt: EntitySchemaColumnOptions;
  createdBy: EntitySchemaColumnOptions;
  version: EntitySchemaColumnOptions;
} {
  return {
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: createdBy(),
    version: version(),
  };
}

/** Campos de auditoria como aparecem na interface da linha. */
export interface AuditFields {
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  version: number;
}

/** Apenas as duas datas, para tabelas sem autor nem versão. */
export interface TimestampFields {
  createdAt: Date;
  updatedAt: Date;
}
