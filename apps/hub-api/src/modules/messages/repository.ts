/**
 * Acesso ao banco do módulo de mensagens.
 *
 * Aqui mora a decisão mais delicada do módulo: **como o número de sequência é
 * distribuído**. Ver `nextSequence()`.
 */

import {
  conversations,
  messageContextRefs,
  messageParts,
  messages,
  newId,
  outboxMessages,
  users,
  type Database,
} from '@prometheon/database';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import { firstRow } from '../projects/repository.js';
import type { MessagePartRow, MessageRow, ContextRefRow } from './types.js';

/** Executor de dentro de uma transação. */
export type TransactionExecutor = Parameters<Parameters<Database['transaction']>[0]>[0];

const messageColumns = {
  id: messages.id,
  organizationId: messages.organizationId,
  conversationId: messages.conversationId,
  authorType: messages.authorType,
  authorUserId: messages.authorUserId,
  authorAgentRunId: messages.authorAgentRunId,
  status: messages.status,
  sequence: messages.sequence,
  createdAt: messages.createdAt,
  updatedAt: messages.updatedAt,
} as const;

export class MessageRepository {
  constructor(private readonly db: Database) {}

  /**
   * Reserva o próximo número de sequência da conversa.
   *
   * O incremento acontece **no banco**, dentro da transação da mensagem:
   *
   * ```sql
   * UPDATE conversations SET last_sequence = last_sequence + 1 … WHERE id = ?;
   * SELECT last_sequence FROM conversations WHERE id = ?;
   * ```
   *
   * Três propriedades saem disso, e nenhuma delas sairia de um contador em
   * memória do processo — a API roda em mais de uma instância:
   *
   * 1. **Sem repetição.** O `UPDATE` toma o lock exclusivo da linha da conversa.
   *    Uma segunda transação que tente o mesmo espera o commit da primeira e só
   *    então lê `last_sequence`, já incrementado. Duas mensagens simultâneas
   *    nunca recebem o mesmo número.
   * 2. **Sem buraco.** O `SELECT` seguinte roda na mesma transação e enxerga a
   *    própria escrita. Se a transação falhar depois, o incremento volta atrás
   *    junto com a mensagem — o número não fica queimado.
   * 3. **Ordem estável.** O par `(conversation_id, sequence)` tem unique
   *    natural no schema, então mesmo um erro de programação vira violação de
   *    índice em vez de duas mensagens com o mesmo lugar na conversa.
   *
   * O preço é serializar as escritas de uma mesma conversa. É o preço correto:
   * "a mensagem seguinte" é, por definição, uma decisão sequencial.
   */
  static async nextSequence(tx: TransactionExecutor, conversationId: string): Promise<number> {
    const at = new Date();

    await tx
      .update(conversations)
      .set({
        lastSequence: sql`${conversations.lastSequence} + 1`,
        messageCount: sql`${conversations.messageCount} + 1`,
        lastMessageAt: at,
        updatedAt: at,
        version: sql`${conversations.version} + 1`,
      })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)));

    const rows = await tx
      .select({ lastSequence: conversations.lastSequence })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    const sequence = rows[0]?.lastSequence;

    if (sequence === undefined) {
      // A conversa sumiu entre o guarda da rota e esta transação. Abortar aqui
      // desfaz o incremento junto.
      throw new Error(`A conversa ${conversationId} não existe mais.`);
    }

    return sequence;
  }

  /**
   * Grava mensagem, partes, referências de contexto e o evento — tudo em uma
   * transação (`Docs/08`).
   */
  async create(input: {
    organizationId: string;
    projectId: string | null;
    conversationId: string;
    authorType: 'user' | 'agent' | 'system';
    authorUserId: string | null;
    authorAgentRunId: string | null;
    status: 'complete';
    parts: readonly Omit<MessagePartRow, 'id' | 'messageId'>[];
    contextRefs: readonly Omit<ContextRefRow, 'id' | 'messageId'>[];
    dedupeKey: string | null;
    onCommitted: (
      tx: TransactionExecutor,
      created: { messageId: string; sequence: number },
    ) => Promise<void>;
  }): Promise<{ messageId: string; sequence: number }> {
    const messageId = newId();

    return this.db.transaction(async (tx) => {
      // Primeiro o número: ele toma o lock da conversa e define a ordem em que
      // escritas concorrentes vão acontecer daqui para a frente.
      const sequence = await MessageRepository.nextSequence(tx, input.conversationId);
      const createdAt = new Date();

      await tx.insert(messages).values({
        id: messageId,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        authorType: input.authorType,
        authorUserId: input.authorUserId,
        authorAgentRunId: input.authorAgentRunId,
        status: input.status,
        sequence,
        createdAt,
        updatedAt: createdAt,
      });

      if (input.parts.length > 0) {
        await tx.insert(messageParts).values(
          input.parts.map((part) => ({
            id: newId(),
            organizationId: input.organizationId,
            messageId,
            sequence: part.sequence,
            type: part.type,
            content: part.content,
            payload: part.payload,
            toolName: part.toolName,
            createdAt,
          })),
        );
      }

      if (input.contextRefs.length > 0) {
        await tx.insert(messageContextRefs).values(
          input.contextRefs.map((ref) => ({
            id: newId(),
            organizationId: input.organizationId,
            messageId,
            refType: ref.refType,
            refId: ref.refId,
            label: ref.label,
            createdAt,
          })),
        );
      }

      await input.onCommitted(tx, { messageId, sequence });

      return { messageId, sequence };
    });
  }

  /**
   * Mensagem já criada com a mesma chave de idempotência.
   *
   * O rastro é o próprio outbox: `dedupe_key` tem unique natural lá, e
   * `aggregate_id`/`payload` levam de volta à mensagem. Isso evita uma segunda
   * tabela só para lembrar de comandos repetidos.
   */
  async findByIdempotencyKey(dedupeKey: string): Promise<string | undefined> {
    const rows = await this.db
      .select({ payload: outboxMessages.payload })
      .from(outboxMessages)
      .where(eq(outboxMessages.dedupeKey, dedupeKey))
      .limit(1);

    const messageId = rows[0]?.payload['messageId'];

    return typeof messageId === 'string' ? messageId : undefined;
  }

  async findById(messageId: string): Promise<MessageRow | undefined> {
    const rows = await this.db
      .select({
        ...messageColumns,
        authorName: users.displayName,
        authorEmail: users.email,
        authorAvatarUrl: users.avatarUrl,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .limit(1);

    return rows[0];
  }

  /**
   * Página de mensagens de uma conversa.
   *
   * A ordenação é por `sequence`, não por `created_at`: é o índice
   * `(conversation_id, sequence)` do `Docs/07`, e a sequência é o único critério
   * que não empata. `afterSequence` atende a retomada depois de perder a janela
   * do WebSocket — daí a leitura crescente.
   */
  async listForConversation(input: {
    conversationId: string;
    limit: number;
    afterSequence: number | undefined;
    cursorSequence: number | undefined;
    authorType: 'user' | 'agent' | 'system' | undefined;
  }): Promise<MessageRow[]> {
    const ascending = input.afterSequence !== undefined;
    const conditions = [
      eq(messages.conversationId, input.conversationId),
      isNull(messages.deletedAt),
    ];

    if (input.authorType !== undefined) {
      conditions.push(eq(messages.authorType, input.authorType));
    }

    if (ascending) {
      conditions.push(gt(messages.sequence, input.afterSequence ?? 0));

      if (input.cursorSequence !== undefined) {
        conditions.push(gt(messages.sequence, input.cursorSequence));
      }
    } else if (input.cursorSequence !== undefined) {
      conditions.push(lt(messages.sequence, input.cursorSequence));
    }

    return this.db
      .select({
        ...messageColumns,
        authorName: users.displayName,
        authorEmail: users.email,
        authorAvatarUrl: users.avatarUrl,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(and(...conditions))
      .orderBy(ascending ? asc(messages.sequence) : desc(messages.sequence))
      .limit(input.limit + 1);
  }

  async partsOf(messageIds: string[]): Promise<Map<string, MessagePartRow[]>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({
        id: messageParts.id,
        messageId: messageParts.messageId,
        sequence: messageParts.sequence,
        type: messageParts.type,
        content: messageParts.content,
        payload: messageParts.payload,
        toolName: messageParts.toolName,
      })
      .from(messageParts)
      .where(inArray(messageParts.messageId, messageIds))
      .orderBy(asc(messageParts.messageId), asc(messageParts.sequence));

    return groupBy(rows, (row) => row.messageId);
  }

  async contextRefsOf(messageIds: string[]): Promise<Map<string, ContextRefRow[]>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({
        id: messageContextRefs.id,
        messageId: messageContextRefs.messageId,
        refType: messageContextRefs.refType,
        refId: messageContextRefs.refId,
        label: messageContextRefs.label,
      })
      .from(messageContextRefs)
      .where(inArray(messageContextRefs.messageId, messageIds));

    return groupBy(rows, (row) => row.messageId);
  }

  /** Sequência de uma mensagem, para montar o cursor a partir do ID. */
  async sequenceOf(messageId: string): Promise<number | undefined> {
    const rows = await this.db.execute<{ sequence: number }>(
      sql`select sequence from messages where id = ${messageId} limit 1`,
    );

    return firstRow<{ sequence: number }>(rows)?.sequence;
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const list = grouped.get(key(row)) ?? [];

    list.push(row);
    grouped.set(key(row), list);
  }

  return grouped;
}
