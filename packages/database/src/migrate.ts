// Runner de migrations.
//
// Aplica o SQL versionado de `drizzle/`. É idempotente: o Drizzle registra em
// `__drizzle_migrations` o que já rodou, e rodar de novo não repete nada. O
// runner acrescenta três coisas ao comportamento padrão:
//
// 1. verifica charset e collation do banco antes de escrever;
// 2. informa exatamente quais migrations foram aplicadas nesta execução;
// 3. traduz falha de conexão e de permissão em mensagem acionável.
//
// Uso: `pnpm --filter @prometheon/database db:migrate`
//      `DATABASE_NAME=outro_banco pnpm --filter @prometheon/database db:migrate`

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { migrate } from 'drizzle-orm/mysql2/migrator';
import type { Pool, RowDataPacket } from 'mysql2/promise';

import { createDatabase, EXPECTED_CHARSET } from './client.js';
import type { CreatePoolOptions } from './client.js';

/** Pasta com o SQL versionado. Vale tanto rodando de `src/` quanto de `dist/`. */
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '..', 'drizzle');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Journal {
  entries?: JournalEntry[];
}

export interface MigrationResult {
  /** Nome das migrations aplicadas nesta execução. */
  applied: string[];
  /** Quantas já estavam registradas antes de começar. */
  alreadyApplied: number;
  database: string;
}

/** Lê o journal para traduzir o carimbo gravado no banco em nome de arquivo. */
function readJournal(folder: string): JournalEntry[] {
  try {
    const raw = readFileSync(join(folder, 'meta', '_journal.json'), 'utf8');
    return (JSON.parse(raw) as Journal).entries ?? [];
  } catch {
    return [];
  }
}

/** Carimbos já registrados em `__drizzle_migrations`, se a tabela existir. */
async function readAppliedStamps(pool: Pool): Promise<number[]> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT created_at FROM `__drizzle_migrations`',
    );
    return rows.map((row) => Number(row['created_at']));
  } catch (error) {
    // Tabela ainda não existe: banco limpo, nenhuma migration aplicada.
    if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') {
      return [];
    }
    throw error;
  }
}

/** Falha cedo se o banco não estiver em utf8mb4 — acento e emoji quebrariam. */
async function assertCharset(pool: Pool, database: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT @@character_set_database AS charset, @@collation_database AS collation',
  );
  const charset = String(rows[0]?.['charset'] ?? '');
  const collation = String(rows[0]?.['collation'] ?? '');
  if (charset !== EXPECTED_CHARSET) {
    throw new Error(
      `O banco \`${database}\` está em ${charset || 'charset desconhecido'} e o schema exige ` +
        `${EXPECTED_CHARSET}. Recrie com: CREATE DATABASE \`${database}\` ` +
        'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
    );
  }
  if (!collation.startsWith('utf8mb4_0900')) {
    console.warn(
      `aviso: collation do banco é ${collation}. O projeto padroniza ` +
        'utf8mb4_0900_ai_ci; comparações de texto podem divergir entre ambientes.',
    );
  }
}

/** Traduz o erro do driver em algo que dê para agir. */
function describeConnectionError(error: unknown, database: string): string {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
      return (
        `Não foi possível falar com o MySQL (${code}). Confira DATABASE_HOST e ` +
        'DATABASE_PORT no `.env` e rode `node scripts/check-hub-services.mjs`.'
      );
    case 'ER_ACCESS_DENIED_ERROR':
      return 'Credenciais recusadas pelo MySQL. Revise DATABASE_USER e DATABASE_PASSWORD no `.env`.';
    case 'ER_BAD_DB_ERROR':
      return (
        `O banco \`${database}\` não existe. Crie com: CREATE DATABASE \`${database}\` ` +
        'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;'
      );
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
      return `O usuário não tem permissão de DDL em \`${database}\`. Conceda CREATE/ALTER/DROP.`;
    default:
      return message;
  }
}

/** Aplica as migrations pendentes e devolve o que mudou. */
export async function runMigrations(options: CreatePoolOptions = {}): Promise<MigrationResult> {
  const { db, pool } = createDatabase({ ...options, connectionLimit: 1 });
  const database = (pool.pool.config as { connectionConfig?: { database?: string } }).connectionConfig
    ?.database;
  const databaseName = options.database ?? database ?? '(desconhecido)';

  try {
    await assertCharset(pool, databaseName);
    const before = await readAppliedStamps(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await readAppliedStamps(pool);

    const journal = readJournal(MIGRATIONS_FOLDER);
    const beforeSet = new Set(before);
    const applied = after
      .filter((stamp) => !beforeSet.has(stamp))
      .sort((left, right) => left - right)
      .map((stamp) => journal.find((entry) => entry.when === stamp)?.tag ?? `carimbo ${stamp}`);

    return { applied, alreadyApplied: before.length, database: databaseName };
  } catch (error) {
    throw new Error(`Falha ao migrar \`${databaseName}\`: ${describeConnectionError(error, databaseName)}`, {
      cause: error,
    });
  } finally {
    await pool.end();
  }
}

/** Ponto de entrada de linha de comando. */
async function main(): Promise<void> {
  const result = await runMigrations();
  if (result.applied.length === 0) {
    console.log(`Nada a fazer: \`${result.database}\` já está com as ${result.alreadyApplied} migrations aplicadas.`);
    return;
  }
  console.log(`Banco \`${result.database}\`: ${result.applied.length} migration(s) aplicada(s).`);
  for (const name of result.applied) {
    console.log(`  + ${name}`);
  }
}

// Só roda quando o arquivo é o processo principal (`tsx src/migrate.ts`).
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
