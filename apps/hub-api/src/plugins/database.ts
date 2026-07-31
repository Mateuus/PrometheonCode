/**
 * Conexão com o MySQL.
 *
 * O `DataSource` do TypeORM vem pronto de `@prometheon/database` — já em UTC e
 * utf8mb4, com `synchronize` desligado. A API só passa as credenciais de
 * `@prometheon/config` e mantém o ciclo de vida amarrado ao do servidor.
 */

import { closeDatabase, createDatabase, type Database } from '@prometheon/database';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/index.js';

export function createDatabaseHandles(
  config: AppConfig,
  overrides: { database?: string; connectionLimit?: number } = {},
): Promise<Database> {
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
  /** Conexão pronta, usada pelos testes contra banco descartável. */
  readonly db?: Database | undefined;
  /** Quando a conexão vem de fora, quem a criou também a fecha. */
  readonly owned?: boolean;
}

export async function registerDatabase(
  app: FastifyInstance,
  options: RegisterDatabaseOptions = {},
): Promise<void> {
  const db = options.db ?? (await createDatabaseHandles(app.appConfig));
  const owned = options.owned ?? options.db === undefined;

  // Uma consulta trivial no boot: credencial errada ou banco inexistente vira
  // erro de inicialização, não erro na primeira requisição do usuário. O
  // `initialize()` já abre uma conexão, mas isto também prova que dá para
  // consultar, não só conectar.
  await db.query('SELECT 1');

  app.decorate('db', db);

  if (owned) {
    app.addHook('onClose', async () => {
      await closeDatabase(db);
    });
  }
}
