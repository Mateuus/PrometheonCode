// Fila `dead-letter` — registro e inspeção do que foi abandonado (`Docs/08`).
//
// É o fim da linha das outras sete filas e também do publicador do outbox. O
// processador não tenta consertar nada: ele registra em formato consultável e
// deixa o rastro completo — payload original incluso — para que alguém decida o
// que fazer depois de corrigir a causa.
//
// O registro vive numa lista limitada no Redis, e não no MySQL, por um motivo
// do `Docs/08`: Redis não guarda conversa, tarefa nem auditoria em definitivo,
// mas material operacional de curta duração é exatamente o caso dele. O job em
// si continua na fila, com `keepCompleted` alto, para inspeção pelo BullMQ.

import { deadLetterJobSchema, type DeadLetterJob } from '../payloads.js';
import type { JobHandler } from '../runtime.js';
import type { KeyNamespace } from '../../keys.js';
import type { RedisConnection } from '../../redis.js';

/** Quantos registros ficam guardados para inspeção. */
export const DEAD_LETTER_HISTORY = 1_000;

/** Validade do registro. Depois disso, o histórico da fila é a fonte. */
export const DEAD_LETTER_TTL_MS = 30 * 86_400_000;

/** Grava o registro na lista de inspeção, mantendo-a limitada. */
export async function recordDeadLetter(
  redis: RedisConnection,
  keys: KeyNamespace,
  entry: DeadLetterJob,
): Promise<void> {
  const key = keys.deadLetterRecords;
  await redis
    .multi()
    .lpush(key, JSON.stringify(entry))
    .ltrim(key, 0, DEAD_LETTER_HISTORY - 1)
    .pexpire(key, DEAD_LETTER_TTL_MS)
    .exec();
}

/** Últimos registros, do mais recente para o mais antigo. */
export async function listDeadLetters(
  redis: RedisConnection,
  keys: KeyNamespace,
  limit = 50,
): Promise<DeadLetterJob[]> {
  const raw = await redis.lrange(keys.deadLetterRecords, 0, Math.max(0, limit - 1));
  const entries: DeadLetterJob[] = [];
  for (const item of raw) {
    try {
      const parsed = deadLetterJobSchema.safeParse(JSON.parse(item));
      if (parsed.success) {
        entries.push(parsed.data);
      }
    } catch {
      // Registro corrompido não pode derrubar a inspeção do resto.
      continue;
    }
  }
  return entries;
}

/** Quantos registros estão guardados agora. */
export async function countDeadLetters(
  redis: RedisConnection,
  keys: KeyNamespace,
): Promise<number> {
  return redis.llen(keys.deadLetterRecords);
}

export const deadLetterHandler: JobHandler<typeof deadLetterJobSchema> = {
  queue: 'dead-letter',
  schema: deadLetterJobSchema,
  async run({ data, deps, logger }) {
    await recordDeadLetter(deps.redis, deps.keys, data);

    // `error` e não `warn`: alguém precisa olhar. O payload original fica no
    // registro, não na linha de log, para não vazar conteúdo em disco.
    logger.error(
      {
        source: data.source,
        origin: data.origin,
        originId: data.originId,
        errorCode: data.errorCode,
        permanent: data.permanent,
        attemptsMade: data.attemptsMade,
      },
      'registro na dead-letter',
    );

    return {
      status: 'done',
      details: { origin: data.origin, originId: data.originId, permanent: data.permanent },
    };
  },
};
