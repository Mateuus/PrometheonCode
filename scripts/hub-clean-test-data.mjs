#!/usr/bin/env node
// Remove do banco de desenvolvimento as contas que o teste de fumaça cria.
//
// O `hub:smoke` registra contas de verdade em `prometheon_dev` — é o que faz o
// teste valer. Sem uma limpeza, o banco acumula lixo e as contagens do seed
// deixam de significar algo.
//
// Só apaga o que casa com o domínio de teste. Conta real nunca é tocada.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import mysql from 'mysql2/promise';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Domínio reservado para teste (RFC 6761 usa `.test` justamente para isso). */
const TEST_EMAIL_PATTERN = '%@exemplo.test';

function readEnv() {
  const env = {};
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) {
      env[match[1]] = match[2];
    }
  }
  return env;
}

const env = readEnv();
const dryRun = process.argv.includes('--dry-run');

const connection = await mysql.createConnection({
  host: env.DATABASE_HOST,
  port: Number(env.DATABASE_PORT ?? 3306),
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  database: env.DATABASE_NAME,
  multipleStatements: false,
});

const [users] = await connection.query('SELECT id, email FROM users WHERE email LIKE ?', [
  TEST_EMAIL_PATTERN,
]);

if (users.length === 0) {
  console.log('Nenhuma conta de teste encontrada.');
  await connection.end();
  process.exit(0);
}

console.log(`${users.length} conta(s) de teste:`);
for (const user of users) {
  console.log(`  - ${user.email}`);
}

// Organizações criadas por essas contas. O `created_by` não tem FK de propósito
// (a auditoria sobrevive à exclusão da conta), então a busca é explícita.
const ids = users.map((user) => user.id);
const [organizations] = await connection.query(
  'SELECT id, name FROM organizations WHERE created_by IN (?)',
  [ids],
);
console.log(`${organizations.length} organização(ões) criada(s) por elas.`);

if (dryRun) {
  console.log('\n--dry-run: nada foi apagado.');
  await connection.end();
  process.exit(0);
}

// A cascata do schema cuida de membros, sessões, tokens e afins.
const [orgResult] = await connection.query('DELETE FROM organizations WHERE created_by IN (?)', [
  ids,
]);
const [userResult] = await connection.query('DELETE FROM users WHERE email LIKE ?', [
  TEST_EMAIL_PATTERN,
]);

console.log(
  `\nRemovidos: ${userResult.affectedRows} usuário(s), ${orgResult.affectedRows} organização(ões).`,
);
await connection.end();
