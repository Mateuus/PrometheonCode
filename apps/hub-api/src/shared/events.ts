/**
 * Eventos de domínio, gravados no Transactional Outbox (`Docs/08`).
 *
 * A regra que este módulo existe para tornar difícil de quebrar: **o evento é
 * gravado na mesma transação da mudança**. Por isso todas as funções daqui
 * recebem o executor da transação, nunca abrem conexão própria:
 *
 * ```ts
 * await runInTransaction(db, async (tx) => {
 *   await tx.insert(messages, { … });
 *   await recordMessageCreated(tx, { … });
 * });
 * ```
 *
 * `TransactionExecutor` não é o `EntityManager` do TypeORM: é uma marca que só
 * `runInTransaction()` sabe produzir. Passar o gerenciador global aqui não
 * compila — que é como a regra deixa de depender de disciplina.
 *
 * Se a transação falhar, a mudança e o evento somem juntos. Se ela passar, o
 * worker publica — não existe estado gravado sem evento, que é o defeito que o
 * padrão do outbox existe para evitar.
 *
 * O `payload` é o `data` do envelope de tempo real: o worker acrescenta `id`,
 * `cursor` e `occurredAt` a partir da própria linha do outbox. Os payloads são
 * enxutos de propósito (`Docs/08`): o WebSocket avisa que algo mudou, e o
 * cliente busca o estado completo pelo REST.
 */

import { enqueueOutboxMessage, type TransactionExecutor } from '@prometheon/database';
import type {
  MessageAuthorType,
  MessageStatus,
  RealtimeEventType,
  TaskStatus,
} from '@prometheon/contracts';

/** Executor de uma transação em curso. Ver o cabeçalho deste arquivo. */
export type OutboxExecutor = TransactionExecutor;

export interface EventActor {
  readonly type: 'user' | 'agent' | 'system' | 'device';
  readonly id: string | null;
}

interface BaseEventInput {
  readonly organizationId: string;
  readonly projectId: string | null;
  /** Chave de idempotência do comando, quando houver. */
  readonly dedupeKey?: string | null;
  readonly occurredAt?: Date;
}

async function enqueue(
  executor: OutboxExecutor,
  input: BaseEventInput & {
    aggregateType: string;
    aggregateId: string;
    aggregateSequence: number | null;
    eventType: RealtimeEventType;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  return enqueueOutboxMessage(executor, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateSequence: input.aggregateSequence,
    eventType: input.eventType,
    payload: input.payload,
    dedupeKey: input.dedupeKey ?? null,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
}

export interface MessageCreatedInput extends BaseEventInput {
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly authorType: MessageAuthorType;
  readonly status: MessageStatus;
}

/**
 * `message.created`.
 *
 * `aggregateSequence` recebe a sequência da mensagem: é ela que dá ordem por
 * agregado ao consumidor, exigida pelas garantias do `Docs/08`.
 */
export async function recordMessageCreated(
  executor: OutboxExecutor,
  input: MessageCreatedInput,
): Promise<string> {
  return enqueue(executor, {
    ...input,
    aggregateType: 'conversation',
    aggregateId: input.conversationId,
    aggregateSequence: input.sequence,
    eventType: 'message.created',
    payload: {
      conversationId: input.conversationId,
      messageId: input.messageId,
      sequence: input.sequence,
      authorType: input.authorType,
      status: input.status,
    },
  });
}

export interface TaskEventInput extends BaseEventInput {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** `version` da tarefa depois da mudança; ordena o agregado. */
  readonly version: number;
  readonly actor: EventActor;
}

async function recordTaskEvent(
  executor: OutboxExecutor,
  eventType: Extract<
    RealtimeEventType,
    'task.created' | 'task.updated' | 'task.claimed' | 'task.released'
  >,
  input: TaskEventInput,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return enqueue(executor, {
    ...input,
    aggregateType: 'task',
    aggregateId: input.taskId,
    aggregateSequence: input.version,
    eventType,
    payload: {
      taskId: input.taskId,
      status: input.status,
      version: input.version,
      actor: { type: input.actor.type, id: input.actor.id },
      ...extra,
    },
  });
}

export async function recordTaskCreated(
  executor: OutboxExecutor,
  input: TaskEventInput,
): Promise<string> {
  return recordTaskEvent(executor, 'task.created', input);
}

export async function recordTaskUpdated(
  executor: OutboxExecutor,
  input: TaskEventInput,
): Promise<string> {
  return recordTaskEvent(executor, 'task.updated', input);
}

/** `task.claimed` carrega o prazo da reivindicação, como manda o contrato. */
export async function recordTaskClaimed(
  executor: OutboxExecutor,
  input: TaskEventInput & { readonly leaseExpiresAt: Date },
): Promise<string> {
  return recordTaskEvent(executor, 'task.claimed', input, {
    leaseExpiresAt: input.leaseExpiresAt.toISOString(),
  });
}

export async function recordTaskReleased(
  executor: OutboxExecutor,
  input: TaskEventInput,
): Promise<string> {
  return recordTaskEvent(executor, 'task.released', input);
}
