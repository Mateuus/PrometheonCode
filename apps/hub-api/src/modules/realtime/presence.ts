/**
 * Presença com TTL no Redis (`Docs/08`).
 *
 * **O ponto que decide se isso presta é a expiração.** Quem fecha o notebook não
 * pode ficar "online" para sempre — o defeito clássico do recurso, e o que faz a
 * equipe parar de olhar para o indicador. Aqui a expiração não depende de
 * nenhum `finally` ter rodado nem de a instância ter morrido com elegância:
 *
 * - cada conexão entra num ZSET com **score igual ao instante em que expira**;
 * - toda leitura roda `ZREMRANGEBYSCORE … -inf now` antes de responder, então
 *   uma entrada vencida nunca é vista, mesmo que ninguém a tenha removido;
 * - a própria chave tem `EXPIRE`, então uma organização inteira que esvazia some
 *   do Redis sozinha;
 * - uma varredura periódica (`sweep`) transforma a expiração silenciosa em
 *   `presence.changed`, que é o que a interface precisa para apagar o ponto
 *   verde.
 *
 * A presença é contada por **conexão**, não por pessoa: fechar uma aba de quem
 * tem três abertas não deixa ninguém offline. Só a última saída muda o estado.
 *
 * Dois níveis de chave, porque contar conexões varrendo um ZSET com toda a
 * organização não escala:
 *
 * ```text
 * <index>          ZSET  userId       -> expiração da conexão mais nova
 * <index>:u:<user> ZSET  connectionId -> expiração daquela conexão
 * ```
 */

import type { RedisClient } from '../../plugins/redis.js';
import { REALTIME_SETTINGS } from './settings.js';

/** Resultado de entrar: quantas conexões a pessoa tem e se esta foi a primeira. */
export interface PresenceJoin {
  readonly connections: number;
  readonly becameOnline: boolean;
}

/** Resultado de sair: quantas sobraram e se a pessoa ficou offline. */
export interface PresenceLeave {
  readonly connections: number;
  readonly becameOffline: boolean;
}

/** Quem sumiu por expiração, descoberto pela varredura. */
export interface PresenceExpiry {
  readonly userId: string;
  readonly connections: number;
}

export interface PresenceMember {
  readonly userId: string;
  readonly connectionIds: string[];
  /** Instante em que a última renovação expira. */
  readonly expiresAt: number;
}

function memberKey(index: string, userId: string): string {
  return `${index}:u:${userId}`;
}

export class PresenceStore {
  readonly #redis: RedisClient;
  readonly #ttlMs: number;

  constructor(redis: RedisClient, ttlMs: number = REALTIME_SETTINGS.presenceTtlMs) {
    this.#redis = redis;
    this.#ttlMs = ttlMs;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Registra ou renova uma conexão.
   *
   * Serve para os dois casos — entrar e bater o heartbeat — porque a operação é
   * a mesma: reescrever o score com a nova expiração. `becameOnline` distingue o
   * primeiro registro, e é ele que dispara `presence.changed`.
   */
  async join(index: string, userId: string, connectionId: string): Promise<PresenceJoin> {
    const now = Date.now();
    const expiresAt = now + this.#ttlMs;
    const key = memberKey(index, userId);
    const ttlSeconds = Math.ceil(this.#ttlMs / 1_000);

    const results = await this.#redis
      .multi()
      // Limpa o vencido antes de contar: sem isto, uma conexão morta há uma hora
      // ainda faria `becameOnline` responder `false`.
      .zremrangebyscore(key, '-inf', now)
      .zadd(key, expiresAt, connectionId)
      .zcard(key)
      .expire(key, ttlSeconds)
      .zadd(index, expiresAt, userId)
      .expire(index, ttlSeconds)
      .exec();

    const connections = Number(results?.[2]?.[1] ?? 1);

    return { connections, becameOnline: connections === 1 };
  }

  /** Remove uma conexão. `becameOffline` é `true` quando era a última. */
  async leave(index: string, userId: string, connectionId: string): Promise<PresenceLeave> {
    const now = Date.now();
    const key = memberKey(index, userId);

    const results = await this.#redis
      .multi()
      .zrem(key, connectionId)
      .zremrangebyscore(key, '-inf', now)
      .zcard(key)
      .exec();

    const connections = Number(results?.[2]?.[1] ?? 0);

    if (connections === 0) {
      await this.#redis.multi().del(key).zrem(index, userId).exec();
    }

    return { connections, becameOffline: connections === 0 };
  }

  /**
   * Remove o que venceu e devolve quem ficou offline por isso.
   *
   * É a ponte entre "expirou no Redis" e "a interface soube": a expiração já
   * aconteceu de qualquer forma, mas sem esta varredura ninguém emitiria o
   * `presence.changed` correspondente.
   */
  async sweep(index: string): Promise<PresenceExpiry[]> {
    const now = Date.now();
    // Candidatos: quem tem score vencido no índice da organização.
    const candidates = await this.#redis.zrangebyscore(index, '-inf', now);

    if (candidates.length === 0) {
      return [];
    }

    const expired: PresenceExpiry[] = [];

    for (const userId of candidates) {
      const key = memberKey(index, userId);
      const results = await this.#redis
        .multi()
        .zremrangebyscore(key, '-inf', now)
        .zcard(key)
        .exec();

      const connections = Number(results?.[1]?.[1] ?? 0);

      if (connections === 0) {
        await this.#redis.multi().del(key).zrem(index, userId).exec();
        expired.push({ userId, connections: 0 });
        continue;
      }

      // Ainda há conexão viva: o índice estava com o score defasado porque a
      // renovação escreveu só na chave da pessoa. Realinha em vez de derrubar.
      const newest = await this.#redis.zrange(key, -1, -1, 'WITHSCORES');
      const score = Number(newest[1] ?? now);

      await this.#redis.zadd(index, score, userId);
    }

    return expired;
  }

  /** Quem está presente agora, já sem as entradas vencidas. */
  async list(index: string): Promise<PresenceMember[]> {
    const now = Date.now();

    await this.#redis.zremrangebyscore(index, '-inf', now);

    const flat = await this.#redis.zrange(index, 0, -1, 'WITHSCORES');
    const members: PresenceMember[] = [];

    for (let position = 0; position < flat.length; position += 2) {
      const userId = flat[position];
      const expiresAt = Number(flat[position + 1] ?? 0);

      if (userId === undefined) {
        continue;
      }

      const key = memberKey(index, userId);

      await this.#redis.zremrangebyscore(key, '-inf', now);

      const connectionIds = await this.#redis.zrange(key, 0, -1);

      if (connectionIds.length === 0) {
        await this.#redis.zrem(index, userId);
        continue;
      }

      members.push({ userId, connectionIds, expiresAt });
    }

    return members;
  }

  /** Conexões vivas de uma pessoa num índice. */
  async countConnections(index: string, userId: string): Promise<number> {
    const now = Date.now();
    const key = memberKey(index, userId);

    const results = await this.#redis
      .multi()
      .zremrangebyscore(key, '-inf', now)
      .zcard(key)
      .exec();

    return Number(results?.[1]?.[1] ?? 0);
  }

  /** Apaga tudo de um índice. Existe para o teste não deixar lixo no servidor. */
  async purge(index: string): Promise<void> {
    const members = await this.#redis.zrange(index, 0, -1);
    const pipeline = this.#redis.multi();

    for (const userId of members) {
      pipeline.del(memberKey(index, userId));
    }

    pipeline.del(index);

    await pipeline.exec();
  }
}
