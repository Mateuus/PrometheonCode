// Runner de migrations.
//
// Aplica as migrations versionadas em `src/migrations/`. É idempotente: o
// TypeORM registra em `typeorm_migrations` o que já rodou, e rodar de novo não
// repete nada. O runner acrescenta três coisas ao comportamento padrão:
//
// 1. verifica charset e collation do banco antes de escrever;
// 2. informa exatamente quais migrations foram aplicadas nesta execução;
// 3. traduz falha de conexão e de permissão em mensagem acionável.
//
// A primeira migration é uma **baseline**: num banco que já tem o schema ela se
// registra sem executar nada (ver `migrations/1785404582237-BaselineSchema.ts`).
// Por isso `db:migrate` é seguro tanto num banco vazio quanto no
// `prometheon_dev`, que já está migrado e em uso.
//
// Uso: `pnpm --filter @prometheon/database db:migrate`
//      `DATABASE_NAME=outro_banco pnpm --filter @prometheon/database db:migrate`

import { resolve } from 'node:path';
import process from 'node:process';

import { MigrationExecutor } from 'typeorm';

import {
  createDatabase,
  EXPECTED_CHARSET,
  type CreateDatabaseOptions,
  type Database,
} from './client.js';

export interface MigrationResult {
  /** Nome das migrations aplicadas nesta execução. */
  applied: string[];
  /** Quantas já estavam registradas antes de começar. */
  alreadyApplied: number;
  database: string;
}

/** Falha cedo se o banco não estiver em utf8mb4 — acento e emoji quebrariam. */
async function assertCharset(db: Database, database: string): Promise<void> {
  const rows: { charset: string; collation: string }[] = await db.query(
    'SELECT @@character_set_database AS charset, @@collation_database AS collation',
  );
  const charset = rows[0]?.charset ?? '';
  const collation = rows[0]?.collation ?? '';
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
export async function runMigrations(options: CreateDatabaseOptions = {}): Promise<MigrationResult> {
  const requested = options.database ?? '(desconhecido)';
  let db: Database | undefined;

  try {
    db = await createDatabase({ ...options, connectionLimit: 1 });
    const databaseName = String(db.options.database ?? requested);
    await assertCharset(db, databaseName);

    const alreadyApplied = (await new MigrationExecutor(db).getExecutedMigrations()).length;
    // Uma transação por migration: se a segunda falhar, a primeira continua
    // aplicada e registrada, em vez de deixar o banco num estado que a tabela
    // de controle não descreve.
    const executed = await db.runMigrations({ transaction: 'each' });

    return {
      applied: executed.map((migration) => migration.name),
      alreadyApplied,
      database: databaseName,
    };
  } catch (error) {
    throw new Error(`Falha ao migrar \`${requested}\`: ${describeConnectionError(error, requested)}`, {
      cause: error,
    });
  } finally {
    await db?.destroy().catch(() => undefined);
  }
}

/** Ponto de entrada de linha de comando. */
async function main(): Promise<void> {
  const result = await runMigrations();
  if (result.applied.length === 0) {
    console.log(
      `Nada a fazer: \`${result.database}\` já está com as ${result.alreadyApplied} migrations aplicadas.`,
    );
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
