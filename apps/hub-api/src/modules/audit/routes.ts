/**
 * `GET /v1/audit` (`Docs/06`).
 *
 * Exige `audit.read`, que só `owner` e `admin` têm. É também a rota que exercita
 * a paginação por cursor de ponta a ponta: `audit_logs` cresce sem limite e tem
 * o índice `(organization_id, created_at)` do `Docs/07`.
 */

import {
  auditListQuerySchema,
  auditPageSchema,
  AUDIT_RESOURCE_TYPES,
  errorEnvelopeSchema,
  successEnvelope,
} from '@prometheon/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { buildPage } from '../../shared/cursor.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { toIso } from '../../shared/time.js';
import { AuditRepository, type AuditRow } from './repository.js';

const auditPageEnvelope = successEnvelope(auditPageSchema);

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
export const auditRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  const repository = new AuditRepository(app.db);

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

  done();
};
