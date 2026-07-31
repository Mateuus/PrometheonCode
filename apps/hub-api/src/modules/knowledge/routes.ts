/**
 * Rotas de conhecimento (`Docs/06`).
 *
 * | Rota                                          | Permissão            | Quem passa          |
 * | --------------------------------------------- | -------------------- | ------------------- |
 * | `GET  /projects/:projectId/knowledge`          | `chat.read`          | todos os papéis     |
 * | `POST /projects/:projectId/knowledge/proposals`| `knowledge.propose`  | developer para cima |
 * | `GET  /knowledge/:knowledgeId`                 | `chat.read`          | todos os papéis     |
 * | `GET  /knowledge/:knowledgeId/diff`            | `knowledge.review`   | reviewer para cima  |
 * | `POST /knowledge/:knowledgeId/review`          | `knowledge.review`   | reviewer para cima  |
 *
 * A organização de cada rota vem do recurso, não do token: `:projectId` e
 * `:knowledgeId` são resolvidos no banco antes da autorização, para que uma
 * credencial com organização ativa `A` não consiga ler conhecimento da
 * organização `B` só por citar o identificador certo.
 *
 * `GET /knowledge/:knowledgeId/diff` não está na lista do `Docs/06`, e existe
 * por causa do `Docs/10`: revisar sem ver o que mudou em relação à versão
 * vigente é carimbar. O diff traz junto as fontes declaradas, que são a outra
 * metade da decisão.
 */

import { isApiError } from '../../shared/errors.js';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { recordSecurityEvent } from '../../shared/security.js';
import { knowledgeNotFound, projectNotFound } from './errors.js';
import {
  createKnowledgeProposalSchema,
  knowledgeDiffEnvelope,
  knowledgeErrorResponses,
  knowledgeItemEnvelope,
  knowledgeListQuerySchema,
  knowledgePageEnvelope,
  knowledgeParamsSchema,
  knowledgeReviewEnvelope,
  knowledgeReviewRequestSchema,
  projectParamsSchema,
} from './schemas.js';
import { KnowledgeRepository } from './repository.js';
import type { KnowledgeService } from './service.js';

export interface KnowledgeRoutesOptions {
  readonly service: KnowledgeService;
}

