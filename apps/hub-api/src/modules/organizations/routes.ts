/**
 * Rotas de organização.
 *
 * **Toda rota daqui passa por uma verificação de autorização explícita** — é o
 * que o `Docs/09` cobra ao pedir teste de autorização por rota. As permissões
 * escolhidas:
 *
 * | Rota                              | Permissão            | Quem passa                     |
 * | --------------------------------- | -------------------- | ------------------------------ |
 * | `GET /organizations`              | (só autenticação)    | qualquer conta                 |
 * | `POST /organizations`             | (só autenticação)    | qualquer conta verificada      |
 * | `GET /organizations/:orgId`       | `chat.read`          | todos os papéis                |
 * | `GET .../members`                 | `chat.read`          | todos os papéis                |
 * | `POST .../invitations`            | `members.invite`     | owner e admin                  |
 * | `PATCH .../members/:memberId`     | `organization.manage`| owner                          |
 *
 * `chat.read` nas duas leituras merece explicação: o `Docs/09` fixa quinze
 * permissões e nenhuma delas é "ler a organização". `chat.read` é a permissão
 * que todos os seis papéis têm, inclusive `viewer`, então exigi-la equivale a
 * "seja um membro ativo" — e mantém a decisão passando por `authorize()` em vez
 * de virar um `if` solto.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { organizationNotFound } from './errors.js';
import {
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  cursorPageQuerySchema,
  invitationEnvelope,
  memberEnvelope,
  memberListQuerySchema,
  memberPageEnvelope,
  memberParamsSchema,
  organizationEnvelope,
  organizationErrorResponses,
  organizationPageEnvelope,
  organizationParamsSchema,
  organizationWithAccessEnvelope,
  updateMemberRequestSchema,
} from './schemas.js';
import { OrganizationRepository } from './repository.js';
import type { OrganizationService } from './service.js';

export interface OrganizationRoutesOptions {
  readonly service: OrganizationService;
}

// Plugin síncrono: registrar rota não espera nada. `FastifyPluginCallbackZod`
// é a forma que o Fastify oferece para isso — `async` sem `await` só
// esconderia que não há trabalho assíncrono aqui.
export const organizationRoutes: FastifyPluginCallbackZod<OrganizationRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;
  const repository = new OrganizationRepository(app.db);

  app.get(
    '/organizations',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['organizations'],
        summary: 'Organizations the signed-in user belongs to',
        security: [{ bearerAuth: [] }],
        querystring: cursorPageQuerySchema,
        response: { 200: organizationPageEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const page = await service.list(auth.userId, request.query.limit, request.query.cursor);

      return ok(request, page);
    },
  );

  app.post(
    '/organizations',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      schema: {
        tags: ['organizations'],
        summary: 'Create an organization',
        description: 'The creator becomes its owner.',
        security: [{ bearerAuth: [] }],
        body: createOrganizationRequestSchema,
        response: { 201: organizationEnvelope, ...organizationErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      // Criar tenant é ação de escrita: exige endereço confirmado, como todas
      // as demais (ver `plugins/auth.ts`).
      if (!auth.emailVerified) {
        throw unauthenticated(
          'Confirm your email address before continuing.',
          'EMAIL_NOT_VERIFIED',
        );
      }

      const organization = await service.create(auth.userId, request.body.name);
      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: organization.id,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: organization.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });

      return reply.code(201).send(ok(request, organization));
    },
  );

  app.get(
    '/organizations/:orgId',
    {
      preHandler: app.requirePermission('chat.read', { resourceType: 'organization' }),
      schema: {
        tags: ['organizations'],
        summary: 'Read one organization',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        response: { 200: organizationWithAccessEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const access = request.access;

      if (access === undefined) {
        throw unauthenticated();
      }

      return ok(request, await service.get(request.params.orgId, access.role));
    },
  );

  app.get(
    '/organizations/:orgId/members',
    {
      preHandler: app.requirePermission('chat.read', { resourceType: 'member' }),
      schema: {
        tags: ['organizations'],
        summary: 'List the members of an organization',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        querystring: memberListQuerySchema,
        response: { 200: memberPageEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const page = await service.listMembers(
        request.params.orgId,
        request.query.limit,
        request.query.cursor,
      );

      return ok(request, page);
    },
  );

  app.post(
    '/organizations/:orgId/invitations',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('members.invite', { resourceType: 'invitation' }),
      schema: {
        tags: ['organizations'],
        summary: 'Invite someone to the organization',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: createInvitationRequestSchema,
        response: { 201: invitationEnvelope, ...organizationErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      const organization = await repository.findById(request.params.orgId);

      if (organization === undefined) {
        throw organizationNotFound();
      }

      const invitation = await service.invite({
        organizationId: request.params.orgId,
        organizationName: organization.name,
        actorId: auth.userId,
        actorName: auth.displayName,
        actorRole: access.role,
        email: request.body.email,
        role: request.body.role,
        message: request.body.message ?? null,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'invitation.created',
        resourceType: 'invitation',
        resourceId: invitation.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        // O e-mail convidado entra na auditoria porque é o objeto da ação; o
        // token do convite, nunca.
        metadata: { email: request.body.email, role: request.body.role },
      });

      return reply.code(201).send(
        ok(request, {
          id: invitation.id,
          organizationId: request.params.orgId,
          email: request.body.email,
          role: request.body.role,
          status: 'pending' as const,
          invitedBy: {
            id: auth.userId,
            name: auth.displayName,
            email: auth.email,
            avatarUrl: null,
          },
          projectIds: request.body.projectIds,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: invitation.createdAt.toISOString(),
          acceptedAt: null,
        }),
      );
    },
  );

  app.patch(
    '/organizations/:orgId/members/:memberId',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('organization.manage', { resourceType: 'member' }),
      schema: {
        tags: ['organizations'],
        summary: 'Change a member role or status',
        description: 'Optimistic concurrency: send the version you read.',
        security: [{ bearerAuth: [] }],
        params: memberParamsSchema,
        body: updateMemberRequestSchema,
        response: { 200: memberEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      const member = await service.updateMember({
        organizationId: request.params.orgId,
        memberId: request.params.memberId,
        actorRole: access.role,
        version: request.body.version,
        role: request.body.role,
        status: request.body.status,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'member.updated',
        resourceType: 'member',
        resourceId: member.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { role: member.role, status: member.status },
      });

      return ok(request, member);
    },
  );

  done();
};
