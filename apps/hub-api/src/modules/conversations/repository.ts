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
  runInTransaction,
  users,
  type Database,
} from '@prometheon/database';

import { decodeCursor } from '../../shared/cursor.js';
import { applyKeyset, escapeLike } from '../../shared/query.js';
import type { ConversationRow, ParticipantRow } from './types.js';

/** Colunas que o contrato de conversa expõe. Lista explícita: nada de `SELECT *`. */
const CONVERSATION_COLUMNS = [
  'id',
  'organizationId',
  'projectId',
  'title',
  'origin',
  'status',
  'visibility',
  'workMode',
  'lastSequence',
  'messageCount',
  'lastMessageAt',
  'createdAt',
  'updatedAt',
  'createdBy',
  'version',
] as const;

/** Colunas do participante, com o alias que o contrato espera. */
const PARTICIPANT_COLUMNS: readonly (readonly [string, string])[] = [
  ['participant.id', 'id'],
  ['participant.conversationId', 'conversationId'],
  ['participant.participantType', 'participantType'],
  ['participant.participantId', 'participantId'],
  ['participant.role', 'role'],
  ['participant.joinedAt', 'joinedAt'],
  ['participant.createdAt', 'createdAt'],
  ['member.displayName', 'userName'],
  ['member.email', 'userEmail'],
  ['member.avatarUrl', 'userAvatarUrl'],
  ['profile.id', 'agentProfileId'],
];

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
    const query = this.db.manager
      .createQueryBuilder(conversations, 'conversation')
      .select(CONVERSATION_COLUMNS.map((column) => `conversation.${column}`))
      .where('conversation.projectId = :projectId', { projectId: input.projectId })
      .andWhere('conversation.deletedAt IS NULL');

    applyKeyset(query, 'conversation', { createdAt: 'createdAt', id: 'id' }, after);

    if (input.filters.status !== undefined) {
      query.andWhere('conversation.status = :status', { status: input.filters.status });
    }

    if (input.filters.origin !== undefined) {
      query.andWhere('conversation.origin = :origin', { origin: input.filters.origin });
    }

    if (input.filters.search !== undefined && input.filters.search !== '') {
      query.andWhere('conversation.title LIKE :search', {
        search: `%${escapeLike(input.filters.search)}%`,
      });
    }

    return query
      .orderBy('conversation.createdAt', 'DESC')
      .addOrderBy('conversation.id', 'DESC')
      .limit(input.limit + 1)
      .getMany();
  }

  async findById(conversationId: string): Promise<ConversationRow | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(conversations, 'conversation')
      .select(CONVERSATION_COLUMNS.map((column) => `conversation.${column}`))
      .where('conversation.id = :conversationId', { conversationId })
      .andWhere('conversation.deletedAt IS NULL')
      .getOne();

    return row ?? undefined;
  }

  /**
   * Participantes de um conjunto de conversas.
   *
   * `participant_id` é referência polimórfica (usuário ou perfil de agente),
   * então o nome sai de um `LEFT JOIN` com cada tabela e o tipo decide qual dos
   * dois lados vale. Como o resultado mistura colunas de três tabelas, a leitura
   * é crua, com alias explícito por coluna.
   */
  async participantsOf(conversationIds: string[]): Promise<Map<string, ParticipantRow[]>> {
    if (conversationIds.length === 0) {
      return new Map();
    }

    const query = this.db.manager
      .createQueryBuilder(conversationParticipants, 'participant')
      .select([])
      .leftJoin(
        users.options.name,
        'member',
        "member.id = participant.participantId AND participant.participantType = 'user'",
      )
      .leftJoin(
        agentProfiles.options.name,
        'profile',
        "profile.id = participant.participantId AND participant.participantType = 'agent'",
      )
      .where('participant.conversationId IN (:...conversationIds)', { conversationIds })
      .andWhere('participant.leftAt IS NULL')
      .orderBy('participant.createdAt', 'ASC');

    for (const [column, alias] of PARTICIPANT_COLUMNS) {
      query.addSelect(column, alias);
    }

    const rows = await query.getRawMany<ParticipantRow>();
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

    const rows = await this.db.manager
      .createQueryBuilder(agentProfiles, 'profile')
      .select('profile.id')
      .where('profile.organizationId = :organizationId', { organizationId })
      .andWhere('profile.id IN (:...agentProfileIds)', { agentProfileIds })
      .getMany();

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

    await runInTransaction(this.db, async (tx) => {
      await tx.insert(conversations, {
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

      await tx.insert(conversationParticipants, [
        {
          id: newId(),
          organizationId: input.organizationId,
          conversationId,
          participantType: 'user' as const,
          participantId: input.createdBy,
          role: 'owner' as const,
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
    await this.db.manager
      .createQueryBuilder()
      .insert()
      .into(conversationParticipants)
      .values({
        id: newId(),
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        participantType: 'user',
        participantId: input.userId,
        role: 'member',
        joinedAt: new Date(),
        // `left_at` entra explicitamente como nulo para que o
        // `ON DUPLICATE KEY UPDATE left_at = VALUES(left_at)` abaixo tenha o que
        // reescrever: quem já saiu da conversa e volta a escrever nela volta a
        // constar como participante.
        leftAt: null,
      })
      // O unique natural `(conversation_id, participant_type, participant_id)`
      // resolve a corrida: duas escritas simultâneas do mesmo usuário não criam
      // duas linhas, e a segunda não precisa falhar.
      .orUpdate(['left_at'])
      .execute();
  }
}