// Plugin síncrono: registrar rota não espera nada. `FastifyPluginCallbackZod`
// é a forma que o Fastify oferece para isso — `async` sem `await` só
// esconderia que não há trabalho assíncrono aqui.
export const knowledgeRoutes: FastifyPluginCallbackZod<KnowledgeRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;
  const repository = new KnowledgeRepository(app.db);

  /** Organização dona do projeto citado na rota. */
  const organizationOfProject = async (request: FastifyRequest): Promise<string | null> => {
    const params = request.params as { projectId?: string } | undefined;
    const projectId = params?.projectId;

    if (projectId === undefined) {
      return null;
    }

    const project = await repository.findProject(projectId);

    if (project === undefined) {
      throw projectNotFound();
    }

    return project.organizationId;
  };

  /** Organização dona do item citado na rota. */
  const organizationOfItem = async (request: FastifyRequest): Promise<string | null> => {
    const params = request.params as { knowledgeId?: string } | undefined;
    const knowledgeId = params?.knowledgeId;

    if (knowledgeId === undefined) {
      return null;
    }

    const item = await repository.findItem(knowledgeId);

    if (item === undefined) {
      throw knowledgeNotFound();
    }

    return item.organizationId;
  };

  app.get(
    '/projects/:projectId/knowledge',
    {
      preHandler: app.requirePermission('chat.read', {
        resourceType: 'knowledge',
        resolveOrganizationId: organizationOfProject,
      }),
      schema: {
        tags: ['knowledge'],
        summary: 'List the knowledge of a project',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        querystring: knowledgeListQuerySchema,
        response: { 200: knowledgePageEnvelope, ...knowledgeErrorResponses },
      },
    },
    async (request) => {
      const access = request.access;

      if (access === undefined) {
        throw unauthenticated();
      }

      const page = await service.list(
        {
          organizationId: access.organizationId,
          projectId: request.params.projectId,
          includeOrganization: request.query.includeOrganization,
          status: request.query.status,
          category: request.query.category,
          origin: request.query.origin,
          tag: request.query.tag,
          search: request.query.search,
        },
        request.query.limit,
        request.query.cursor,
      );

      return ok(request, page);
    },
  );

  app.post(
    '/projects/:projectId/knowledge/proposals',
    {
      bodyLimit: PAYLOAD_LIMITS.global,
      preHandler: app.requirePermission('knowledge.propose', {
        resourceType: 'knowledge',
        resolveOrganizationId: organizationOfProject,
      }),
      schema: {
        tags: ['knowledge'],
        summary: 'Propose knowledge for a project',
        description:
          'Creates a new item, or a new version of an existing one when knowledgeId is sent. ' +
          'The proposal only becomes official after a review.',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        body: createKnowledgeProposalSchema,
        response: { 201: knowledgeItemEnvelope, ...knowledgeErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      const item = await service.propose({
        organizationId: access.organizationId,
        projectId: request.params.projectId,
        actorId: auth.userId,
        payload: request.body,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: access.organizationId,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'knowledge.proposed',
        resourceType: 'knowledge',
        resourceId: item.id,
        projectId: request.params.projectId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: {
          category: item.category,
          origin: item.origin,
          versionNumber: item.pendingVersion?.versionNumber ?? null,
          sourceCount: item.sources.length,
        },
      });

      return reply.code(201).send(ok(request, item));
    },
  );

  app.get(
    '/knowledge/:knowledgeId',
    {
      preHandler: app.requirePermission('chat.read', {
        resourceType: 'knowledge',
        resolveOrganizationId: organizationOfItem,
      }),
      schema: {
        tags: ['knowledge'],
        summary: 'Read one knowledge item with its current and pending versions',
        security: [{ bearerAuth: [] }],
        params: knowledgeParamsSchema,
        response: { 200: knowledgeItemEnvelope, ...knowledgeErrorResponses },
      },
    },
    async (request) => {
      const access = request.access;

      if (access === undefined) {
        throw unauthenticated();
      }

      return ok(request, await service.get(request.params.knowledgeId, access.organizationId));
    },
  );

  app.get(
    '/knowledge/:knowledgeId/diff',
    {
      preHandler: app.requirePermission('knowledge.review', {
        resourceType: 'knowledge',
        resolveOrganizationId: organizationOfItem,
      }),
      schema: {
        tags: ['knowledge'],
        summary: 'Diff between the pending version and the current one',
        description: 'What the reviewer reads before deciding, plus the declared sources.',
        security: [{ bearerAuth: [] }],
        params: knowledgeParamsSchema,
        response: { 200: knowledgeDiffEnvelope, ...knowledgeErrorResponses },
      },
    },
    async (request) => {
      const access = request.access;

      if (access === undefined) {
        throw unauthenticated();
      }

      return ok(request, await service.diff(request.params.knowledgeId, access.organizationId));
    },
  );

  app.post(
    '/knowledge/:knowledgeId/review',
    {
      bodyLimit: PAYLOAD_LIMITS.global,
      preHandler: app.requirePermission('knowledge.review', {
        resourceType: 'knowledge',
        resolveOrganizationId: organizationOfItem,
      }),
      schema: {
        tags: ['knowledge'],
        summary: 'Review a pending knowledge version',
        description:
          'Approving creates a new current version and supersedes the previous one. ' +
          'Approving requires at least one declared source, and approving your own ' +
          'proposal requires the knowledge.approve permission.',
        security: [{ bearerAuth: [] }],
        params: knowledgeParamsSchema,
        body: knowledgeReviewRequestSchema,
        response: { 200: knowledgeReviewEnvelope, ...knowledgeErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      let result;

      try {
        result = await service.review({
          knowledgeId: request.params.knowledgeId,
          organizationId: access.organizationId,
          actorId: auth.userId,
          decision: request.body.decision,
          comment: request.body.comment,
          version: request.body.version,
          canApprove: async () => hasApprovePermission(request, reply),
        });
      } catch (error) {
        // Tentar carimbar a própria proposta é evento de segurança, não só um
        // erro de requisição: é alguém contornando a revisão (`Docs/09`).
        if (isApiError(error) && error.code === 'PERMISSION_DENIED') {
          const origin = requestOrigin(request);

          await recordSecurityEvent(app.db, {
            organizationId: access.organizationId,
            userId: auth.userId,
            type: 'knowledge.self_approval_denied',
            severity: 'medium',
            ip: origin.ip,
            userAgent: origin.userAgent,
            details: { knowledgeId: request.params.knowledgeId },
          });
        }

        throw error;
      }

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: access.organizationId,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'knowledge.reviewed',
        resourceType: 'knowledge',
        resourceId: result.item.id,
        projectId: result.item.projectId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: {
          decision: result.review.decision,
          versionNumber: result.approvedVersionNumber,
          selfReview: result.item.proposedBy?.id === auth.userId,
        },
      });

      return ok(request, { review: result.review, item: result.item });
    },
  );

  /**
   * Roda o guard de `knowledge.approve` e devolve a decisão como booleano.
   *
   * Passar pelo guard, em vez de olhar a tabela de papéis, é o que faz a
   * política da organização valer: `authorize()` aplica a precedência do
   * `Docs/09` e pode negar `knowledge.approve` a um papel que normalmente o
   * teria. Só a negação de permissão vira `false` — qualquer outra falha
   * (limite de requisições, banco fora) continua subindo.
   */
  async function hasApprovePermission(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    const guard = app.requirePermission('knowledge.approve', {
      resourceType: 'knowledge',
      resolveOrganizationId: organizationOfItem,
    });

    try {
      await guard(request, reply);

      return true;
    } catch (error) {
      if (isApiError(error) && error.statusCode === 403) {
        return false;
      }

      throw error;
    }
  }

  done();
};
