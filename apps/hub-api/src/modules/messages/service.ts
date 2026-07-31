/**
 * Regras de mensagem.
 *
 * O `Docs/07` separa a mensagem em duas tabelas e este módulo mantém a
 * separação: `messages` guarda o envelope (autoria, estado, sequência) e
 * `message_parts` guarda as partes ordenadas. As duas são gravadas na mesma
 * transação — junto com o evento do outbox — porque um envelope sem partes não
 * é uma mensagem, é um registro pela metade.
 *
 * A outra regra do `Docs/07` que este módulo aplica: **não salvar raciocínio
 * privado de modelo**. Só o resumo operacional permitido entra, e apenas em
 * mensagem de agente. Ver `toPartRows()`.
 */

import type {
  CreateMessagePart,
  CreateMessageRequest,
  Message,
  MessageContextRef,
  MessagePart,
} from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { buildPage, type CursorPage } from '../../shared/cursor.js';
import { recordMessageCreated } from '../../shared/events.js';
import { toIso } from '../../shared/time.js';
import { conversationClosed } from '../conversations/errors.js';
import type { ConversationRow } from '../conversations/types.js';
import { ConversationRepository } from '../conversations/repository.js';
import {
  agentRunRequired,
  attachmentsNotSupported,
  reasoningSummaryRequiresAgent,
  reasoningSummaryTooLong,
} from './errors.js';
import { MessageRepository } from './repository.js';
import type { ContextRefRow, ContextRefType, MessagePartRow, MessageRow } from './types.js';

/**
 * Teto do resumo operacional, em caracteres.
 *
 * Não é um limite de payload — `longTextSchema` já cuida disso. É a tradução
 * mecânica da regra do `Docs/07`: um resumo operacional cabe em alguns
 * parágrafos; um texto de dezenas de milhares de caracteres chamado de "resumo"
 * é a cadeia de raciocínio bruta com outro nome.
 */
export const REASONING_SUMMARY_MAX_CHARS = 4_000;

/** Referências de contexto do contrato, traduzidas para o enum da coluna. */
const CONTEXT_REF_TYPES: Readonly<Record<MessageContextRef['kind'], ContextRefType>> = {
  file: 'file',
  selection: 'diff',
  knowledge: 'knowledge_item',
  task: 'task',
  conversation: 'graph_node',
  url: 'url',
};

const CONTEXT_REF_KINDS: Readonly<Record<ContextRefType, MessageContextRef['kind']>> = {
  file: 'file',
  diff: 'selection',
  knowledge_item: 'knowledge',
  task: 'task',
  artifact: 'file',
  graph_node: 'conversation',
  commit: 'file',
  url: 'url',
};

export interface MessageServiceDeps {
  readonly db: Database;
}

export interface CreateMessageInput {
  readonly conversation: ConversationRow;
  readonly projectId: string;
  readonly actorUserId: string;
  readonly request: CreateMessageRequest;
}

export class MessageService {
  private readonly repository: MessageRepository;
  private readonly conversations: ConversationRepository;

  constructor(deps: MessageServiceDeps) {
    this.repository = new MessageRepository(deps.db);
    this.conversations = new ConversationRepository(deps.db);
  }

  async list(input: {
    conversationId: string;
    limit: number;
    cursor: string | undefined;
    afterSequence: number | undefined;
    authorType: 'user' | 'agent' | 'system' | undefined;
  }): Promise<CursorPage<Message>> {
    // O cursor de mensagem carrega a sequência no lugar do instante: é ela que
    // ordena a conversa, e é ela que tem índice para isso.
    const cursorSequence =
      input.cursor === undefined ? undefined : decodeSequenceCursor(input.cursor);

    const rows = await this.repository.listForConversation({
      conversationId: input.conversationId,
      limit: input.limit,
      afterSequence: input.afterSequence,
      cursorSequence,
      authorType: input.authorType,
    });

    const page = buildPage(rows, input.limit, (row) => ({
      at: row.sequence,
      id: row.id,
    }));

    const ids = page.items.map((row) => row.id);
    const [parts, contextRefs] = await Promise.all([
      this.repository.partsOf(ids),
      this.repository.contextRefsOf(ids),
    ]);

    return {
      items: page.items.map((row) =>
        toMessageView(row, parts.get(row.id) ?? [], contextRefs.get(row.id) ?? []),
      ),
      pageInfo: page.pageInfo,
    };
  }

