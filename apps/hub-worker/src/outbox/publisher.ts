// Publicador do Transactional Outbox (`Docs/08`).
//
// O fluxo do documento é: o domínio grava mudança e evento na mesma transação,
// o worker publica, marca como publicado, e o consumidor deduplica pelo ID.
// Este arquivo é o segundo e o terceiro passos. O que ele garante, e como:
//
// **Varredura barata.** A consulta é `published_at IS NULL AND available_at <=
// now ORDER BY available_at, id LIMIT n`, com lista explícita de colunas. Ela
// casa com `idx_outbox_unpublished (published_at, available_at, id)`: o range
// scan cai direto no bloco dos pendentes — pequeno mesmo com a tabela grande —
// e a ordenação sai do próprio índice, sem `filesort`.
//
// **Uma publicação por evento, com N workers.** Três camadas somadas: lock
// curto no Redis por mensagem (`SET NX PX`), releitura de `published_at` já com
// o lock na mão (fecha a janela entre a leitura do lote e a marcação de outro
// worker) e marcação condicional `... WHERE published_at IS NULL`, cujo
// `affectedRows` denuncia a corrida perdida. Nenhuma das três sozinha basta.
//
// **Pelo menos uma vez, nunca exatamente uma.** Publicamos antes de marcar. Um
// crash entre os dois passos republica o evento na próxima volta — é o lado
// certo de errar, e o `id` estável deixa o consumidor deduplicar.
//
// **Ordem por agregado.** O lote é agrupado por `(aggregate_type,
// aggregate_id)`. Dentro do grupo a publicação é serial, na ordem do índice, e
// qualquer tropeço — lock de outro worker, falha de publicação — aborta o
// restante daquele grupo na rodada. Assim nunca sai o evento 7 antes do 6.
// Grupos diferentes seguem em paralelo, com concorrência limitada.
//
// **Retentativa e dead-letter.** Falha de publicação reagenda `available_at`
// com backoff exponencial + jitter e teto; esgotado o limite, o evento é
// registrado na fila `dead-letter` e sai da varredura com `last_error`
// começando por `DEAD_LETTER:`.
//
// **Atraso.** `sync_outbox_pending` e `sync_outbox_lag_seconds` medem quantos
// eventos estão parados e há quanto tempo. É o número que denuncia worker
// morto: publicações continuam zeradas, o atraso cresce sem parar.

import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

import {
  markOutboxPublished,
  outboxMessages,
  rescheduleOutboxMessage,
  type Database,
} from '@prometheon/database';
import type { Logger } from '@prometheon/logger';

import { backoffDelay } from '../backoff.js';
import { errorMessage } from '../errors.js';
import type { KeyNamespace } from '../keys.js';
import type { RedisLocker } from '../lock.js';
import { METRIC, type MetricsRegistry } from '../metrics.js';
import { aggregateKey, toEnvelope, type OutboxRecord } from './envelope.js';

/** Prefixo gravado em `last_error` quando o evento é abandonado. */
export const DEAD_LETTER_PREFIX = 'DEAD_LETTER:';

/** Publica o envelope serializado. Devolve quantos assinantes o receberam. */
export type PublishFn = (channel: string, payload: string) => Promise<number>;

/** Registro entregue à fila `dead-letter` quando o evento é abandonado. */
export interface OutboxDeadLetter {
  readonly messageId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly attempts: number;
  readonly reason: string;
}

export interface OutboxPublisherOptions {
  readonly db: Database;
  readonly locker: RedisLocker;
  readonly keys: KeyNamespace;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly publish: PublishFn;
  /** Chamado quando o evento esgota as tentativas. */
  readonly onDeadLetter?: ((record: OutboxDeadLetter) => Promise<void>) | undefined;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly idlePollIntervalMs: number;
  readonly lockTtlMs: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly lagSampleIntervalMs: number;
  /** Publicações simultâneas de agregados distintos. */
  readonly aggregateConcurrency?: number | undefined;
  /** Relógio injetável; existe para o teste não depender do horário real. */
  readonly now?: (() => Date) | undefined;
}

