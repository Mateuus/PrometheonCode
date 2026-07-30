// Cliente do banco: pool mysql2 + Drizzle.
//
// Duas decisões que valem para todo consumidor:
//
// - `timezone: 'Z'` e `dateStrings: false`: o driver conversa em UTC. Somado a
//   `datetime(3)` nas colunas, nenhuma data depende do fuso do servidor.
// - `charset` utf8mb4 com collation moderna: acentuação e emoji sem surpresa.

import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { createPool, type Pool, type PoolOptions } from 'mysql2/promise';

import { readDatabaseEnv, type DatabaseEnv } from './env.js';
import * as schema from './schema/index.js';

export type Database = MySql2Database<typeof schema>;

/** Collation exigida pelo `Docs/07`: utf8mb4 com ordenação moderna. */
export const EXPECTED_CHARSET = 'utf8mb4';
export const EXPECTED_COLLATION = 'utf8mb4_0900_ai_ci';

export interface CreatePoolOptions extends Partial<DatabaseEnv> {
  /** Tamanho máximo do pool. */
  connectionLimit?: number;
  /** Permite várias instruções por chamada. Só o runner de migration usa. */
  multipleStatements?: boolean;
}

/** Monta o pool mysql2 já configurado para UTC e utf8mb4. */
export function createDatabasePool(options: CreatePoolOptions = {}): Pool {
  const { connectionLimit, multipleStatements, ...overrides } = options;
  const env = readDatabaseEnv(overrides);
  const poolOptions: PoolOptions = {
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
    charset: EXPECTED_COLLATION,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectionLimit: connectionLimit ?? 10,
    multipleStatements: multipleStatements ?? false,
    enableKeepAlive: true,
  };
  return createPool(poolOptions);
}

/** Cria a instância do Drizzle com o schema completo já tipado. */
export function createDatabase(options: CreatePoolOptions = {}): { db: Database; pool: Pool } {
  const pool = createDatabasePool(options);
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool };
}

/** Envolve o Drizzle em um pool existente (testes e ferramentas). */
export function databaseFromPool(pool: Pool): Database {
  return drizzle(pool, { schema, mode: 'default' });
}
