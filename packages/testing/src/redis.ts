import { randomBytes } from 'node:crypto';
import { getConfig } from '@prometheon/config';

export interface DisposableRedis {
  /** Prefixo exclusivo desta suíte; toda chave criada deve usá-lo. */
  readonly prefix: string;
  readonly url: string;
  /** Apaga só as chaves deste prefixo. Seguro chamar mais de uma vez. */
  flush(): Promise<number>;
}

/**
 * Reserva um espaço de chaves para uma suíte de teste.
 *
 * O Redis do desenvolvimento é compartilhado — inclusive com o Hub rodando na
 * máquina de alguém. Por isso a limpeza é por prefixo e nunca `FLUSHDB`: um
 * `FLUSHDB` no fim de um teste apaga a sessão de quem estiver trabalhando.
 *
 * A varredura usa `SCAN`, e não `KEYS`, que bloqueia o servidor inteiro.
 */
/**
 * A URL do Valkey é opcional na configuração — quem só define host e porta
 * também precisa funcionar. Montamos a URL aqui em vez de espalhar o fallback
 * por cada chamada.
 */
function resolveRedisUrl(): string {
  const { redis } = getConfig();
  if (redis.url !== undefined && redis.url !== '') {
    return redis.url;
  }
  const credentials = redis.password === undefined ? '' : `:${encodeURIComponent(redis.password)}@`;
  return `redis://${credentials}${redis.host ?? '127.0.0.1'}:${redis.port}/${redis.db}`;
}

export async function createDisposableRedis(label = 'test'): Promise<DisposableRedis> {
  const config = getConfig();
  const url = resolveRedisUrl();
  const prefix = `${config.redis.keyPrefix}${label}:${randomBytes(4).toString('hex')}:`;
  const { Redis } = await import('ioredis');

  let flushed = false;
  return {
    prefix,
    url,
    async flush() {
      if (flushed) {
        return 0;
      }
      flushed = true;
      const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await client.connect();
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          removed += await client.del(...keys);
        }
      } while (cursor !== '0');
      client.disconnect();
      return removed;
    },
  };
}