export interface OutboxBatchResult {
  /** Mensagens lidas do banco nesta volta. */
  readonly scanned: number;
  readonly published: number;
  /** Já publicadas por outro worker entre a leitura e o lock. */
  readonly duplicates: number;
  /** Puladas porque outro worker segurava o lock. */
  readonly contended: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export interface OutboxLag {
  readonly pending: number;
  readonly oldestOccurredAt: Date | null;
  /** Idade do evento pendente mais antigo, em milissegundos. */
  readonly lagMs: number;
}

/** Colunas lidas na varredura. Lista explícita: nada de `SELECT *`. */
const PENDING_COLUMNS = {
  id: outboxMessages.id,
  organizationId: outboxMessages.organizationId,
  projectId: outboxMessages.projectId,
  aggregateType: outboxMessages.aggregateType,
  aggregateId: outboxMessages.aggregateId,
  aggregateSequence: outboxMessages.aggregateSequence,
  eventType: outboxMessages.eventType,
  eventVersion: outboxMessages.eventVersion,
  payload: outboxMessages.payload,
  occurredAt: outboxMessages.occurredAt,
  availableAt: outboxMessages.availableAt,
  attempts: outboxMessages.attempts,
} as const;

const EMPTY_BATCH: OutboxBatchResult = {
  scanned: 0,
  published: 0,
  duplicates: 0,
  contended: 0,
  failed: 0,
  deadLettered: 0,
};

export class OutboxPublisher {
  readonly #options: OutboxPublisherOptions;
  readonly #now: () => Date;
  readonly #aggregateConcurrency: number;

  #running = false;
  #loop: Promise<void> | undefined;
  #wakeUp: (() => void) | undefined;
  #lastLagSampleAt = 0;
  #lastLag: OutboxLag = { pending: 0, oldestOccurredAt: null, lagMs: 0 };

