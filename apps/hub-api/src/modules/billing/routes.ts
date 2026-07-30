/**
 * Rotas de plano e assinatura.
 *
 * | Rota                                        | Permissão             | Quem passa    |
 * | ------------------------------------------- | --------------------- | ------------- |
 * | `GET  /admin/plans`                         | `organization.manage` | owner e admin |
 * | `GET  /organizations/:orgId/subscription`   | `chat.read`           | todo membro   |
 * | `PUT  /organizations/:orgId/plan`           | `organization.manage` | owner e admin |
 *
 * A leitura da assinatura é aberta a todo membro de propósito: o teto do plano
 * é o que explica por que uma criação falhou, e esconder isso de quem esbarra
 * no limite só gera chamado. Já a lista administrativa de planos e a troca são
 * de administrador — trocar o plano muda o que a organização inteira pode fazer.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import {
  billingErrorResponses,
  changePlanRequestSchema,
  organizationParamsSchema,
  planChangeEnvelope,
  planListEnvelope,
  subscriptionOverviewEnvelope,
} from './schemas.js';
import type { BillingService } from './service.js';

export interface BillingRoutesOptions {
  readonly service: BillingService;
}

// Plugin síncrono: registrar rota não espera nada. `FastifyPluginCallbackZod`
// é a forma que o Fastify oferece para isso — `async` sem `await` só
// esconderia que não há trabalho assíncrono aqui.
export const billingRoutes: FastifyPluginCallbackZod<BillingRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  app.get(
    '/admin/plans',
    {
      preHandler: app.requirePermission('organization.manage', { resourceType: 'subscription' }),
      schema: {
        tags: ['billing'],
        summary: 'List the plans available for subscription',
        description: 'Administrative view. Inactive plans are hidden.',
        security: [{ bearerAuth: [] }],
        response: { 200: planListEnvelope, ...billingErrorResponses },
      },
    },
    async (request) => ok(request, { plans: await service.listPlans() }),
  );

  app.get(
    '/organizations/:orgId/subscription',
    {
      preHandler: app.requirePermission('chat.read', { resourceType: 'subscription' }),
      schema: {
        tags: ['billing'],
        summary: 'Current plan, limits and measured usage',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        response: { 200: subscriptionOverviewEnvelope, ...billingErrorResponses },
      },
    },
    async (request) => ok(request, await service.overview(request.params.orgId)),
  );

  app.put(
    '/organizations/:orgId/plan',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('organization.manage', { resourceType: 'subscription' }),
      schema: {
        tags: ['billing'],
        summary: 'Change the plan of an organization',
        description:
          'Optimistic concurrency: send the organization version you read. ' +
          'Downgrades are refused while the current usage exceeds the new limits.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: changePlanRequestSchema,
        response: { 200: planChangeEnvelope, ...billingErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const result = await service.changePlan({
        organizationId: request.params.orgId,
        planCode: request.body.planCode,
        version: request.body.version,
        actorId: auth.userId,
      });

      const origin = requestOrigin(request);

      // Trocar o plano muda os limites de toda a organização: é exatamente o
      // tipo de ação que o `Docs/09` manda auditar.
      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'subscription.plan_changed',
        resourceType: 'subscription',
        resourceId: request.params.orgId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: {
          previousPlanCode: result.previousPlanCode,
          planCode: result.plan.code,
        },
      });

      return ok(request, {
        subscription: result.subscription,
        plan: result.plan,
        changedBy: {
          id: auth.userId,
          name: auth.displayName,
          email: auth.email,
          avatarUrl: null,
        },
        previousPlanCode: result.previousPlanCode,
      });
    },
  );

  done();
};
