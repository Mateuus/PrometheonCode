// Fila `context-summarization` — resumo de camada de contexto (`Docs/10`).
//
// ESTADO: estrutura completa, efeito pendente da API.
//
// O que já vale aqui: validação, verificação de que a conversa existe e não foi
// apagada, resolução do ponto de corte (`upToMessageId` ou a última mensagem
// completa), idempotência por conversa + camada + corte — dois pedidos de
// resumo do mesmo trecho não gastam duas chamadas de modelo — correlação e
// métricas.
//
// PENDENTE DA API — falta ligar:
//
// 1. o provedor de modelo, que hoje vive no Core local e ainda não tem
//    equivalente no Hub;
// 2. a política de orçamento de contexto (`project_settings.context_budget_tokens`)
//    aplicada à escolha do que entra no resumo;
// 3. a gravação em `conversation_summaries` com `token_count` e o intervalo
//    coberto, junto do evento correspondente na MESMA transação;
// 4. a redaction do que vai para o modelo — o `Docs/11` proíbe despejar prompt
//    completo, e o resumo não pode carregar segredo do repositório.

import { and, desc, eq, isNull } from 'drizzle-orm';

import { conversations, messages } from '@prometheon/database';

import { PermanentJobError } from '../../errors.js';
import { contextSummarizationJobSchema } from '../payloads.js';
import type { JobHandler } from '../runtime.js';

export const contextSummarizationHandler: JobHandler<typeof contextSummarizationJobSchema> = {
  queue: 'context-summarization',
  schema: contextSummarizationJobSchema,
  idempotencyKey: (data) =>
    `${data.conversationId}:${data.layer}:${data.upToMessageId ?? 'head'}`,
  async run({ data, deps, logger }) {
    const [conversation] = await deps.db
      .select({
        id: conversations.id,
        projectId: conversations.projectId,
        status: conversations.status,
        lastSequence: conversations.lastSequence,
        deletedAt: conversations.deletedAt,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, data.conversationId),
          eq(conversations.organizationId, data.organizationId),
        ),
      )
      .limit(1);

    if (conversation === undefined) {
      throw new PermanentJobError('Conversa inexistente para resumo.', {
        code: 'SUMMARY_CONVERSATION_NOT_FOUND',
        details: { conversationId: data.conversationId },
      });
    }

    if (conversation.deletedAt !== null) {
      // Conversa apagada: resumir não faz sentido, e insistir muito menos.
      return {
        status: 'skipped',
        details: { conversationId: conversation.id, reason: 'conversa apagada' },
      };
    }

    // Ponto de corte do resumo: o pedido manda, e na falta dele vale a última
    // mensagem completa da conversa.
    const [boundary] = await deps.db
      .select({ id: messages.id, sequence: messages.sequence })
      .from(messages)
      .where(
        data.upToMessageId != null
          ? eq(messages.id, data.upToMessageId)
          : and(eq(messages.conversationId, conversation.id), isNull(messages.deletedAt)),
      )
      .orderBy(desc(messages.sequence))
      .limit(1);

    if (boundary === undefined) {
      // Conversa sem mensagem alguma: não há o que resumir, e insistir não muda.
      return {
        status: 'skipped',
        details: { conversationId: conversation.id, reason: 'conversa vazia' },
      };
    }

    logger.info(
      {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        layer: data.layer,
        upToSequence: boundary.sequence,
      },
      'resumo delimitado; geração pendente da API',
    );

    return {
      status: 'pending-api',
      details: {
        conversationId: conversation.id,
        layer: data.layer,
        upToMessageId: boundary.id,
        pending: 'provedor de modelo e gravação em conversation_summaries',
      },
    };
  },
};
