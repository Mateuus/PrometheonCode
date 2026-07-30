#!/usr/bin/env node
// Compara o schema de dois bancos MySQL, campo a campo.
//
// Existe para provar que rodar as migrations num banco vazio produz exatamente
// o schema que já está em uso — a garantia que sustenta a baseline do TypeORM.
// Compara tudo que o `information_schema` sabe e que muda o comportamento do
// banco: tabelas, colunas (tipo, nulabilidade, default, charset, collation,
// expressão de coluna gerada, posição), índices (colunas, ordem, unicidade) e
// chaves estrangeiras (colunas referenciadas e regras de exclusão).
//
// Nenhum dos dois bancos é modificado: só leitura.
//
// Uso: node scripts/hub-compare-schema.mjs <esperado> <obtido>
//      node scripts/hub-compare-schema.mjs prometheon_dev prometheon_baseline_check

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tabelas de controle do ORM, não do domínio. `typeorm_migrations` registra o
// que já rodou; `typeorm_metadata` guarda a definição de views (o projeto não
// tem nenhuma, então ela fica vazia). Um banco recém-migrado tem as duas e um
// banco adotado pela baseline as ganha na primeira execução — compará-las só
// produziria ruído.
const IGNORED_TABLES = new Set([
  'typeorm_migrations',
  'typeorm_metadata',
  '__drizzle_migrations',
]);

