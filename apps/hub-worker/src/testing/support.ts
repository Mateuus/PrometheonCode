// Apoio aos testes que falam com MySQL e Redis de verdade.
//
// Duas regras que valem para toda suíte daqui:
//
// - **nada toca no ambiente de desenvolvimento.** Cada suíte cria um banco
//   descartável com nome único, migra, usa e derruba; e escreve no Redis apenas
//   sob um prefixo próprio, apagado no final com um `SCAN` restrito a ele.
//   `prometheon_dev` e as chaves de outros prefixos não são tocadas.
// - **serviço fora do ar não reprova o pipeline.** `probeMysql` e `probeRedis`
//   devolvem o motivo, e a suíte se declara pulada com essa mensagem em vez de
//   estourar num erro de conexão sem contexto.

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConnection, type Connection, type Pool } from 'mysql2/promise';

import {
  createDatabase,
  newId,
  readDatabaseEnv,
  runMigrations,
  seedDatabase,
  type Database,
  type SeedResult,
} from '@prometheon/database';

import { loadWorkerSettings, type WorkerSettings } from '../config.js';
import { createKeyNamespace, type KeyNamespace } from '../keys.js';
import { closeRedis, createRedisConnection, type RedisConnection } from '../redis.js';

export interface ProbeResult {
  readonly reachable: boolean;
  readonly reason?: string;
}

/** Configuração completa do worker, ou o motivo de não dar para carregá-la. */
export function probeSettings(): { settings?: WorkerSettings; reason?: string } {
  try {
    return { settings: loadWorkerSettings() };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

async function serverConnection(): Promise<Connection> {
  const env = readDatabaseEnv();
  return createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    connectTimeout: 5_000,
  });
}

/** Verifica se dá para usar o MySQL configurado. Nunca lança. */
export async function probeMysql(): Promise<ProbeResult> {
  let connection: Connection | undefined;
  try {
    connection = await serverConnection();
    await connection.query('SELECT 1');
    return { reachable: true };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

/** Verifica se dá para usar o Redis configurado. Nunca lança. */
export async function probeRedis(): Promise<ProbeResult> {
  const probe = probeSettings();
  if (probe.settings === undefined) {
    return { reachable: false, reason: probe.reason ?? 'configuração indisponível' };
  }
  let client: RedisConnection | undefined;
  try {
    client = createRedisConnection(probe.settings.app.redis, { role: 'probe' });
    await client.ping();
    return { reachable: true };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await closeRedis(client);
  }
}

export interface DisposableDatabase {
  readonly db: Database;
  readonly pool: Pool;
  readonly name: string;
  /** Fecha o pool e apaga o banco. Seguro chamar mais de uma vez. */
  drop(): Promise<void>;
}

/** Cria um banco temporário já migrado, com sufixo único no nome. */
export async function createDisposableDatabase(
  prefix = 'prometheon_worker_test',
): Promise<DisposableDatabase> {
  const name = `${prefix}_${newId().slice(-12).toLowerCase()}`;
  const admin = await serverConnection();
  try {
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await admin.end();
  }

  await runMigrations({ database: name });
  const { db, pool } = createDatabase({ database: name, connectionLimit: 5 });

  let dropped = false;
  return {
    db,
    pool,
    name,
    async drop(): Promise<void> {
      if (dropped) {
        return;
      }
      dropped = true;
      await pool.end().catch(() => undefined);
      const cleanup = await serverConnection();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Prefixo de chave descartável, para o teste não encostar em chave de ninguém. */
export function disposableKeyPrefix(label: string): KeyNamespace {
  return createKeyNamespace(`prometheon-test:${label}:${newId().slice(-10).toLowerCase()}:`);
}

/** Varre todas as chaves de um padrão. `SCAN` é incremental: um passo só não basta. */
export async function scanKeys(
  redis: RedisConnection,
  pattern: string,
): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

/**
 * Apaga só as chaves do prefixo informado.
 *
 * `SCAN` com `MATCH` em vez de `KEYS`: o servidor é compartilhado, e `KEYS`
 * bloqueia o Redis inteiro enquanto varre. O `bull` fica fora do padrão do
 * prefixo porque o BullMQ usa `{prefixo}`, com chaves, para o hash slot.
 */
export async function cleanupKeyPrefix(
  redis: RedisConnection,
  keys: KeyNamespace,
): Promise<number> {
  let removed = 0;
  for (const pattern of [`${keys.prefix}*`, `${keys.bull}*`]) {
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (batch.length > 0) {
        removed += await redis.del(...batch);
      }
    } while (cursor !== '0');
  }
  return removed;
}

/** Semeia plano, papéis, organização e owner no banco descartável. */
export async function seedFixtures(db: Database): Promise<SeedResult> {
  return seedDatabase(db);
}

export interface DisposableSettings {
  readonly settings: WorkerSettings;
  readonly keys: KeyNamespace;
  /** Remove o diretório de exportação criado para a suíte. */
  cleanup(): Promise<void>;
}

/**
 * Configuração de teste: mesmo servidor Redis e mesmo MySQL, prefixo de chave
 * exclusivo, health desligado, intervalos curtos e diretório de exportação
 * descartável. É o que permite subir o runtime de verdade sem encostar em nada
 * do ambiente de desenvolvimento.
 */
export function disposableSettings(label: string, base: WorkerSettings): DisposableSettings {
  const keys = disposableKeyPrefix(label);
  const exportsDir = join(tmpdir(), `prometheon-worker-${label}-${newId().slice(-8).toLowerCase()}`);

  const settings: WorkerSettings = {
    ...base,
    app: {
      ...base.app,
      redis: { ...base.app.redis, keyPrefix: keys.prefix },
    },
    instanceId: `test-${label}`,
    outboxEnabled: false,
    queuesEnabled: true,
    outbox: {
      ...base.outbox,
      batchSize: 50,
      pollIntervalMs: 50,
      idlePollIntervalMs: 100,
      lagSampleIntervalMs: 200,
      backoffBaseMs: 200,
      backoffMaxMs: 2_000,
    },
    health: { enabled: false, host: '127.0.0.1', port: 0, filePath: undefined },
    storage: { exportsDir, downloadTtlMs: 3_600_000 },
    shutdownTimeoutMs: 20_000,
  };

  return {
    settings,
    keys,
    async cleanup(): Promise<void> {
      await rm(exportsDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
