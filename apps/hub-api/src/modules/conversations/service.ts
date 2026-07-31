/**
 * Regras de conversa.
 *
 * A conversa do Web Chat nasce dentro de um projeto e com quem a criou como
 * participante. O `Docs/09` é claro: o Local Chat não sincroniza sozinho — o
 * campo `origin` registra que o conteúdo veio de uma decisão explícita do
 * usuário (`local_import` é o "Copy to Web Chat" do `Docs/10`).
 */

import type { Conversation, CreateConversationRequest } from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { buildPage, type CursorPage } from '../../shared/cursor.js';
import { toIso, toIsoOrNull } from '../../shared/time.js';
import { ProjectRepository } from '../projects/repository.js';
import type { ProjectRow } from '../projects/types.js';
import { conversationNotFound } from './errors.js';
import { ConversationRepository, type ConversationListFilters } from './repository.js';
import type { ConversationRow, ParticipantRow } from './types.js';

export interface ConversationServiceDeps {
  readonly db: Database;
}

export class ConversationService {
  private readonly repository: ConversationRepository;
  private readonly projects: ProjectRepository;

  constructor(deps: ConversationServiceDeps) {
    this.repository = new ConversationRepository(deps.db);
    this.projects = new ProjectRepository(deps.db);
  }

  async list(input: {
    projectId: string;
    limit: number;
    cursor: string | undefined;
    filters: ConversationListFilters;
  }): Promise<CursorPage<Conversation>> {
    const rows = await this.repository.listForProject(input);
    const page = buildPage(rows, input.limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    const participants = await this.repository.participantsOf(
      page.items.map((row) => row.id),
    );

    return {
      items: page.items.map((row) =>
        toConversationView(row, participants.get(row.id) ?? []),
      ),
      pageInfo: page.pageInfo,
    };
  }

  async get(conversationId: string): Promise<Conversation> {
    const row = await this.repository.findById(conversationId);

    if (row === undefined) {
      throw conversationNotFound();
    }

    const participants = await this.repository.participantsOf([conversationId]);

    return toConversationView(row, participants.get(conversationId) ?? []);
  }

  /** Linha crua, para o módulo de mensagens conferir estado e organização. */
  async findRow(conversationId: string): Promise<ConversationRow> {
    const row = await this.repository.findById(conversationId);

    if (row === undefined) {
      throw conversationNotFound();
    }

    return row;
  }

  async create(input: {
    project: ProjectRow;
    createdBy: string;
    request: CreateConversationRequest;
  }): Promise<Conversation> {
    const settings = await this.projects.findSettings(input.project.id);

    // Perfil de agente inexistente ou de outra organização é descartado em
    // silêncio? Não: ele simplesmente não entra na conversa, e a resposta mostra
    // quem de fato entrou — o cliente compara o que pediu com o que recebeu.
    const agentProfileIds = await this.repository.existingAgentProfileIds(
      input.project.organizationId,
      input.request.agentProfileIds,
    );

    const conversationId = await this.repository.create({
      organizationId: input.project.organizationId,
      projectId: input.project.id,
      title: input.request.title ?? 'Untitled conversation',
      origin: input.request.origin,
      workMode: input.request.workMode ?? settings?.defaultWorkMode ?? 'plan',
      // A conversa herda a visibilidade do projeto: um projeto privado não pode
      // ter conversa visível para a organização inteira.
      visibility: input.project.visibility === 'private' ? 'private' : 'project',
      createdBy: input.createdBy,
      agentProfileIds,
    });

    return this.get(conversationId);
  }
}

export function toConversationView(
  row: ConversationRow,
  participants: ParticipantRow[],
): Conversation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    // O contrato exige projeto; as rotas deste módulo só criam conversa dentro
    // de um, e a listagem parte sempre de `:projectId`.
    projectId: row.projectId ?? '',
    title: row.title,
    status: row.status,
    origin: row.origin,
    workMode: row.workMode,
    participants: participants.map((participant) => ({
      id: participant.id,
      kind: participant.participantType,
      user:
        participant.participantType === 'user' && participant.userName !== null
          ? {
              id: participant.participantId,
              name: participant.userName,
              email: participant.userEmail ?? '',
              avatarUrl: participant.userAvatarUrl,
            }
          : null,
      agentProfileId: participant.participantType === 'agent' ? participant.participantId : null,
      joinedAt: toIso(participant.joinedAt ?? participant.createdAt),
    })),
    lastSequence: row.lastSequence,
    lastMessageAt: toIsoOrNull(row.lastMessageAt),
    messageCount: row.messageCount,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    createdBy: row.createdBy ?? row.id,
    version: row.version,
  };
}
