#!/usr/bin/env node
// Confere se MySQL e Redis do desenvolvimento estão alcançáveis e utilizáveis.
// Roda antes de subir a API para dar um erro claro em vez de stack trace.
//
// Uso: node scripts/check-hub-services.mjs

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Lê o .env sem depender de biblioteca — só o suficiente para o diagnóstico. */
function readEnv() {
  const env = {};
  let raw = '';
  try {
    raw = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    console.error('erro: .env não encontrado. Copie .env.example para .env.');
    process.exit(2);
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) {
      env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return env;
}

const env = readEnv();
const problems = [];

// --- MySQL -----------------------------------------------------------------

let connection;
try {
  connection = await mysql.createConnection({
    host: env.DATABASE_HOST,
    port: Number(env.DATABASE_PORT ?? 3306),
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    connectTimeout: 8000,
  });
  const [version] = await connection.query('SELECT VERSION() AS version');
  console.log(`mysql       ok — ${version[0].version} em ${env.DATABASE_HOST}:${env.DATABASE_PORT}`);

  const [databases] = await connection.query('SHOW DATABASES LIKE ?', [env.DATABASE_NAME]);
  if (databases.length === 0) {
    // O usuário do desenvolvimento costuma poder criar; se não puder, avisamos.
    try {
      await connection.query(
        `CREATE DATABASE \`${env.DATABASE_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      console.log(`mysql       banco ${env.DATABASE_NAME} criado`);
    } catch (error) {
      problems.push(`banco ${env.DATABASE_NAME} não existe e não pôde ser criado: ${error.message}`);
    }
  } else {
    console.log(`mysql       banco ${env.DATABASE_NAME} presente`);
  }

  const [grants] = await connection.query('SHOW GRANTS FOR CURRENT_USER()');
  const canWrite = grants.some(
    (row) => /ALL PRIVILEGES/i.test(Object.values(row)[0]) || /CREATE/i.test(Object.values(row)[0]),
  );
  console.log(`mysql       permissão de DDL: ${canWrite ? 'sim' : 'não detectada'}`);
} catch (error) {
  problems.push(`mysql indisponível: ${error.message}`);
} finally {
  await connection?.end();
}

// --- Redis / Valkey --------------------------------------------------------

const redis = new Redis(env.VALKEY_URL ?? `redis://${env.VALKEY_HOST}:${env.VALKEY_PORT}`, {
  lazyConnect: true,
  connectTimeout: 8000,
  maxRetriesPerRequest: 1,
});
try {
  await redis.connect();
  const pong = await redis.ping();
  const info = await redis.info('server');
  const version = /redis_version:(\S+)/.exec(info)?.[1] ?? 'desconhecida';
  console.log(`redis       ok — ${pong}, versão ${version}`);

  // Escrita e leitura reais: PING sozinho não prova que dá para usar.
  const key = `${env.VALKEY_KEY_PREFIX ?? ''}healthcheck`;
  await redis.set(key, 'ok', 'EX', 10);
  const value = await redis.get(key);
  await redis.del(key);
  if (value !== 'ok') {
    problems.push('redis aceitou a escrita mas não devolveu o valor');
  } else {
    console.log('redis       escrita e leitura confirmadas');
  }
} catch (error) {
  problems.push(`redis indisponível: ${error.message}`);
} finally {
  redis.disconnect();
}

// --- Relatório -------------------------------------------------------------

if (problems.length > 0) {
  console.error('\nProblemas encontrados:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log('\nDependências do Hub prontas.');
