/**
 * Conexão com o Redis/Valkey.
 *
 * O Redis sustenta rate limit, a denylist de sessões, o estado do device flow e
 * os tokens de uso único de e-mail. Nada aqui é fonte da verdade de negócio: o
 * que se perde num restart do Redis é reemitido pelo usuário (pedir outro link
 * de verificação, refazer o device flow), e o que é permanente está no MySQL.
 */

import type { FastifyInstance } from 'fastify';
import { Redis, type RedisOptions } from 'ioredis';

import type { AppConfig } from '../config/index.js';

export type RedisClient = Redis;

export function buildRedisOptions(config: AppConfig): RedisOptions {
  return {
    db: config.redis.db,
    keyPrefix: config.redis.keyPrefix,
    ...(config.redis.password !== undefined && config.redis.password !== ''
      ? { password: config.redis.password }
      : {}),
    // Um comando que não consegue conectar deve falhar rápido e deixar a rota
    // decidir, em vez de ficar enfileirado até o cliente desistir.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    lazyConnect: true,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  };
}

export function createRedisClient(config: AppConfig): RedisClient {
  const options = buildRedisOptions(config);

  if (config.redis.url !== undefined) {
    return new Redis(config.redis.url, options);
  }

  return new Redis({
    ...options,
    host: config.redis.host ?? '127.0.0.1',
    port: config.redis.port,
  });
}

export async function registerRedis(app: FastifyInstance): Promise<void> {
  const client = createRedisClient(app.appConfig);

  // `lazyConnect` deixa a conexão para este ponto: assim uma falha de Redis
  // aparece no boot, com mensagem clara, e não na primeira requisição.
  await client.connect();

  app.decorate('redis', client);
  app.addHook('onClose', async () => {
    await client.quit().catch(() => { client.disconnect(); });
  });
}
