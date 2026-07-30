// Cliente do banco: `DataSource` do TypeORM sobre o driver mysql2.
//
// Decisões que valem para todo consumidor:
//
// - **`synchronize` é sempre `false`.** O banco já existe, migrado e em uso.
//   `synchronize: true` compara as entidades com o schema e emite o DDL que
//   achar necessário, sem revisão e sem migration — é o caminho mais curto para
//   perder dados. O único jeito de mudar o schema é escrever uma migration em
//   `src/migrations/`.
// - **`timezone: 'Z'` e `dateStrings: false`**: o driver conversa em UTC. Somado
//   a `datetime(3)` nas colunas, nenhuma data depende do fuso do servidor.
// - **`charset` utf8mb4 com collation moderna**: acentuação e emoji sem surpresa.
// - **`bigNumberStrings: false`**: o padrão do TypeORM é devolver `BIGINT` como
//   string. Aqui todos os `bigint` são contadores bem abaixo de 2^53 e o código
//   os trata como número; o transformador das colunas fecha a garantia.

import { DataSource, type DataSourceOptions, type EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';

import { ENTITIES } from './entities/index.js';
import { readDatabaseEnv, type DatabaseEnv } from './env.js';
import { MIGRATIONS } from './migrations/index.js';

/** Ponto de entrada de tudo que fala com o banco. */
export type Database = DataSource;

/**
 * Executor: o gerenciador global do `DataSource` ou o de uma transação aberta.
 *
 * Consultas que não precisam de transação recebem este tipo; quem exige
 * transação pede `TransactionExecutor`.
 */
export type Executor = EntityManager;

declare const transactional: unique symbol;

/**
 * Gerenciador garantidamente dentro de uma transação.
 *
 * A marca é um símbolo privado deste módulo: não há como produzir um valor deste
 * tipo fora de `runInTransaction()`. É isso que faz a assinatura de
 * `enqueueOutboxMessage()` — e das funções de evento da API — recusar o
 * gerenciador global em tempo de compilação, que é como o projeto torna difícil
 * gravar mudança sem o evento correspondente.
 */
export interface TransactionExecutor extends EntityManager {
  readonly [transactional]: true;
}

/** Collation exigida pelo `Docs/07`: utf8mb4 com ordenação moderna. */
export const EXPECTED_CHARSET = 'utf8mb4';
export const EXPECTED_COLLATION = 'utf8mb4_0900_ai_ci';

/** Tabela onde o TypeORM registra as migrations aplicadas. */
export const MIGRATIONS_TABLE = 'typeorm_migrations';

export interface CreateDatabaseOptions extends Partial<DatabaseEnv> {
  /** Tamanho máximo do pool. */
  connectionLimit?: number;
  /** Permite várias instruções por chamada. Só o runner de migration usa. */
  multipleStatements?: boolean;
  /** Registra o SQL emitido. Útil em investigação, nunca em produção. */
  logging?: boolean;
}

interface TypeCastField {
  type: string;
  length: number;
  string: () => string | null;
}

/**
 * Converte `tinyint(1)` em booleano já no driver.
 *
 * O TypeORM converte ao hidratar uma entidade, mas consultas que devolvem linhas
 * cruas (`getRawMany`, `manager.query`) entregam o que o driver deu — e o mysql2
 * entrega `0`/`1`. Normalizar aqui evita que o mesmo campo tenha dois formatos
 * conforme a forma da consulta.
 */
function typeCast(field: TypeCastField, next: () => unknown): unknown {
  if (field.type === 'TINY' && field.length === 1) {
    const raw = field.string();
    return raw === null ? null : raw !== '0';
  }
  return next();
}

/** Monta as opções do `DataSource` a partir do ambiente e dos overrides. */
export function createDataSourceOptions(options: CreateDatabaseOptions = {}): DataSourceOptions {
  const { connectionLimit, multipleStatements, logging, ...overrides } = options;
  const env = readDatabaseEnv(overrides);

  return {
    type: 'mysql',
    host: env.host,
    port: env.port,
    username: env.user,
    password: env.password,
    database: env.database,
    charset: EXPECTED_COLLATION,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    poolSize: connectionLimit ?? 10,
    multipleStatements: multipleStatements ?? false,
    // Nunca `true`. Ver o cabeçalho deste arquivo.
    synchronize: false,
    // As migrations são aplicadas pelo runner (`migrate.ts`), com verificação de
    // charset e relatório do que rodou — não na subida da aplicação.
    migrationsRun: false,
    entities: [...ENTITIES],
    migrations: [...MIGRATIONS],
    migrationsTableName: MIGRATIONS_TABLE,
    logging: logging ?? false,
    extra: {
      enableKeepAlive: true,
      typeCast,
    },
  };
}

/**
 * Cria o `DataSource` já conectado.
 *
 * Assíncrono porque o TypeORM abre a primeira conexão no `initialize()` — é lá
 * que credencial errada ou banco inexistente falha, e falhar cedo é melhor que
 * falhar na primeira consulta.
 */
export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<Database> {
  const dataSource = new DataSource(createDataSourceOptions(options));
  await dataSource.initialize();
  return dataSource;
}

/**
 * Abre uma transação e entrega o executor marcado.
 *
 * Todo trabalho de domínio que grava evento no outbox passa por aqui: é a única
 * fonte de `TransactionExecutor`. O TypeORM faz commit ao final do callback e
 * rollback em qualquer exceção.
 */
export async function runInTransaction<T>(
  db: Database,
  work: (tx: TransactionExecutor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (manager) => work(manager as TransactionExecutor));
}

/**
 * Converte uma linha já tipada nos valores de escrita do TypeORM.
 *
 * `QueryDeepPartialEntity` trata cada propriedade como "valor ou expressão SQL"
 * e, por causa disso, não sabe representar uma coluna JSON de conteúdo livre: um
 * `Record<string, unknown>` não é atribuível a ele. Como o objeto já foi
 * verificado contra a interface da entidade antes de chegar aqui — é o que o
 * parâmetro `Partial<T>` exige —, a conversão não esconde campo errado nem tipo
 * errado; ela só desfaz uma limitação do tipo do ORM.
 */
export function writable<T>(row: Partial<T>): QueryDeepPartialEntity<T> {
  return row as QueryDeepPartialEntity<T>;
}

/** Fecha o pool. Seguro chamar mais de uma vez. */
export async function closeDatabase(db: Database): Promise<void> {
  if (db.isInitialized) {
    await db.destroy();
  }
}
