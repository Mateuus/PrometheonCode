/**
 * Auditoria e governança (`Docs/06`, `Docs/09`).
 *
 * | Rota                                        | Permissão             | Quem passa    |
 * | ------------------------------------------- | --------------------- | ------------- |
 * | `GET  /audit`                               | `audit.read`          | owner e admin |
 * | `GET  /audit/security-events`               | `audit.read`          | owner e admin |
 * | `POST /organizations/:orgId/exports`        | `organization.manage` | owner e admin |
 * | `GET  /organizations/:orgId/exports`        | `audit.read`          | owner e admin |
 * | `GET  /organizations/:orgId/exports/:jobId` | `audit.read`          | owner e admin |
 * | `POST /organizations/:orgId/deletions`      | `organization.manage` | owner e admin |
 * | `GET  /organizations/:orgId/deletions`      | `audit.read`          | owner e admin |
 *
 * **Não existe rota que altere ou apague auditoria** — nem para administrador.
 * `audit_logs` e `security_events` são append-oriented (`Docs/09`); um log que
 * o administrador pode corrigir deixa de ser prova de qualquer coisa. Corrigir
 * um registro é escrever outro, e é por isso que só há `GET` sobre eles.
 *
 * As duas listagens são também o que exercita a paginação por cursor de ponta a
 * ponta: as tabelas crescem sem limite e têm o índice
 * `(organization_id, actor_id, created_at)` pedido pelo `Docs/07`.
 */

import {
  auditListQuerySchema,
  auditPageSchema,
  AUDIT_RESOURCE_TYPES,
  createDataExportRequestSchema,
  createDeletionRequestSchema,
  dataExportPageSchema,
  dataExportJobSchema,
  dataJobListQuerySchema,
  deletionJobPageSchema,
  deletionJobSchema,
  errorEnvelopeSchema,
  securityEventListQuerySchema,
  securityEventPageSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { buildPage } from '../../shared/cursor.js';
import { ok } from '../../shared/envelope.js';
import { notFound, unauthenticated } from '../../shared/errors.js';
import { toIso } from '../../shared/time.js';
import { AuditRepository, type AuditRow } from './repository.js';
import { toExportJobView } from './service.js';
import type { AuditService } from './service.js';

const auditPageEnvelope = successEnvelope(auditPageSchema);
const securityEventPageEnvelope = successEnvelope(securityEventPageSchema);
const exportPageEnvelope = successEnvelope(dataExportPageSchema);
const exportEnvelope = successEnvelope(dataExportJobSchema);
const deletionPageEnvelope = successEnvelope(deletionJobPageSchema);
const deletionEnvelope = successEnvelope(deletionJobSchema);

const organizationParamsSchema = z.object({ orgId: ulidSchema });
const exportParamsSchema = z.object({ orgId: ulidSchema, jobId: ulidSchema });

const governanceErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;

type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/**
 * O enum do contrato é fechado; a coluna é `varchar`.
 *
 * Um `resource_type` gravado por uma versão mais nova do que a que está lendo
 * não pode derrubar a listagem, então o desconhecido cai em `organization`.
 */
function toResourceType(value: string): AuditResourceType {
  return (AUDIT_RESOURCE_TYPES as readonly string[]).includes(value)
    ? (value as AuditResourceType)
    : 'organization';
}

function toAuditView(row: AuditRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actorType: row.actorType,
    actorUser:
      row.actorId === null || row.actorName === null || row.actorEmail === null
        ? null
        : {
            id: row.actorId,
            name: row.actorName,
            email: row.actorEmail,
            avatarUrl: row.actorAvatarUrl,
          },
    actorDeviceId: row.actorType === 'device' ? row.actorId : null,
    action: row.action,
    resourceType: toResourceType(row.resourceType),
    // O contrato pede ULID; identificadores de outra forma (um código, um slug)
    // ficam fora em vez de invalidar a página inteira.
    resourceId: row.resourceId !== null && row.resourceId.length === 26 ? row.resourceId : null,
    projectId: row.projectId,
    ipAddress: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt),
  };
}

// Plugin síncrono: registrar rota não espera nada. `FastifyPluginCallbackZod`
// é a forma que o Fastify oferece para isso — `async` sem `await` só
// esconderia que não há trabalho assíncrono aqui.
export interface AuditRoutesOptions {
  readonly service: AuditService;
}

