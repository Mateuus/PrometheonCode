/**
 * Rotas de projeto.
 *
 * Autorização por rota (`Docs/09`):
 *
 * | Rota                                      | Permissão           | Quem passa                     |
 * | ----------------------------------------- | ------------------- | ------------------------------ |
 * | `GET /organizations/:orgId/projects`      | `chat.read`         | todos os papéis                |
 * | `POST /organizations/:orgId/projects`     | `project.create`    | owner, admin, maintainer       |
 * | `GET /projects/:projectId`                | `chat.read`         | membros do projeto             |
 * | `PATCH /projects/:projectId`              | `project.configure` | owner, admin, maintainer       |
 *
 * As duas primeiras vivem sob `:orgId` e usam o guarda de organização; as duas
 * últimas passam pelo guarda de projeto, que acrescenta `project_members` e a
 * política do projeto (ver `access.ts`).
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { projectContext, requireProjectPermission } from './access.js';
import {
  createProjectRequestSchema,
  organizationParamsSchema,
  projectEnvelope,
  projectErrorResponses,
  projectListQuerySchema,
  projectPageEnvelope,
  projectParamsSchema,
  updateProjectRequestSchema,
} from './schemas.js';
import type { ProjectService } from './service.js';

export interface ProjectRoutesOptions {
  readonly service: ProjectService;
}

export const projectRoutes: FastifyPluginCallbackZod<ProjectRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  app.get(
    '/organizations/:orgId/projects',
    {
      preHandler: app.requirePermission('chat.read', { resourceType: 'project' }),
      schema: {
        tags: ['projects'],
        summary: 'List the projects of an organization',
        description:
          'Only projects the caller participates in. Owners and admins also see every project whose visibility is `organization`.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        querystring: projectListQuerySchema,
        response: { 200: projectPageEnvelope, ...projectErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      const page = await service.list({
        organizationId: request.params.orgId,
        userId: auth.userId,
        canSeeEveryProject: access.role === 'owner' || access.role === 'admin',
        limit: request.query.limit,
        cursor: request.query.cursor,
        filters: {
          status: request.query.status,
          search: request.query.search,
          tag: request.query.tag,
        },
      });

      return ok(request, page);
    },
  );

  app.post(
    '/organizations/:orgId/projects',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('project.create', { resourceType: 'project' }),
      schema: {
        tags: ['projects'],
        summary: 'Create a project',
        description: 'The creator becomes its first member.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: createProjectRequestSchema,
        response: { 201: projectEnvelope, ...projectErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const project = await service.create({
        organizationId: request.params.orgId,
        createdBy: auth.userId,
        request: request.body,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'project.created',
        resourceType: 'project',
        resourceId: project.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { slug: project.slug, visibility: project.visibility },
      });

      return reply.code(201).send(ok(request, project));
    },
  );

  app.get(
    '/projects/:projectId',
    {
      preHandler: requireProjectPermission(app, 'chat.read', {
        from: 'project',
        resourceType: 'project',
      }),
      schema: {
        tags: ['projects'],
        summary: 'Read one project',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        response: { 200: projectEnvelope, ...projectErrorResponses },
      },
    },
    async (request) => ok(request, await service.get(projectContext(request).project.id)),
  );

  app.patch(
    '/projects/:projectId',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: requireProjectPermission(app, 'project.configure', {
        from: 'project',
        resourceType: 'project',
      }),
      schema: {
        tags: ['projects'],
        summary: 'Update a project or its settings',
        description: 'Optimistic concurrency: send the version you read.',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        body: updateProjectRequestSchema,
        response: { 200: projectEnvelope, ...projectErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const { project } = projectContext(request);
      const { version, settings, ...fields } = request.body;

      const updated = await service.update({ project, version, fields, settings });
      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'project.updated',
        resourceType: 'project',
        resourceId: project.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { changed: Object.keys(request.body).filter((key) => key !== 'version') },
      });

      return ok(request, updated);
    },
  );

  done();
};
