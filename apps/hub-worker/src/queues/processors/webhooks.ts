// Fila `webhooks` — processa uma entrega de webhook Git já persistida.
//
// ESTADO: estrutura completa, efeito pendente da API.
//
// O que já vale aqui: validação do payload, deduplicação pelo
// `externalDeliveryId` (que é a chave natural do provedor e vira o `jobId`
// determinístico), verificação de que a entrega existe e ainda não foi
// processada, correlação, métricas e classificação da falha.
//
// PENDENTE DA API — quando `apps/hub-api` expuser o domínio de integrações,
// falta ligar aqui:
//
// 1. interpretar o payload por provedor (push, pull request, review, comment);
// 2. casar o repositório com `project_repositories` e resolver o projeto;
// 3. aplicar o efeito de domínio (mover tarefa, abrir review, anexar artefato);
// 4. gravar a mudança e o evento `git.webhook.processed` na MESMA transação,
//    via `enqueueOutboxMessage` — é isso que faz o evento chegar ao WebSocket;
// 5. marcar `webhook_deliveries.status = 'processed'` e `processed_at`.
//
// A assinatura já foi conferida na borda HTTP (`signature_valid`): entrega com
// assinatura inválida é descartada lá, não aqui.

import { webhookDeliveries } from '@prometheon/database';

import { PermanentJobError } from '../../errors.js';
import { webhookJobSchema } from '../payloads.js';
import type { JobHandler } from '../runtime.js';

export const webhooksHandler: JobHandler<typeof webhookJobSchema> = {
  queue: 'webhooks',
  schema: webhookJobSchema,
  // O provedor reenvia a mesma entrega quando não recebe 2xx: a chave é dele.
  idempotencyKey: (data) => `${data.provider}:${data.externalDeliveryId}`,
  async run({ data, deps, logger }) {
    const delivery = await deps.db.manager
      .createQueryBuilder(webhookDeliveries, 'delivery')
      .select([
        'delivery.id',
        'delivery.status',
        'delivery.signatureValid',
        'delivery.gitRepositoryId',
        'delivery.eventType',
      ])
      .where('delivery.id = :deliveryId', { deliveryId: data.deliveryId })
      .andWhere('delivery.organizationId = :organizationId', {
        organizationId: data.organizationId,
      })
      .limit(1)
      .getOne();

    if (delivery === null) {
      // A linha é gravada pela borda HTTP antes de enfileirar. Não existir
      // significa payload errado ou entrega já removida pela retenção.
      throw new PermanentJobError('Entrega de webhook inexistente.', {
        code: 'WEBHOOK_DELIVERY_NOT_FOUND',
        details: { deliveryId: data.deliveryId },
      });
    }

    if (!delivery.signatureValid) {
      throw new PermanentJobError('Entrega com assinatura inválida não é processada.', {
        code: 'WEBHOOK_SIGNATURE_INVALID',
        details: { deliveryId: data.deliveryId },
      });
    }

    if (delivery.status === 'processed' || delivery.status === 'skipped') {
      return {
        status: 'skipped',
        details: { deliveryId: delivery.id, deliveryStatus: delivery.status },
      };
    }

    logger.info(
      {
        deliveryId: delivery.id,
        provider: data.provider,
        eventType: delivery.eventType,
        gitRepositoryId: delivery.gitRepositoryId,
      },
      'webhook validado; efeito de domínio pendente da API',
    );

    return {
      status: 'pending-api',
      details: {
        deliveryId: delivery.id,
        pending: 'domínio de integrações Git em apps/hub-api',
      },
    };
  },
};
