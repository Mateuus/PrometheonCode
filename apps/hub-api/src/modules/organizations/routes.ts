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
 * | `PATCH /organizations/:orgId`     | `organization.manage`| owner                          |
 * | `DELETE /organizations/:orgId`    | `organization.manage`| owner                          |
 * | `GET .../members`                 | `chat.read`          | todos os papéis                |
 * | `POST .../invitations`            | `members.invite`     | owner e admin                  |
 * | `POST /invitations/accept`        | (só autenticação)    | a conta convidada, verificada  |
 * | `PATCH .../members/:memberId`     | `organization.manage`| owner                          |
 *
 * `POST /invitations/accept` é a única que não pode passar por
 * `requirePermission`: quem aceita ainda não é membro, e toda permissão exige
 * associação ativa. O que autoriza ali é a posse do token somada à identidade da
 * conta — ver o comentário da própria rota.
 *
 * `chat.read` nas duas leituras merece explicação: o `Docs/09` fixa quinze
 * permissões e nenhuma delas é "ler a organização". `chat.read` é a permissão
 * que todos os seis papéis têm, inclusive `viewer`, então exigi-la equivale a
 * "seja um membro ativo" — e mantém a decisão passando por `authorize()` em vez
 * de virar um `if` solto.
 */

import type { OrganizationRole } from '@prometheon/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS, RATE_LIMITS } from '../../config/index.js';
import { routeRateLimit } from '../../plugins/rate-limit.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { forbidden, unauthenticated } from '../../shared/errors.js';
import { recordMemberJoined } from '../../shared/events.js';
import { organizationNotFound } from './errors.js';
import {
  acceptInvitationEnvelope,
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  cursorPageQuerySchema,
  deleteOrganizationRequestSchema,
  invitationEnvelope,
  memberEnvelope,
  memberListQuerySchema,
  memberPageEnvelope,
  memberParamsSchema,
  organizationDeletedEnvelope,
  organizationEnvelope,
  organizationErrorResponses,
  organizationPageEnvelope,
  organizationParamsSchema,
  organizationWithAccessEnvelope,
  updateMemberRequestSchema,
  updateOrganizationRequestSchema,
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

  app.patch(
    '/organizations/:orgId',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('organization.manage', { resourceType: 'organization' }),
      schema: {
        tags: ['organizations'],
        summary: 'Rename an organization or change its address',
        description:
          'Optimistic concurrency: send the version you read. Changing the slug changes the ' +
          'address of every link that points to this organization.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: updateOrganizationRequestSchema,
        response: { 200: organizationWithAccessEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const access = request.access;
      const auth = request.auth;

      if (access === undefined || auth === undefined) {
        throw unauthenticated();
      }

      const updated = await service.update({
        organizationId: request.params.orgId,
        version: request.body.version,
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.slug === undefined ? {} : { slug: request.body.slug }),
        role: access.role,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'organization.updated',
        resourceType: 'organization',
        resourceId: request.params.orgId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { name: updated.name, slug: updated.slug },
      });

      return ok(request, updated);
    },
  );

  app.delete(
    '/organizations/:orgId',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('organization.manage', { resourceType: 'organization' }),
      schema: {
        tags: ['organizations'],
        summary: 'Delete an organization',
        description:
          'Requires the slug typed again and the version you read. The deletion is logical: ' +
          'the organization disappears from every listing and the retention worker erases it ' +
          'for good after the window.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: deleteOrganizationRequestSchema,
        response: { 200: organizationDeletedEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const removed = await service.remove({
        organizationId: request.params.orgId,
        version: request.body.version,
        slug: request.body.slug,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.params.orgId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'organization.deleted',
        resourceType: 'organization',
        resourceId: request.params.orgId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { slug: removed.slug, name: removed.name },
      });

      return ok(request, { organization: removed });
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

  /**
   * Aceitar um convite estando autenticado.
   *
   * **Não passa por `requirePermission`, e não pode passar**: quem aceita ainda
   * não é membro da organização — exigir uma permissão dentro dela recusaria
   * todo mundo. O que autoriza aqui é a posse do token somada à identidade da
   * conta, e as duas são conferidas no serviço (ver `acceptInvitation()`).
   *
   * A rota fica fora de `/organizations/:orgId` de propósito: quem tem o link
   * não sabe — nem precisa saber — qual é o identificador da organização. É o
   * convite que diz para onde a pessoa está entrando.
   */
  app.post(
    '/invitations/accept',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      config: routeRateLimit(RATE_LIMITS.invitationAccept),
      schema: {
        tags: ['organizations'],
        summary: 'Accept an invitation with an existing account',
        description:
          'The invited address must match the signed-in account, and that address must be confirmed.',
        security: [{ bearerAuth: [] }],
        body: acceptInvitationRequestSchema,
        response: { 200: acceptInvitationEnvelope, ...organizationErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      // Ver a decisão 2 em `OrganizationService.acceptInvitation()`: sem o
      // endereço confirmado, cadastrar-se com o e-mail alheio bastaria para
      // consumir o convite dele.
      if (!auth.emailVerified) {
        throw forbidden(
          'Confirm your email address before accepting an invitation.',
          'EMAIL_NOT_VERIFIED',
        );
      }

      const result = await service.acceptInvitation({
        token: request.body.token,
        userId: auth.userId,
        userEmail: auth.email,
        onAccepted: async (tx, accepted) => {
          await recordMemberJoined(tx, {
            organizationId: accepted.organizationId,
            projectId: null,
            memberId: accepted.memberId,
            userId: auth.userId,
            role: accepted.roleSlug as OrganizationRole,
            invitationId: accepted.invitationId,
          });
        },
      });

      const origin = requestOrigin(request);

      // A associação entra na auditoria da organização de destino: é lá que ela
      // significa alguma coisa, e é lá que `audit.read` a alcança. `created`
      // separa quem de fato entrou de quem repetiu a chamada.
      await recordAudit(app.db, {
        organizationId: result.organization.id,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'invitation.accepted',
        resourceType: 'member',
        resourceId: result.member.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        // O token do convite nunca entra em auditoria; o papel concedido, sim.
        metadata: { role: result.member.role, created: result.created },
      });

      return ok(request, { organization: result.organization, member: result.member });
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
