/**
 * Rotas da administração da plataforma.
 *
 * | Rota                                          | Quem passa           |
 * | --------------------------------------------- | -------------------- |
 * | `GET   /admin/plans`                          | admin da plataforma  |
 * | `POST  /admin/plans`                          | admin da plataforma  |
 * | `PATCH /admin/plans/:planCode`                | admin da plataforma  |
 * | `GET   /admin/organizations`                  | admin da plataforma  |
 * | `GET   /admin/organizations/:orgId`           | admin da plataforma  |
 * | `PUT   /admin/organizations/:orgId/plan`      | admin da plataforma  |
 * | `PATCH /admin/organizations/:orgId/limits`    | admin da plataforma  |
 *
 * Todas passam por `requirePlatformAdmin`, e não por `requirePermission`: a
 * tabela de permissões descreve o que um papel faz dentro de uma organização, e
 * o que se faz aqui é justamente atravessar todas elas. Deixar isso com
 * `organization.manage` significaria que qualquer dono de organização edita o
 * próprio teto — que é o mesmo que não ter teto.
 *
 * Tudo o que muda plano ou limite deixa rastro com o ator, o antes e o depois:
 * a atribuição é manual nesta fase, e um registro manual sem rastro é o tipo de
 * coisa que ninguém consegue explicar seis meses depois.
 *
 * O rastro vai para dois lugares diferentes, e não por inconsistência:
 * `audit_logs` é por organização (a coluna é obrigatória e tem chave
 * estrangeira), então o que acontece **dentro** de um tenant — plano atribuído,
 * limite liberado — entra lá. Criar e editar plano não pertence a organização
 * nenhuma; isso vai para o log estruturado do processo, com o ator identificado.
 */

import { child } from '@prometheon/logger';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import {
  adminErrorResponses,
  adminOrganizationEnvelope,
  adminOrganizationListQuerySchema,
  adminOrganizationPageEnvelope,
  assignPlanRequestSchema,
  createPlanRequestSchema,
  organizationLimitOverridesSchema,
  organizationParamsSchema,
  planEnvelope,
  planListEnvelope,
  planParamsSchema,
  updatePlanRequestSchema,
} from './schemas.js';
import type { AdminService } from './service.js';

export interface AdminRoutesOptions {
  readonly service: AdminService;
}

const logger = child('admin');

// Plugin síncrono: registrar rota não espera nada.
export const adminRoutes: FastifyPluginCallbackZod<AdminRoutesOptions> = (app, options, done) => {
  const { service } = options;

  app.get(
    '/admin/plans',
    {
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'List every plan, including the hidden ones',
        security: [{ bearerAuth: [] }],
        response: { 200: planListEnvelope, ...adminErrorResponses },
      },
    },
    async (request) => ok(request, { plans: await service.listPlans() }),
  );

  app.post(
    '/admin/plans',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'Create a plan',
        description: 'A limit of `null` means unlimited.',
        security: [{ bearerAuth: [] }],
        body: createPlanRequestSchema,
        response: { 201: planEnvelope, ...adminErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const plan = await service.createPlan(request.body);

      logger.info(
        { actorId: auth.userId, actor: auth.email, planCode: plan.code, limits: plan.limits },
        'plan created',
      );

      void reply.code(201);

      return ok(request, { plan });
    },
  );

  app.patch(
    '/admin/plans/:planCode',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'Change the name, price, limits or features of a plan',
        description:
          'Only the fields present in the body change. A limit of `null` means unlimited. ' +
          'The plan code cannot change: it is what organizations point to.',
        security: [{ bearerAuth: [] }],
        params: planParamsSchema,
        body: updatePlanRequestSchema,
        response: { 200: planEnvelope, ...adminErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const plan = await service.updatePlan(request.params.planCode, request.body);

      logger.info(
        { actorId: auth.userId, actor: auth.email, planCode: plan.code, changes: request.body },
        'plan updated',
      );

      return ok(request, { plan });
    },
  );

  app.get(
    '/admin/organizations',
    {
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'List organizations with plan, limits and measured usage',
        security: [{ bearerAuth: [] }],
        querystring: adminOrganizationListQuerySchema,
        response: { 200: adminOrganizationPageEnvelope, ...adminErrorResponses },
      },
    },
    async (request) =>
      ok(
        request,
        await service.listOrganizations({
          limit: request.query.limit,
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.search === undefined ? {} : { search: request.query.search }),
          ...(request.query.planCode === undefined ? {} : { planCode: request.query.planCode }),
        }),
      ),
  );

  app.get(
    '/admin/organizations/:orgId',
    {
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'One organization, with the limits that actually apply',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        response: { 200: adminOrganizationEnvelope, ...adminErrorResponses },
      },
    },
    async (request) =>
      ok(request, { organization: await service.getOrganization(request.params.orgId) }),
  );

  app.put(
    '/admin/organizations/:orgId/plan',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'Assign a plan to an organization',
        description:
          'Manual assignment. Downgrades are refused while the current usage exceeds the ' +
          'new limits, unless `allowOverLimit` is sent.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: assignPlanRequestSchema,
        response: { 200: adminOrganizationEnvelope, ...adminErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const result = await service.assignPlan({
        organizationId: request.params.orgId,
        planCode: request.body.planCode,
        allowOverLimit: request.body.allowOverLimit,
      });

      const origin = requestOrigin(request);

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
          planCode: result.organization.planCode,
          byPlatformAdmin: true,
          allowOverLimit: request.body.allowOverLimit,
        },
      });

      return ok(request, { organization: result.organization });
    },
  );

  app.patch(
    '/admin/organizations/:orgId/limits',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePlatformAdmin,
      schema: {
        tags: ['admin'],
        summary: 'Raise or restore the limits of a single organization',
        description:
          'Only the fields present in the body change. `null` gives the limit back to the ' +
          'plan; `0` means unlimited.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: organizationLimitOverridesSchema,
        response: { 200: adminOrganizationEnvelope, ...adminErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const organization = await service.updateLimits(request.params.orgId, request.body);
      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'admin.limits_changed',
        resourceType: 'organization',
        resourceId: request.params.orgId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { overrides: request.body, effective: organization.limits },
      });

      return ok(request, { organization });
    },
  );

  done();
};