function readEnv() {
  const env = {};
  let raw = '';
  try {
    raw = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    console.error('erro: .env não encontrado na raiz do monorepo.');
    process.exit(2);
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) {
      env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return { ...env, ...process.env };
}

/** Colunas, com tudo que altera o significado do valor guardado. */
async function readColumns(connection, schema) {
  const [rows] = await connection.query(
    `SELECT table_name, column_name, ordinal_position, column_default, is_nullable,
            column_type, character_set_name, collation_name, extra, generation_expression
       FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY table_name, ordinal_position`,
    [schema],
  );
  const map = new Map();
  for (const row of rows) {
    if (IGNORED_TABLES.has(row.TABLE_NAME ?? row.table_name)) continue;
    const table = row.TABLE_NAME ?? row.table_name;
    const column = row.COLUMN_NAME ?? row.column_name;
    map.set(`${table}.${column}`, {
      position: Number(row.ORDINAL_POSITION ?? row.ordinal_position),
      default: row.COLUMN_DEFAULT ?? row.column_default,
      nullable: row.IS_NULLABLE ?? row.is_nullable,
      type: row.COLUMN_TYPE ?? row.column_type,
      charset: row.CHARACTER_SET_NAME ?? row.character_set_name,
      collation: row.COLLATION_NAME ?? row.collation_name,
      extra: row.EXTRA ?? row.extra,
      generated: row.GENERATION_EXPRESSION ?? row.generation_expression,
    });
  }
  return map;
}

/** Índices agregados por nome, com as colunas na ordem em que entram na chave. */
async function readIndexes(connection, schema) {
  const [rows] = await connection.query(
    `SELECT table_name, index_name, non_unique, seq_in_index, column_name, sub_part, index_type
       FROM information_schema.statistics
      WHERE table_schema = ?
      ORDER BY table_name, index_name, seq_in_index`,
    [schema],
  );
  const map = new Map();
  for (const row of rows) {
    const table = row.TABLE_NAME ?? row.table_name;
    if (IGNORED_TABLES.has(table)) continue;
    const name = row.INDEX_NAME ?? row.index_name;
    const key = `${table}.${name}`;
    const entry = map.get(key) ?? {
      unique: Number(row.NON_UNIQUE ?? row.non_unique) === 0,
      type: row.INDEX_TYPE ?? row.index_type,
      columns: [],
    };
    const subPart = row.SUB_PART ?? row.sub_part;
    entry.columns.push(
      subPart == null
        ? (row.COLUMN_NAME ?? row.column_name)
        : `${row.COLUMN_NAME ?? row.column_name}(${subPart})`,
    );
    map.set(key, entry);
  }
  for (const entry of map.values()) {
    entry.columns = entry.columns.join(',');
  }
  return map;
}

/** Chaves estrangeiras com as regras de ON DELETE/ON UPDATE. */
async function readForeignKeys(connection, schema) {
  const [rows] = await connection.query(
    `SELECT rc.table_name, rc.constraint_name, rc.referenced_table_name,
            rc.delete_rule, rc.update_rule,
            GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
            GROUP_CONCAT(kcu.referenced_column_name ORDER BY kcu.ordinal_position) AS referenced
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = rc.constraint_schema
        AND kcu.constraint_name = rc.constraint_name
      WHERE rc.constraint_schema = ?
      GROUP BY rc.table_name, rc.constraint_name, rc.referenced_table_name,
               rc.delete_rule, rc.update_rule
      ORDER BY rc.table_name, rc.constraint_name`,
    [schema],
  );
  const map = new Map();
  for (const row of rows) {
    const table = row.TABLE_NAME ?? row.table_name;
    if (IGNORED_TABLES.has(table)) continue;
    map.set(`${table}.${row.CONSTRAINT_NAME ?? row.constraint_name}`, {
      columns: row.columns ?? row.COLUMNS,
      references: `${row.REFERENCED_TABLE_NAME ?? row.referenced_table_name}(${row.referenced ?? row.REFERENCED})`,
      onDelete: row.DELETE_RULE ?? row.delete_rule,
      onUpdate: row.UPDATE_RULE ?? row.update_rule,
    });
  }
  return map;
}

/** Charset e collation de cada tabela, além do engine. */
async function readTables(connection, schema) {
  const [rows] = await connection.query(
    `SELECT table_name, engine, table_collation
       FROM information_schema.tables
      WHERE table_schema = ? AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  const map = new Map();
  for (const row of rows) {
    const table = row.TABLE_NAME ?? row.table_name;
    if (IGNORED_TABLES.has(table)) continue;
    map.set(table, {
      engine: row.ENGINE ?? row.engine,
      collation: row.TABLE_COLLATION ?? row.table_collation,
    });
  }
  return map;
}

/** Diferenças entre dois mapas de `chave -> objeto`. */
function diff(kind, expected, actual, problems) {
  for (const [key, value] of expected) {
    const other = actual.get(key);
    if (other === undefined) {
      problems.push(`${kind} ausente no obtido: ${key}`);
      continue;
    }
    for (const field of Object.keys(value)) {
      const left = value[field];
      const right = other[field];
      if (String(left) !== String(right)) {
        problems.push(`${kind} ${key}: ${field} esperado \`${left}\`, obtido \`${right}\``);
      }
    }
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      problems.push(`${kind} sobrando no obtido: ${key}`);
    }
  }
}

async function main() {
  const [expectedSchema, actualSchema] = process.argv.slice(2);
  if (!expectedSchema || !actualSchema) {
    console.error('uso: node scripts/hub-compare-schema.mjs <esperado> <obtido>');
    process.exit(2);
  }

  const env = readEnv();
  const connection = await mysql.createConnection({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT ?? 3306),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD ?? '',
  });

  try {
    const problems = [];
    diff(
      'tabela',
      await readTables(connection, expectedSchema),
      await readTables(connection, actualSchema),
      problems,
    );
    diff(
      'coluna',
      await readColumns(connection, expectedSchema),
      await readColumns(connection, actualSchema),
      problems,
    );
    diff(
      'índice',
      await readIndexes(connection, expectedSchema),
      await readIndexes(connection, actualSchema),
      problems,
    );
    diff(
      'chave estrangeira',
      await readForeignKeys(connection, expectedSchema),
      await readForeignKeys(connection, actualSchema),
      problems,
    );

    if (problems.length === 0) {
      console.log(`Schemas idênticos: \`${expectedSchema}\` e \`${actualSchema}\`.`);
      return;
    }
    console.error(`${problems.length} divergência(s) entre \`${expectedSchema}\` e \`${actualSchema}\`:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
