/**
 * Acesso ao banco do módulo de conversas.
 *
 * Listagem por cursor `(created_at, id)`. A conversa também guarda
 * `last_sequence`, que é o contador consultado — e incrementado — pelo módulo
 * de mensagens dentro da transação de cada envio.
 */

import {
  agentProfiles,
  conversationParticipants,
  conversations,
  newId,
  users,
  type Database,
} from '@prometheon/database';
import { and, desc, eq, inArray, isNull, like, sql, type SQL } from 'drizzle-orm';

import { decodeCursor } from '../../shared/cursor.js';
import { escapeLike, keysetCondition } from '../projects/repository.js';
import type { ConversationRow, ParticipantRow } from './types.js';

const conversationColumns = {
  id: conversations.id,
  organizationId: conversations.organizationId,
  projectId: conversations.projectId,
  title: conversations.title,
  origin: conversations.origin,
  status: conversations.status,
  visibility: conversations.visibility,
  workMode: conversations.workMode,
  lastSequence: conversations.lastSequence,
  messageCount: conversations.messageCount,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  createdBy: conversations.createdBy,
  version: conversations.version,
} as const;

export interface ConversationListFilters {
  readonly status?: 'active' | 'archived' | 'locked' | undefined;
  readonly origin?: 'web' | 'local_import' | 'agent' | undefined;
  readonly search?: string | undefined;
}

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  async listForProject(input: {
    projectId: string;
    limit: number;
    cursor: string | undefined;
    filters: ConversationListFilters;
  }): Promise<ConversationRow[]> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const conditions: (SQL | undefined)[] = [
      eq(conversations.projectId, input.projectId),
      isNull(conversations.deletedAt),
      keysetCondition(conversations.createdAt, conversations.id, after),
    ];

    if (input.filters.status !== undefined) {
      conditions.push(eq(conversations.status, input.filters.status));
    }

    if (input.filters.origin !== undefined) {
      conditions.push(eq(conversations.origin, input.filters.origin));
    }

    if (input.filters.search !== undefined && input.filters.search !== '') {
      conditions.push(like(conversations.title, `%${escapeLike(input.filters.search)}%`));
    }

    return this.db
      .select(conversationColumns)
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(input.limit + 1);
  }

  async findById(conversationId: string): Promise<ConversationRow | undefined> {
    const rows = await this.db
      .select(conversationColumns)
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)))
      .limit(1);

    return rows[0];
  }

  /**
   * Participantes de um conjunto de conversas.
   *
   * `participant_id` é referência polimórfica (usuário ou perfil de agente),
   * então o nome sai de um `LEFT JOIN` com cada tabela e o tipo decide qual dos
   * dois lados vale.
   */
  async participantsOf(conversationIds: string[]): Promise<Map<string, ParticipantRow[]>> {
    if (conversationIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({
        id: conversationParticipants.id,
        conversationId: conversationParticipants.conversationId,
        participantType: conversationParticipants.participantType,
        participantId: conversationParticipants.participantId,
        role: conversationParticipants.role,
        joinedAt: conversationParticipants.joinedAt,
        createdAt: conversationParticipants.createdAt,
        userName: users.displayName,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
        agentProfileId: agentProfiles.id,
      })
      .from(conversationParticipants)
      .leftJoin(
        users,
        and(
          eq(users.id, conversationParticipants.participantId),
          eq(conversationParticipants.participantType, 'user'),
        ),
      )
      .leftJoin(
        agentProfiles,
        and(
          eq(agentProfiles.id, conversationParticipants.participantId),
          eq(conversationParticipants.participantType, 'agent'),
        ),
      )
      .where(
        and(
          inArray(conversationParticipants.conversationId, conversationIds),
          isNull(conversationParticipants.leftAt),
        ),
      )
      .orderBy(conversationParticipants.createdAt);

    const grouped = new Map<string, ParticipantRow[]>();

    for (const row of rows) {
      const list = grouped.get(row.conversationId) ?? [];

      list.push(row);
      grouped.set(row.conversationId, list);
    }

    return grouped;
  }

  /** Perfis de agente que existem na organização, entre os pedidos. */
  async existingAgentProfileIds(
    organizationId: string,
    agentProfileIds: string[],
  ): Promise<string[]> {
    if (agentProfileIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(
        and(
          eq(agentProfiles.organizationId, organizationId),
          inArray(agentProfiles.id, agentProfileIds),
        ),
      );

    return rows.map((row) => row.id);
  }

  /** Cria a conversa com quem a criou já como participante `owner`. */
  async create(input: {
    organizationId: string;
    projectId: string;
    title: string;
    origin: 'web' | 'local_import' | 'agent';
    workMode: 'plan' | 'edit' | 'agent_team';
    visibility: 'private' | 'project' | 'organization';
    createdBy: string;
    agentProfileIds: string[];
  }): Promise<string> {
    const conversationId = newId();
    const createdAt = new Date();

    await this.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: conversationId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        title: input.title,
        origin: input.origin,
        status: 'active',
        visibility: input.visibility,
        workMode: input.workMode,
        createdBy: input.createdBy,
        createdAt,
        updatedAt: createdAt,
      });

      await tx.insert(conversationParticipants).values([
        {
          id: newId(),
          organizationId: input.organizationId,
          conversationId,
          participantType: 'user',
          participantId: input.createdBy,
          role: 'owner',
          joinedAt: createdAt,
        },
        ...input.agentProfileIds.map((agentProfileId) => ({
          id: newId(),
          organizationId: input.organizationId,
          conversationId,
          participantType: 'agent' as const,
          participantId: agentProfileId,
          role: 'member' as const,
          joinedAt: createdAt,
        })),
      ]);
    });

    return conversationId;
  }

  /** Garante que quem escreve na conversa consta como participante. */
  async ensureParticipant(input: {
    organizationId: string;
    conversationId: string;
    userId: string;
  }): Promise<void> {
    await this.db
      .insert(conversationParticipants)
      .values({
        id: newId(),
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        participantType: 'user',
        participantId: input.userId,
        role: 'member',
        joinedAt: new Date(),
      })
      // O unique natural `(conversation_id, participant_type, participant_id)`
      // resolve a corrida: duas escritas simultâneas do mesmo usuário não criam
      // duas linhas, e a segunda não precisa falhar.
      .onDuplicateKeyUpdate({ set: { leftAt: sql`null` } });
  }
}