  constructor(options: OutboxPublisherOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): Date => new Date());
    this.#aggregateConcurrency = Math.max(1, options.aggregateConcurrency ?? 8);
  }

  get running(): boolean {
    return this.#running;
  }

  /** Último atraso amostrado, sem ir ao banco. */
  get lastLag(): OutboxLag {
    return this.#lastLag;
  }

  /** Sobe o laço de publicação. Não bloqueia. */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop = this.#run();
  }

  /**
   * Para o laço e espera a volta corrente terminar. Nunca interrompe um lote no
   * meio: um evento publicado e não marcado voltaria a ser publicado.
   */
  async stop(): Promise<void> {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#wakeUp?.();
    await this.#loop;
    this.#loop = undefined;
  }

  /** Acorda o laço sem esperar o próximo intervalo. */
  notify(): void {
    this.#wakeUp?.();
  }

  async #run(): Promise<void> {
    const { logger } = this.#options;
    while (this.#running) {
      let result = EMPTY_BATCH;
      const startedAt = Date.now();
      try {
        result = await this.runOnce();
      } catch (error) {
        // Falha de infraestrutura (banco fora, Redis fora): registra, conta e
        // tenta de novo no próximo intervalo. Derrubar o processo aqui só
        // transformaria uma indisponibilidade passageira em worker morto.
        this.#options.metrics.increment(METRIC.outboxFailuresTotal, { stage: 'batch' });
        logger.error({ err: error }, 'falha na varredura do outbox');
      }
      this.#options.metrics.observe(METRIC.outboxBatchDuration, Date.now() - startedAt);

      await this.#sampleLagIfDue();

      // Lido pelo getter de propósito: dentro do `while (this.#running)` o
      // compilador estreita o campo para `true` e considera esta guarda morta —
      // mas `stop()` pode tê-la desligado durante o `await` acima.
      if (!this.running) {
        break;
      }
      // Lote cheio significa que provavelmente há mais esperando: volta rápido.
      const idle = result.scanned === 0;
      await this.#sleep(
        idle ? this.#options.idlePollIntervalMs : this.#options.pollIntervalMs,
      );
    }
  }

  /** Uma volta completa: varre, publica, marca. Exposto para teste e para CLI. */
  async runOnce(): Promise<OutboxBatchResult> {
    const messages = await this.#fetchPending();
    if (messages.length === 0) {
      return EMPTY_BATCH;
    }

    const groups = groupByAggregate(messages);
    const totals = { ...EMPTY_BATCH, scanned: messages.length };

    await mapWithConcurrency(groups, this.#aggregateConcurrency, async (group) => {
      const groupResult = await this.#publishGroup(group);
      totals.published += groupResult.published;
      totals.duplicates += groupResult.duplicates;
      totals.contended += groupResult.contended;
      totals.failed += groupResult.failed;
      totals.deadLettered += groupResult.deadLettered;
    });

    return totals;
  }

  /**
   * Publica um agregado inteiro, em ordem. Qualquer tropeço interrompe o resto
   * do grupo nesta rodada — a próxima volta retoma do ponto certo, o que
   * preserva a ordem por agregado que o `Docs/08` exige.
   */
  async #publishGroup(group: OutboxRecord[]): Promise<Omit<OutboxBatchResult, 'scanned'>> {
    const result = { published: 0, duplicates: 0, contended: 0, failed: 0, deadLettered: 0 };

    for (const message of group) {
      const outcome = await this.#publishOne(message);
      if (outcome === 'published') {
        result.published += 1;
        continue;
      }
      if (outcome === 'duplicate') {
        result.duplicates += 1;
        // Já publicado por outro worker: seguir para o próximo do agregado é
        // seguro, porque o anterior saiu na ordem certa de qualquer forma.
        continue;
      }
      if (outcome === 'contended') {
        result.contended += 1;
      } else if (outcome === 'dead-lettered') {
        result.deadLettered += 1;
      } else {
        result.failed += 1;
      }
      break;
    }

    return result;
  }

  async #publishOne(
    message: OutboxRecord,
  ): Promise<'published' | 'duplicate' | 'contended' | 'failed' | 'dead-lettered'> {
    const { keys, locker, logger, metrics } = this.#options;
    const lockKey = keys.outboxLock(message.id);

    const lock = await locker.acquire(lockKey, this.#options.lockTtlMs);
    if (lock === undefined) {
      metrics.increment(METRIC.outboxLockContentionTotal);
      logger.debug(
        { outboxId: message.id, eventType: message.eventType },
        'outbox: mensagem já está com outro worker',
      );
      return 'contended';
    }

    try {
      // Releitura com o lock na mão: fecha a janela entre a varredura e a
      // marcação feita por outro worker que soltou o lock nesse intervalo.
      if (await this.#alreadyPublished(message.id)) {
        metrics.increment(METRIC.outboxDuplicatesTotal);
        return 'duplicate';
      }

      const envelope = toEnvelope(message);
      const channel = keys.realtimeChannel(message.organizationId);
      const receivers = await this.#options.publish(channel, JSON.stringify(envelope));

      const marked = await markOutboxPublished(this.#options.db, [message.id], this.#now());
      if (marked === 0) {
        // Publicamos, mas outro worker marcou primeiro. O evento saiu duas
        // vezes — previsto pela garantia de pelo menos uma vez.
        metrics.increment(METRIC.outboxDuplicatesTotal);
        return 'duplicate';
      }

      metrics.increment(METRIC.outboxPublishedTotal, { eventType: message.eventType });
      logger.debug(
        {
          outboxId: message.id,
          eventType: message.eventType,
          organizationId: message.organizationId,
          projectId: message.projectId,
          aggregateType: message.aggregateType,
          aggregateId: message.aggregateId,
          receivers,
        },
        'outbox: evento publicado',
      );
      return 'published';
    } catch (error) {
      return await this.#handleFailure(message, error);
    } finally {
      await locker.release(lock).catch(() => undefined);
    }
  }

  /** Reagenda com backoff, ou abandona quando as tentativas acabam. */
  async #handleFailure(
    message: OutboxRecord,
    error: unknown,
  ): Promise<'failed' | 'dead-lettered'> {
    const { logger, metrics } = this.#options;
    const attempt = message.attempts + 1;
    const reason = errorMessage(error);
    metrics.increment(METRIC.outboxFailuresTotal, { eventType: message.eventType });

    if (attempt >= this.#options.maxAttempts) {
      await this.#deadLetter(message, attempt, reason);
      logger.error(
        { err: error, outboxId: message.id, eventType: message.eventType, attempt },
        'outbox: evento abandonado na dead-letter',
      );
      return 'dead-lettered';
    }

    const delayMs = backoffDelay(attempt, {
      baseMs: this.#options.backoffBaseMs,
      maxMs: this.#options.backoffMaxMs,
    });
    await rescheduleOutboxMessage(
      this.#options.db,
      message.id,
      new Date(this.#now().getTime() + delayMs),
      reason.slice(0, 2_000),
    );
    logger.warn(
      { err: error, outboxId: message.id, eventType: message.eventType, attempt, delayMs },
      'outbox: publicação falhou, reagendada',
    );
    return 'failed';
  }

  /**
   * Tira o evento da varredura e registra o abandono.
   *
   * `published_at` aqui significa "o publicador terminou com esta linha", não
   * "foi entregue": o `last_error` começa com `DEAD_LETTER:` justamente para
   * distinguir os dois casos numa consulta. A tabela não tem coluna própria
   * para isso, e deixar a linha pendente para sempre envenenaria a métrica de
   * atraso — que é o alarme de worker parado.
   */
  async #deadLetter(message: OutboxRecord, attempt: number, reason: string): Promise<void> {
    const now = this.#now();
    await this.#options.db
      .update(outboxMessages)
      .set({
        publishedAt: now,
        attempts: attempt,
        lastError: `${DEAD_LETTER_PREFIX} ${reason}`.slice(0, 2_000),
      })
      .where(and(eq(outboxMessages.id, message.id), isNull(outboxMessages.publishedAt)));

    this.#options.metrics.increment(METRIC.outboxDeadLetteredTotal, {
      eventType: message.eventType,
    });

    await this.#options.onDeadLetter?.({
      messageId: message.id,
      organizationId: message.organizationId,
      eventType: message.eventType,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      attempts: attempt,
      reason,
    });
  }

  async #alreadyPublished(id: string): Promise<boolean> {
    const rows = await this.#options.db
      .select({ publishedAt: outboxMessages.publishedAt })
      .from(outboxMessages)
      .where(eq(outboxMessages.id, id))
      .limit(1);
    return rows[0]?.publishedAt != null;
  }

  async #fetchPending(): Promise<OutboxRecord[]> {
    const rows = await this.#options.db
      .select(PENDING_COLUMNS)
      .from(outboxMessages)
      .where(
        and(
          isNull(outboxMessages.publishedAt),
          lte(outboxMessages.availableAt, this.#now()),
        ),
      )
      .orderBy(asc(outboxMessages.availableAt), asc(outboxMessages.id))
      .limit(this.#options.batchSize);

    return rows;
  }

  /**
   * Mede o atraso: quantos eventos estão pendentes e há quanto tempo o mais
   * antigo espera. Duas consultas indexadas, não um `SELECT *` na tabela.
   */
  async sampleLag(): Promise<OutboxLag> {
    const [counts] = await this.#options.db
      // `count(*)` é BIGINT: o driver pode devolver número ou string.
      .select({ pending: sql<number | string>`count(*)` })
      .from(outboxMessages)
      .where(isNull(outboxMessages.publishedAt));

    const [oldest] = await this.#options.db
      .select({ occurredAt: outboxMessages.occurredAt })
      .from(outboxMessages)
      .where(isNull(outboxMessages.publishedAt))
      .orderBy(asc(outboxMessages.availableAt), asc(outboxMessages.id))
      .limit(1);

    const pending = Number(counts?.pending ?? 0);
    const oldestOccurredAt = oldest?.occurredAt ?? null;
    const lagMs =
      oldestOccurredAt === null
        ? 0
        : Math.max(0, this.#now().getTime() - oldestOccurredAt.getTime());

    const lag: OutboxLag = { pending, oldestOccurredAt, lagMs };
    this.#lastLag = lag;
    this.#options.metrics.setGauge(METRIC.outboxPending, pending);
    this.#options.metrics.setGauge(METRIC.outboxLagSeconds, lagMs / 1_000);
    return lag;
  }

  async #sampleLagIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastLagSampleAt < this.#options.lagSampleIntervalMs) {
      return;
    }
    this.#lastLagSampleAt = now;
    try {
      await this.sampleLag();
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'outbox: falha ao medir o atraso');
    }
  }

  /** Espera interrompível: `stop()` e `notify()` acordam na hora. */
  async #sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms);
      // `unref` evita que o timer segure o processo vivo no encerramento.
      timer.unref();
      this.#wakeUp = finish;

      function finish(): void {
        clearTimeout(timer);
        resolve();
      }
    });
    this.#wakeUp = undefined;
  }
}

/** Agrupa preservando a ordem de leitura dentro de cada agregado. */
export function groupByAggregate(messages: OutboxRecord[]): OutboxRecord[][] {
  const groups = new Map<string, OutboxRecord[]>();
  for (const message of messages) {
    const key = aggregateKey(message);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [message]);
      continue;
    }
    existing.push(message);
  }
  return [...groups.values()];
}

/** `Promise.all` com teto: não abre cem consultas num pool de dez conexões. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await fn(item);
    }
  });
  await Promise.all(runners);
}
