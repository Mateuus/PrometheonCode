// Fila `knowledge-indexing` — reindexação de um item de conhecimento.
//
// ESTADO: estrutura completa, efeito pendente da API.
//
// O que já vale aqui: validação, resolução do item e da versão corrente,
// idempotência por item + motivo dentro da janela da fila (quem pede a
// reindexação usa `jobId` determinístico; quando o conteúdo muda de novo, o
// motivo vem com a mudança), correlação e métricas. `reason: 'deleted'` é o
// único caso que não exige o item existir —
// remover do índice o que já sumiu do banco é justamente o ponto.
//
// PENDENTE DA API — falta ligar:
//
// 1. o mecanismo de busca em si (índice invertido ou vetorial); o `Docs/10`
//    trata o Vault Markdown como fonte da verdade e o índice como derivado,
//    então reconstruir sempre precisa ser possível;
// 2. o chunking do conteúdo da versão corrente, respeitando o orçamento de
//    contexto;
// 3. a marcação de "indexado em" — o schema ainda não tem coluna para isso, e
//    inventá-la aqui seria mudar `packages/database` por um efeito colateral.

import { and, eq } from 'drizzle-orm';

import { knowledgeItems } from '@prometheon/database';

import { PermanentJobError } from '../../errors.js';
import { knowledgeIndexingJobSchema } from '../payloads.js';
import type { JobHandler } from '../runtime.js';

export const knowledgeIndexingHandler: JobHandler<typeof knowledgeIndexingJobSchema> = {
  queue: 'knowledge-indexing',
  schema: knowledgeIndexingJobSchema,
  idempotencyKey: (data) => `${data.knowledgeItemId}:${data.reason}`,
  async run({ data, deps, logger }) {
    const [item] = await deps.db
      .select({
        id: knowledgeItems.id,
        projectId: knowledgeItems.projectId,
        status: knowledgeItems.status,
        currentVersionId: knowledgeItems.currentVersionId,
        path: knowledgeItems.path,
        deletedAt: knowledgeItems.deletedAt,
      })
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.id, data.knowledgeItemId),
          eq(knowledgeItems.organizationId, data.organizationId),
        ),
      )
      .limit(1);

    if (data.reason === 'deleted') {
      logger.info(
        { knowledgeItemId: data.knowledgeItemId },
        'remoção do índice pendente da API',
      );
      return {
        status: 'pending-api',
        details: {
          knowledgeItemId: data.knowledgeItemId,
          pending: 'remoção do índice de busca',
        },
      };
    }

    if (item === undefined) {
      throw new PermanentJobError('Item de conhecimento inexistente.', {
        code: 'KNOWLEDGE_ITEM_NOT_FOUND',
        details: { knowledgeItemId: data.knowledgeItemId },
      });
    }

    if (item.deletedAt !== null) {
      return {
        status: 'skipped',
        details: { knowledgeItemId: item.id, reason: 'item apagado' },
      };
    }

    if (item.currentVersionId === null) {
      // Item sem versão corrente ainda não tem conteúdo para indexar. Isso
      // acontece entre a criação e a primeira gravação de versão: transitório
      // pelo tempo de vida do job, mas não é erro — vale pular.
      return {
        status: 'skipped',
        details: { knowledgeItemId: item.id, reason: 'sem versão corrente' },
      };
    }

    logger.info(
      {
        knowledgeItemId: item.id,
        projectId: item.projectId,
        versionId: item.currentVersionId,
        reason: data.reason,
      },
      'item resolvido; indexação pendente da API',
    );

    return {
      status: 'pending-api',
      details: {
        knowledgeItemId: item.id,
        versionId: item.currentVersionId,
        pending: 'mecanismo de busca do Hub',
      },
    };
  },
};
