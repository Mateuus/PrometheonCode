// Lock curto no Redis (`Docs/08`, "locks curtos").
//
// É o que impede duas instâncias do worker de publicarem o mesmo evento do
// outbox. O contrato é o clássico:
//
// - aquisição com `SET chave dono NX PX ttl` — atômica, e o TTL garante que a
//   morte do dono libere a chave sozinha;
// - liberação com script Lua que compara o dono antes de apagar, para que um
//   worker atrasado não apague o lock que já pertence a outro;
// - renovação pelo mesmo caminho, para trabalho que passa do TTL.
//
// O lock é uma otimização de exclusão, não a garantia de unicidade: a garantia
// vem do banco (`published_at IS NULL` na marcação). Entrega é pelo menos uma
// vez (`Docs/08`) e o consumidor deduplica pelo ID.

import { randomUUID } from 'node:crypto';

import type { RedisConnection } from './redis.js';

/** Apaga a chave apenas se o valor ainda for o do dono informado. */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/** Estende o TTL apenas se o dono ainda for o mesmo. */
const EXTEND_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

export interface Lock {
  readonly key: string;
  readonly token: string;
}

export class RedisLocker {
  readonly #redis: RedisConnection;

  constructor(redis: RedisConnection) {
    this.#redis = redis;
  }

  /** Tenta tomar o lock. Devolve `undefined` quando outro dono já o tem. */
  async acquire(key: string, ttlMs: number): Promise<Lock | undefined> {
    const token = randomUUID();
    const result = await this.#redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token } : undefined;
  }

  /** Libera o lock. `false` quando ele já não pertencia a este dono. */
  async release(lock: Lock): Promise<boolean> {
    const result = await this.#redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
    return Number(result) === 1;
  }

  /** Renova o TTL. `false` quando o lock expirou ou mudou de dono. */
  async extend(lock: Lock, ttlMs: number): Promise<boolean> {
    const result = await this.#redis.eval(
      EXTEND_SCRIPT,
      1,
      lock.key,
      lock.token,
      String(ttlMs),
    );
    return Number(result) === 1;
  }

  /**
   * Executa `fn` com o lock tomado e libera no final, mesmo com erro.
   * Devolve `undefined` quando não conseguiu o lock.
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: (lock: Lock) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; result: T }> {
    const lock = await this.acquire(key, ttlMs);
    if (lock === undefined) {
      return { acquired: false };
    }
    try {
      return { acquired: true, result: await fn(lock) };
    } finally {
      await this.release(lock).catch(() => undefined);
    }
  }
}
