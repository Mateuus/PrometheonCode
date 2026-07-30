// Conexões Redis do worker.
//
// Três papéis, três conexões: comandos gerais (locks, marcas de idempotência,
// publicação), o cliente que o BullMQ usa em modo bloqueante e — nos testes —
// o assinante. Misturar os três é o erro clássico: quem está em `SUBSCRIBE` não
// aceita outro comando, e quem está em `BRPOPLPUSH` bloqueia a conexão inteira.

import { Redis, type RedisOptions } from 'ioredis';

import type { RedisConfig } from '@prometheon/config';

export type RedisConnection = Redis;

export interface CreateRedisOptions {
  /** Rótulo que aparece nos logs de erro. */
  readonly role?: string;
  /**
   * BullMQ exige `maxRetriesPerRequest: null` nas conexões que ele bloqueia;
   * para as demais, um teto pequeno é melhor que esperar para sempre.
   */
  readonly blocking?: boolean;
  readonly lazyConnect?: boolean;
}

/** Endereço efetivo: a URL, quando existe, vence host/porta soltos. */
interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  readonly password: string | undefined;
  readonly username: string | undefined;
  readonly db: number;
}

/**
 * Resolve o endereço numa forma única.
 *
 * A URL é desmontada em vez de repassada porque o BullMQ recebe opções, não
 * string de conexão: sem isto, um ambiente configurado por `VALKEY_URL` subiria
 * as filas apontando para `localhost`.
 */
export function resolveRedisEndpoint(config: RedisConfig): RedisEndpoint {
  if (config.url === undefined) {
    return {
      host: config.host ?? '127.0.0.1',
      port: config.port,
      password: config.password,
      username: undefined,
      db: config.db,
    };
  }

  const url = new URL(config.url);
  const pathDb = url.pathname.replace(/^\//, '');
  const parsedDb = pathDb === '' ? Number.NaN : Number(pathDb);

  return {
    host: url.hostname === '' ? (config.host ?? '127.0.0.1') : url.hostname,
    port: url.port === '' ? config.port : Number(url.port),
    password: url.password === '' ? config.password : decodeURIComponent(url.password),
    username: url.username === '' ? undefined : decodeURIComponent(url.username),
    db: Number.isInteger(parsedDb) ? parsedDb : config.db,
  };
}

/**
 * Monta as opções do ioredis a partir da configuração validada.
 *
 * Nada de `keyPrefix` aqui: o BullMQ administra as próprias chaves e recebe o
 * prefixo pela opção `prefix` das filas. Prefixo na conexão faria as chaves
 * ficarem prefixadas duas vezes.
 */
export function buildRedisOptions(
  config: RedisConfig,
  options: CreateRedisOptions = {},
): RedisOptions {
  const endpoint = resolveRedisEndpoint(config);
  const base: RedisOptions = {
    host: endpoint.host,
    port: endpoint.port,
    db: endpoint.db,
    connectTimeout: 10_000,
    enableAutoPipelining: true,
    maxRetriesPerRequest: options.blocking === true ? null : 3,
    lazyConnect: options.lazyConnect ?? false,
    // Reconexão com teto: cair para sempre em 50 ms derruba o servidor junto.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  };

  if (endpoint.password !== undefined) {
    base.password = endpoint.password;
  }
  if (endpoint.username !== undefined) {
    base.username = endpoint.username;
  }
  if (options.role !== undefined) {
    base.connectionName = `prometheon-worker-${options.role}`;
  }

  return base;
}

/** Cria uma conexão. Use um papel por conexão. */
export function createRedisConnection(
  config: RedisConfig,
  options: CreateRedisOptions = {},
): RedisConnection {
  const client = new Redis(buildRedisOptions(config, options));
  client.setMaxListeners(50);
  return client;
}

/** Fecha a conexão sem lançar: no encerramento, erro de socket não importa. */
export async function closeRedis(client: RedisConnection | undefined): Promise<void> {
  if (client === undefined) {
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
