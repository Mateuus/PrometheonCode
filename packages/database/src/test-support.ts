// Apoio aos testes que precisam de MySQL de verdade.
//
// Nada aqui toca no banco de desenvolvimento: cada suíte cria um banco
// descartável com nome único, migra, usa e derruba no final. Se o MySQL não
// estiver acessível, `probeDatabase()` devolve o motivo e a suíte se declara
// pulada em vez de derrubar o pipeline inteiro.

import { createConnection, type Connection } from 'mysql2/promise';

import { createDatabase, type Database } from './client.js';
import { readDatabaseEnv } from './env.js';
import { newId } from './id.js';
import { runMigrations } from './migrate.js';

export interface ProbeResult {
  reachable: boolean;
  /** Motivo legível quando não dá para conectar. */
  reason?: string;
}

/** Abre uma conexão sem selecionar banco — só para saber se o servidor responde. */
async function connectToServer(): Promise<Connection> {
  const env = readDatabaseEnv();
  return createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    connectTimeout: 5000,
    multipleStatements: false,
  });
}

/** Verifica se dá para usar o MySQL configurado. Nunca lança. */
export async function probeDatabase(): Promise<ProbeResult> {
  let connection: Connection | undefined;
  try {
    connection = await connectToServer();
    await connection.query('SELECT 1');
    return { reachable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, reason: message };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

export interface DisposableDatabase {
  db: Database;
  name: string;
  /** Fecha o pool e apaga o banco. Seguro chamar mais de uma vez. */
  drop: () => Promise<void>;
}

/**
 * Cria um banco temporário já migrado. O nome carrega um sufixo ULID para que
 * execuções simultâneas não briguem pelo mesmo banco.
 */
export async function createDisposableDatabase(
  prefix = 'prometheon_test',
): Promise<DisposableDatabase> {
  const name = `${prefix}_${newId().slice(-12).toLowerCase()}`;
  const admin = await connectToServer();
  try {
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await admin.end();
  }

  await runMigrations({ database: name });
  const db = await createDatabase({ database: name, connectionLimit: 2 });

  let dropped = false;
  const drop = async (): Promise<void> => {
    if (dropped) {
      return;
    }
    dropped = true;
    await db.destroy();
    const cleanup = await connectToServer();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
    } finally {
      await cleanup.end();
    }
  };

  return { db, name, drop };
}