  async get(messageId: string): Promise<Message | undefined> {
    const row = await this.repository.findById(messageId);

    if (row === undefined) {
      return undefined;
    }

    const [parts, contextRefs] = await Promise.all([
      this.repository.partsOf([row.id]),
      this.repository.contextRefsOf([row.id]),
    ]);

    return toMessageView(row, parts.get(row.id) ?? [], contextRefs.get(row.id) ?? []);
  }

  /**
   * Publica uma mensagem na conversa.
   *
   * Ordem dos acontecimentos: valida o que o `Docs/07` proíbe, reserva a
   * sequência dentro da transação, grava envelope, partes e contexto, e enfileira
   * `message.created` **na mesma transação**. Nada aqui escreve fora dela.
   */
  async create(input: CreateMessageInput): Promise<Message> {
    if (input.conversation.status !== 'active') {
      throw conversationClosed(input.conversation.status);
    }

    if (input.request.attachmentIds.length > 0) {
      throw attachmentsNotSupported();
    }

    const authorType = input.request.authorType;

    if (authorType === 'agent' && input.request.authorAgentRunId === undefined) {
      throw agentRunRequired();
    }

    const parts = toPartRows(input.request.parts, authorType);
    const contextRefs = toContextRefRows(input.request.contextRefs);

    const dedupeKey =
      input.request.idempotencyKey === undefined
        ? null
        : `message:${input.conversation.id}:${input.request.idempotencyKey}`;

    if (dedupeKey !== null) {
      const known = await this.repository.findByIdempotencyKey(dedupeKey);

      if (known !== undefined) {
        const existing = await this.get(known);

        if (existing !== undefined) {
          return existing;
        }
      }
    }

    // Quem escreve passa a constar como participante. Fora da transação de
    // propósito: falhar aqui não pode desfazer a mensagem, e a linha é
    // idempotente pelo unique natural.
    await this.conversations.ensureParticipant({
      organizationId: input.conversation.organizationId,
      conversationId: input.conversation.id,
      userId: input.actorUserId,
    });

    const created = await this.repository.create({
      organizationId: input.conversation.organizationId,
      projectId: input.projectId,
      conversationId: input.conversation.id,
      authorType,
      authorUserId: input.actorUserId,
      authorAgentRunId: input.request.authorAgentRunId ?? null,
      status: 'complete',
      parts,
      contextRefs,
      dedupeKey,
      onCommitted: async (tx, message) => {
        await recordMessageCreated(tx, {
          organizationId: input.conversation.organizationId,
          projectId: input.projectId,
          conversationId: input.conversation.id,
          messageId: message.messageId,
          sequence: message.sequence,
          authorType,
          status: 'complete',
          dedupeKey,
        });
      },
    });

    const message = await this.get(created.messageId);

    if (message === undefined) {
      // Só acontece se algo apagar a mensagem entre o commit e a leitura.
      throw new Error(`A mensagem ${created.messageId} sumiu logo após ser criada.`);
    }

    return message;
  }
}

/** Cursor de mensagem: a sequência ocupa o lugar do instante. */
function decodeSequenceCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('.');
  const sequence = Number(decoded.slice(0, separator));

  return Number.isSafeInteger(sequence) ? sequence : 0;
}

/**
 * Converte as partes do contrato em linhas de `message_parts`.
 *
 * `reasoning_summary` é o único tipo com regra própria, e são duas:
 *
 * 1. só mensagem de **agente** carrega resumo — uma pessoa não tem raciocínio
 *    de modelo para resumir, então a parte seria conteúdo forjado;
 * 2. o resumo respeita `REASONING_SUMMARY_MAX_CHARS`.
 *
 * As duas juntas são o que impede a rota de virar um depósito de cadeia de
 * raciocínio bruta, que o `Docs/07` proíbe guardar.
 */
export function toPartRows(
  parts: readonly CreateMessagePart[],
  authorType: 'user' | 'agent' | 'system',
): Omit<MessagePartRow, 'id' | 'messageId'>[] {
  return parts.map((part, index) => {
    switch (part.type) {
      case 'text': {
        return row(index, 'text', part.text, null, null);
      }
      case 'reasoning_summary': {
        if (authorType !== 'agent') {
          throw reasoningSummaryRequiresAgent(index);
        }

        if (part.summary.length > REASONING_SUMMARY_MAX_CHARS) {
          throw reasoningSummaryTooLong(REASONING_SUMMARY_MAX_CHARS, index);
        }

        return row(index, 'reasoning_summary', part.summary, null, null);
      }
      case 'tool_call': {
        return row(index, 'tool_call', null, {
          toolCallId: part.toolCallId,
          arguments: part.arguments,
        }, part.toolName);
      }
      case 'tool_result': {
        return row(index, 'tool_result', part.output, {
          toolCallId: part.toolCallId,
          status: part.status,
          result: part.result,
        }, null);
      }
      case 'artifact_reference': {
        return row(index, 'artifact_reference', null, {
          artifactId: part.artifactId,
          kind: part.kind,
          title: part.title,
          byteSize: part.byteSize,
        }, null);
      }
      case 'task_reference': {
        return row(index, 'task_reference', null, {
          taskId: part.taskId,
          relation: part.relation,
        }, null);
      }
      case 'error': {
        return row(index, 'error', part.message, {
          code: part.code,
          retryable: part.retryable,
        }, null);
      }
    }
  });
}

