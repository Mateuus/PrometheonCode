// Filas do Hub e a política de cada uma (`Docs/08`).
//
// Todo job tem: `jobId` determinístico quando idempotente, tentativas
// limitadas, backoff exponencial com jitter, timeout, dead-letter, correlação,
// métricas e tratamento explícito de falha permanente. As três primeiras coisas
// e o timeout moram nesta tabela; o resto é o envelope de execução
// (`runtime.ts`), que aplica a política a cada job.
//
// Os números partem da natureza do trabalho:
//
// - chamada a sistema externo (webhooks, notifications) tolera muitas
//   tentativas espalhadas no tempo, porque a falha típica é indisponibilidade
//   passageira do outro lado;
// - trabalho caro e reexecutável (summarization, indexing) tem poucas
//   tentativas e timeout longo;
// - trabalho de governança (retention, exports, deletions) é lento, roda com
//   pouca concorrência e não pode ficar em retentativa eterna.

/** Nomes exatos das filas do `Docs/08`. A ordem é a do documento. */
export const QUEUE_NAMES = [
  'webhooks',
  'notifications',
  'context-summarization',
  'knowledge-indexing',
  'retention',
  'exports',
  'deletions',
  'dead-letter',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Fila para onde vai o que falhou de forma permanente ou esgotou tentativas. */
export const DEAD_LETTER_QUEUE = 'dead-letter' as const satisfies QueueName;

/** Nome do backoff customizado registrado nos workers. */
export const BACKOFF_STRATEGY = 'exponential-jitter';

export interface QueuePolicy {
  /** Tentativas totais, incluindo a primeira. */
  readonly attempts: number;
  /** Primeiro degrau do backoff, em milissegundos. */
  readonly backoffBaseMs: number;
  /** Teto do backoff, para não empurrar o job para semana que vem. */
  readonly backoffMaxMs: number;
  /** Tempo máximo de uma execução antes de ser considerada travada. */
  readonly timeoutMs: number;
  /**
   * `true` quando repetir o mesmo `jobId` não pode repetir o efeito. O envelope
   * grava uma marca no Redis depois do sucesso e pula a reexecução dentro da
   * janela — o `jobId` do BullMQ sozinho só protege enquanto o job existe.
   */
  readonly idempotent: boolean;
  /** Validade da marca de idempotência. */
  readonly idempotencyTtlMs: number;
  /** Quantos jobs concluídos ficam guardados para inspeção. */
  readonly keepCompleted: number;
  /** Quantos jobs falhos ficam guardados para inspeção. */
  readonly keepFailed: number;
}

const HOUR = 3_600_000;

export const QUEUE_POLICIES: Readonly<Record<QueueName, QueuePolicy>> = {
  webhooks: {
    attempts: 8,
    backoffBaseMs: 1_000,
    backoffMaxMs: 15 * 60_000,
    timeoutMs: 30_000,
    idempotent: true,
    idempotencyTtlMs: 24 * HOUR,
    keepCompleted: 500,
    keepFailed: 2_000,
  },
  notifications: {
    attempts: 5,
    backoffBaseMs: 2_000,
    backoffMaxMs: 10 * 60_000,
    timeoutMs: 20_000,
    idempotent: true,
    idempotencyTtlMs: 24 * HOUR,
    keepCompleted: 500,
    keepFailed: 2_000,
  },
  'context-summarization': {
    attempts: 3,
    backoffBaseMs: 5_000,
    backoffMaxMs: 10 * 60_000,
    timeoutMs: 180_000,
    idempotent: true,
    idempotencyTtlMs: 6 * HOUR,
    keepCompleted: 200,
    keepFailed: 1_000,
  },
  'knowledge-indexing': {
    attempts: 5,
    backoffBaseMs: 3_000,
    backoffMaxMs: 10 * 60_000,
    timeoutMs: 120_000,
    idempotent: true,
    idempotencyTtlMs: 6 * HOUR,
    keepCompleted: 200,
    keepFailed: 1_000,
  },
  retention: {
    attempts: 3,
    backoffBaseMs: 30_000,
    backoffMaxMs: 30 * 60_000,
    timeoutMs: 600_000,
    // Limpeza é recorrente por natureza: pular a execução seguinte porque a
    // anterior teve o mesmo identificador deixaria lixo acumulado.
    idempotent: false,
    idempotencyTtlMs: 0,
    keepCompleted: 100,
    keepFailed: 500,
  },
  exports: {
    attempts: 3,
    backoffBaseMs: 10_000,
    backoffMaxMs: 15 * 60_000,
    timeoutMs: 900_000,
    idempotent: true,
    idempotencyTtlMs: 24 * HOUR,
    keepCompleted: 200,
    keepFailed: 1_000,
  },
  deletions: {
    attempts: 5,
    backoffBaseMs: 10_000,
    backoffMaxMs: 30 * 60_000,
    timeoutMs: 600_000,
    idempotent: true,
    idempotencyTtlMs: 24 * HOUR,
    keepCompleted: 200,
    keepFailed: 1_000,
  },
  'dead-letter': {
    // A dead-letter é o fim da linha: se ela falhar, retentar não conserta
    // nada — o registro vai para o log e para a lista de inspeção.
    attempts: 1,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    timeoutMs: 15_000,
    idempotent: false,
    idempotencyTtlMs: 0,
    keepCompleted: 5_000,
    keepFailed: 5_000,
  },
};

/** Política de uma fila, sempre definida — o tipo garante a cobertura. */
export function queuePolicy(queue: QueueName): QueuePolicy {
  return QUEUE_POLICIES[queue];
}
