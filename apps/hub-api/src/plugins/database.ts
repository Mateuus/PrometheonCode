/**
 * Conexão com o MySQL.
 *
 * O pool e o Drizzle vêm prontos de `@prometheon/database` — já em UTC e
 * utf8mb4. A API só passa as credenciais de `@prometheon/config` e mantém o
 * ciclo de vida amarrado ao do servidor.
 */

import { createDatabase, type Database } from '@prometheon/database';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';

import type { AppConfig } from '../config/index.js';

export interface DatabaseHandles {
  readonly db: Database;
  readonly pool: Pool;
}

export function createDatabaseHandles(
  config: AppConfig,
  overrides: { database?: string; connectionLimit?: number } = {},
): DatabaseHandles {
  return createDatabase({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: overrides.database ?? config.database.name,
    ...(overrides.connectionLimit === undefined
      ? {}
      : { connectionLimit: overrides.connectionLimit }),
  });
}

export interface RegisterDatabaseOptions {
  /** Handles prontos, usados pelos testes contra banco descartável. */
  readonly handles?: DatabaseHandles | undefined;
  /** Quando os handles vêm de fora, quem os criou também os fecha. */
  readonly owned?: boolean;
}

export async function registerDatabase(
  app: FastifyInstance,
  options: RegisterDatabaseOptions = {},
): Promise<void> {
  const handles = options.handles ?? createDatabaseHandles(app.appConfig);
  const owned = options.owned ?? options.handles === undefined;

  // Uma consulta trivial no boot: credencial errada ou banco inexistente vira
  // erro de inicialização, não erro na primeira requisição do usuário.
  await handles.pool.query('SELECT 1');

  app.decorate('db', handles.db);
  app.decorate('pool', handles.pool);

  if (owned) {
    app.addHook('onClose', async () => {
      await handles.pool.end();
    });
  }
}