function row(
  sequence: number,
  type: MessagePartRow['type'],
  content: string | null,
  payload: Record<string, unknown> | null,
  toolName: string | null,
): Omit<MessagePartRow, 'id' | 'messageId'> {
  return { sequence, type, content, payload, toolName };
}

function toContextRefRows(
  refs: readonly MessageContextRef[],
): Omit<ContextRefRow, 'id' | 'messageId'>[] {
  return refs.map((ref) => ({
    refType: CONTEXT_REF_TYPES[ref.kind],
    refId: ref.reference,
    label: ref.label,
  }));
}

/**
 * Lê um campo de texto do `payload`.
 *
 * O JSON da coluna é livre e pode ter sido escrito por uma versão anterior do
 * formato. Converter com `String()` transformaria um objeto inesperado em
 * `"[object Object]"` — pior que devolver o padrão, porque parece um valor.
 */
function textField(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];

  return typeof value === 'string' ? value : fallback;
}

/** Reconstrói a parte do contrato a partir da linha gravada. */
export function toPartView(row: MessagePartRow): MessagePart {
  const payload = row.payload ?? {};

  switch (row.type) {
    case 'text': {
      return { index: row.sequence, type: 'text', text: row.content ?? '' };
    }
    case 'reasoning_summary': {
      return { index: row.sequence, type: 'reasoning_summary', summary: row.content ?? '' };
    }
    case 'tool_call': {
      return {
        index: row.sequence,
        type: 'tool_call',
        toolCallId: textField(payload, 'toolCallId', row.id),
        toolName: row.toolName ?? 'unknown',
        arguments: (payload['arguments'] ?? {}) as Record<string, unknown>,
      };
    }
    case 'tool_result': {
      return {
        index: row.sequence,
        type: 'tool_result',
        toolCallId: textField(payload, 'toolCallId', row.id),
        status: (payload['status'] ?? 'ok') as 'ok' | 'error' | 'denied' | 'timeout',
        result: (payload['result'] ?? null) as Record<string, unknown> | null,
        output: row.content,
      };
    }
    case 'artifact_reference': {
      return {
        index: row.sequence,
        type: 'artifact_reference',
        artifactId: textField(payload, 'artifactId', ''),
        kind: (payload['kind'] ?? 'other') as 'diff' | 'file' | 'log' | 'report' | 'other',
        title: textField(payload, 'title', 'artifact'),
        byteSize: Number(payload['byteSize'] ?? 0),
      };
    }
    case 'task_reference': {
      return {
        index: row.sequence,
        type: 'task_reference',
        taskId: textField(payload, 'taskId', ''),
        relation: (payload['relation'] ?? 'mentioned') as
          | 'created'
          | 'updated'
          | 'mentioned'
          | 'blocked_by',
      };
    }
    case 'error': {
      return {
        index: row.sequence,
        type: 'error',
        code: textField(payload, 'code', 'INTERNAL_ERROR'),
        message: row.content ?? '',
        retryable: payload['retryable'] === true,
      };
    }
  }
}

export function toMessageView(
  row: MessageRow,
  parts: readonly MessagePartRow[],
  contextRefs: readonly ContextRefRow[],
): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    organizationId: row.organizationId,
    authorType: row.authorType,
    authorUser:
      row.authorUserId === null || row.authorName === null
        ? null
        : {
            id: row.authorUserId,
            name: row.authorName,
            email: row.authorEmail ?? '',
            avatarUrl: row.authorAvatarUrl,
          },
    authorAgentRunId: row.authorAgentRunId,
    status: row.status,
    sequence: row.sequence,
    parts: parts.map(toPartView),
    contextRefs: contextRefs.map((ref) => ({
      kind: CONTEXT_REF_KINDS[ref.refType],
      reference: ref.refId,
      label: ref.label,
    })),
    // Anexo depende de uma rota de upload que ainda não existe; a lista sai
    // vazia em vez de inventar uma URL de download.
    attachments: [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}