export const auditRoutes: FastifyPluginCallbackZod<AuditRoutesOptions> = (
  app,
  options,
  done,
) => {
  const repository = new AuditRepository(app.db);
  const { service } = options;

  app.get(
    '/audit',
    {
      preHandler: app.requirePermission('audit.read', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'Read the audit log of an organization',
        description: 'Requires audit.read, which only owner and admin have.',
        security: [{ bearerAuth: [] }],
        querystring: auditListQuerySchema,
        response: {
          200: auditPageEnvelope,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const access = request.access;

      if (access === undefined) {
        throw unauthenticated();
      }

      const rows = await repository.list(
        {
          organizationId: access.organizationId,
          actorType: request.query.actorType,
          actorUserId: request.query.actorUserId,
          resourceType: request.query.resourceType,
          resourceId: request.query.resourceId,
          projectId: request.query.projectId,
          action: request.query.action,
          from: request.query.from,
          to: request.query.to,
        },
        request.query.limit,
        request.query.cursor,
      );

      const page = buildPage(rows, request.query.limit, (row) => ({
        at: row.createdAt.getTime(),
        id: row.id,
      }));

      return ok(request, {
        items: page.items.map(toAuditView),
        pageInfo: page.pageInfo,
      });
    },
  );

  app.get(
    '/audit/security-events',
    {
      preHandler: app.requirePermission('audit.read', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'Read the security events of an organization',
        description: 'Failed logins, refused tokens, denied permissions. Requires audit.read.',
        security: [{ bearerAuth: [] }],
        querystring: securityEventListQuerySchema,
        response: { 200: securityEventPageEnvelope, ...governanceErrorResponses },
      },
    },
    async (request) => {
      const access = request.access;

      if (access === undefined) {
        throw unauthenticated();
      }

      const page = await service.listSecurityEvents(
        {
          organizationId: access.organizationId,
          type: request.query.type,
          severity: request.query.severity,
          userId: request.query.userId,
          from: request.query.from,
          to: request.query.to,
          unresolved: request.query.unresolved,
        },
        request.query.limit,
        request.query.cursor,
      );

      return ok(request, page);
    },
  );

  app.post(
    '/organizations/:orgId/exports',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('organization.manage', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'Request an export of the organization data',
        description:
          'The bundle is built by the worker and never contains password hashes, ' +
          'tokens or credentials.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: createDataExportRequestSchema,
        response: { 202: exportEnvelope, ...governanceErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const job = await service.requestExport({
        organizationId: request.params.orgId,
        actorId: auth.userId,
        correlationId: request.id,
        scope: request.body.scope,
        scopeId: request.body.scopeId,
        format: request.body.format,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'organization.export_requested',
        resourceType: 'organization',
        resourceId: job.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { scope: job.scope, scopeId: job.scopeId, format: job.format },
      });

      return reply.code(202).send(ok(request, job));
    },
  );

  app.get(
    '/organizations/:orgId/exports',
    {
      preHandler: app.requirePermission('audit.read', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'List the export requests of an organization',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        querystring: dataJobListQuerySchema,
        response: { 200: exportPageEnvelope, ...governanceErrorResponses },
      },
    },
    async (request) =>
      ok(
        request,
        await service.listExports(
          request.params.orgId,
          request.query.status,
          request.query.limit,
          request.query.cursor,
        ),
      ),
  );

  app.get(
    '/organizations/:orgId/exports/:jobId',
    {
      preHandler: app.requirePermission('audit.read', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'Read one export request',
        security: [{ bearerAuth: [] }],
        params: exportParamsSchema,
        response: { 200: exportEnvelope, ...governanceErrorResponses },
      },
    },
    async (request) => {
      const row = await repository.findExportJob(request.params.orgId, request.params.jobId);

      if (row === undefined) {
        throw notFound('NOT_FOUND', 'This export request does not exist.');
      }

      return ok(request, toExportJobView(row));
    },
  );

  app.post(
    '/organizations/:orgId/deletions',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('organization.manage', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'Request the deletion of organization data',
        description:
          'The job runs after a grace period, which is what makes the deletion recoverable.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: createDeletionRequestSchema,
        response: { 202: deletionEnvelope, ...governanceErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const job = await service.requestDeletion({
        organizationId: request.params.orgId,
        actorId: auth.userId,
        correlationId: request.id,
        targetType: request.body.targetType,
        targetId: request.body.targetId,
        reason: request.body.reason,
        graceDays: request.body.graceDays,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'organization.deletion_requested',
        resourceType: 'organization',
        resourceId: job.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: {
          targetType: job.targetType,
          targetId: job.targetId,
          scheduledFor: job.scheduledFor,
        },
      });

      return reply.code(202).send(ok(request, job));
    },
  );

  app.get(
    '/organizations/:orgId/deletions',
    {
      preHandler: app.requirePermission('audit.read', { resourceType: 'organization' }),
      schema: {
        tags: ['audit'],
        summary: 'List the deletion requests of an organization',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        querystring: dataJobListQuerySchema,
        response: { 200: deletionPageEnvelope, ...governanceErrorResponses },
      },
    },
    async (request) =>
      ok(
        request,
        await service.listDeletions(
          request.params.orgId,
          request.query.status,
          request.query.limit,
          request.query.cursor,
        ),
      ),
  );

  done();
};
