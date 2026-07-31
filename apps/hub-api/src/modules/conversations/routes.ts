/**
 * Rotas de conversa.
 *
 * Autorização por rota (`Docs/09`):
 *
 * | Rota                                    | Permissão    | Quem passa            |
 * | --------------------------------------- | ------------ | --------------------- |
 * | `GET /projects/:projectId/conversations`| `chat.read`  | membros do projeto    |
 * | `POST /projects/:projectId/conversations`| `chat.write`| todos menos `viewer`  |
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import type { MessageService } from '../messages/service.js';
import { projectContext, requireProjectPermission } from '../projects/access.js';
import {
  conversationEnvelope,
  conversationErrorResponses,
  conversationListQuerySchema,
  conversationPageEnvelope,
  createConversationRequestSchema,
  projectParamsSchema,
} from './schemas.js';
import type { ConversationService } from './service.js';

export interface ConversationRoutesOptions {
  readonly service: ConversationService;
  readonly messages: MessageService;
}

export const conversationRoutes: FastifyPluginCallbackZod<ConversationRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service, messages } = options;

  app.get(
    '/projects/:projectId/conversations',
    {
      preHandler: requireProjectPermission(app, 'chat.read', {
        from: 'project',
        resourceType: 'conversation',
      }),
      schema: {
        tags: ['conversations'],
        summary: 'List the conversations of a project',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        querystring: conversationListQuerySchema,
        response: { 200: conversationPageEnvelope, ...conversationErrorResponses },
      },
    },
    async (request) => {
      const page = await service.list({
        projectId: projectContext(request).project.id,
        limit: request.query.limit,
        cursor: request.query.cursor,
        filters: {
          status: request.query.status,
          origin: request.query.origin,
          search: request.query.search,
        },
      });

      return ok(request, page);
    },
  );

  app.post(
    '/projects/:projectId/conversations',
    {
      bodyLimit: PAYLOAD_LIMITS.global,
      preHandler: requireProjectPermission(app, 'chat.write', {
        from: 'project',
        resourceType: 'conversation',
      }),
      schema: {
        tags: ['conversations'],
        summary: 'Start a conversation in a project',
        description:
          'The caller becomes its owner. `initialMessage` posts the first message in the same request, with its own `message.created` event.',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        body: createConversationRequestSchema,
        response: { 201: conversationEnvelope, ...conversationErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const { project } = projectContext(request);
      const conversation = await service.create({
        project,
        createdBy: auth.userId,
        request: request.body,
      });

      // A primeira mensagem passa pelo mesmo caminho de `POST /messages`:
      // mesma transação, mesma sequência, mesmo evento no outbox.
      if (request.body.initialMessage !== undefined) {
        await messages.create({
          conversation: await service.findRow(conversation.id),
          projectId: project.id,
          actorUserId: auth.userId,
          request: {
            authorType: 'user',
            parts: [{ type: 'text', text: request.body.initialMessage }],
            contextRefs: [],
            attachmentIds: [],
          },
        });
      }

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'conversation.created',
        resourceType: 'conversation',
        resourceId: conversation.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { origin: conversation.origin, workMode: conversation.workMode },
      });

      return reply.code(201).send(ok(request, await service.get(conversation.id)));
    },
  );

  done();
};
