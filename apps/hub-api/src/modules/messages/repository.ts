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
  runInTransaction,
  users,
  writable,
  type Database,
  type Message as MessageEntity,
  type MessagePart as MessagePartEntity,
  type TransactionExecutor,
} from '@prometheon/database';
import type { SelectQueryBuilder } from 'typeorm';

import type { MessagePartRow, MessageRow, ContextRefRow } from './types.js';

export type { TransactionExecutor } from '@prometheon/database';

/** Colunas do envelope da mensagem, com o alias que o contrato espera. */
const MESSAGE_COLUMNS: readonly (readonly [string, string])[] = [
  ['message.id', 'id'],
  ['message.organizationId', 'organizationId'],
  ['message.conversationId', 'conversationId'],
  ['message.authorType', 'authorType'],
  ['message.authorUserId', 'authorUserId'],
  ['message.authorAgentRunId', 'authorAgentRunId'],
  ['message.status', 'status'],
  ['message.sequence', 'sequence'],
  ['message.createdAt', 'createdAt'],
  ['message.updatedAt', 'updatedAt'],
  ['author.displayName', 'authorName'],
  ['author.email', 'authorEmail'],
  ['author.avatarUrl', 'authorAvatarUrl'],
];

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
      .createQueryBuilder()
      .update(conversations)
      .set({
        lastSequence: () => 'last_sequence + 1',
        messageCount: () => 'message_count + 1',
        lastMessageAt: at,
        updatedAt: at,
        version: () => 'version + 1',
      })
      .where('id = :conversationId', { conversationId })
      .andWhere('deleted_at IS NULL')
      .execute();

    const rows: { lastSequence: number | string }[] = await tx.query(
      'SELECT last_sequence AS lastSequence FROM conversations WHERE id = ? LIMIT 1',
      [conversationId],
    );

    const sequence = rows[0]?.lastSequence;

    if (sequence === undefined) {
      // A conversa sumiu entre o guarda da rota e esta transação. Abortar aqui
      // desfaz o incremento junto.
      throw new Error(`A conversa ${conversationId} não existe mais.`);
    }

    return Number(sequence);
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

    return runInTransaction(this.db, async (tx) => {
      // Primeiro o número: ele toma o lock da conversa e define a ordem em que
      // escritas concorrentes vão acontecer daqui para a frente.
      const sequence = await MessageRepository.nextSequence(tx, input.conversationId);
      const createdAt = new Date();

      await tx.insert(messages, {
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
        await tx.insert(
          messageParts,
          input.parts.map((part) =>
            writable<MessagePartEntity>({
              id: newId(),
              organizationId: input.organizationId,
              messageId,
              sequence: part.sequence,
              type: part.type,
              content: part.content,
              payload: part.payload,
              toolName: part.toolName,
              createdAt,
            }),
          ),
        );
      }

      if (input.contextRefs.length > 0) {
        await tx.insert(
          messageContextRefs,
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
    const row = await this.db.manager
      .createQueryBuilder(outboxMessages, 'outbox')
      .select('outbox.payload')
      .where('outbox.dedupeKey = :dedupeKey', { dedupeKey })
      .getOne();

    const messageId = row?.payload['messageId'];

    return typeof messageId === 'string' ? messageId : undefined;
  }

  async findById(messageId: string): Promise<MessageRow | undefined> {
    const rows = await this.messageQuery()
      .andWhere('message.id = :messageId', { messageId })
      .limit(1)
      .getRawMany<MessageRow>();

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
    const query = this.messageQuery().andWhere(
      'message.conversation_id = :conversationId',
      { conversationId: input.conversationId },
    );

    if (input.authorType !== undefined) {
      query.andWhere('message.author_type = :authorType', { authorType: input.authorType });
    }

    if (ascending) {
      query.andWhere('message.sequence > :afterSequence', {
        afterSequence: input.afterSequence ?? 0,
      });

      if (input.cursorSequence !== undefined) {
        query.andWhere('message.sequence > :cursorSequence', {
          cursorSequence: input.cursorSequence,
        });
      }
    } else if (input.cursorSequence !== undefined) {
      query.andWhere('message.sequence < :cursorSequence', {
        cursorSequence: input.cursorSequence,
      });
    }

    return query
      .orderBy('message.sequence', ascending ? 'ASC' : 'DESC')
      .limit(input.limit + 1)
      .getRawMany<MessageRow>();
  }

  async partsOf(messageIds: string[]): Promise<Map<string, MessagePartRow[]>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const rows = await this.db.manager
      .createQueryBuilder(messageParts, 'part')
      .select([
        'part.id',
        'part.messageId',
        'part.sequence',
        'part.type',
        'part.content',
        'part.payload',
        'part.toolName',
      ])
      .where('part.messageId IN (:...messageIds)', { messageIds })
      .orderBy('part.messageId', 'ASC')
      .addOrderBy('part.sequence', 'ASC')
      .getMany();

    return groupBy(rows as MessagePartRow[], (row) => row.messageId);
  }

  async contextRefsOf(messageIds: string[]): Promise<Map<string, ContextRefRow[]>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    const rows = await this.db.manager
      .createQueryBuilder(messageContextRefs, 'ref')
      .select(['ref.id', 'ref.messageId', 'ref.refType', 'ref.refId', 'ref.label'])
      .where('ref.messageId IN (:...messageIds)', { messageIds })
      .getMany();

    return groupBy(rows as ContextRefRow[], (row) => row.messageId);
  }

  /** Sequência de uma mensagem, para montar o cursor a partir do ID. */
  async sequenceOf(messageId: string): Promise<number | undefined> {
    const rows: { sequence: number | string }[] = await this.db.query(
      'select sequence from messages where id = ? limit 1',
      [messageId],
    );

    const sequence = rows[0]?.sequence;
    return sequence === undefined ? undefined : Number(sequence);
  }

  /**
   * Base das leituras de mensagem: envelope + autor.
   *
   * É `getRawMany` porque o resultado mistura colunas de duas tabelas — o
   * contrato de mensagem carrega nome, e-mail e avatar de quem escreveu, e uma
   * entidade hidratada não comporta isso sem inventar uma relação que o schema
   * não tem (o autor pode ser um agente, sem linha em `users`).
   */
  private messageQuery(): SelectQueryBuilder<MessageEntity> {
    const query = this.db.manager
      .createQueryBuilder(messages, 'message')
      .select([])
      .leftJoin(users.options.name, 'author', 'author.id = message.authorUserId')
      .where('message.deletedAt IS NULL');

    for (const [column, alias] of MESSAGE_COLUMNS) {
      query.addSelect(column, alias);
    }

    return query;
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
