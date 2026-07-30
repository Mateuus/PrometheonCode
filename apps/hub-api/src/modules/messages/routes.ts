/**
 * Rotas de mensagem.
 *
 * Autorização por rota (`Docs/09`):
 *
 * | Rota                                     | Permissão    | Quem passa                       |
 * | ---------------------------------------- | ------------ | -------------------------------- |
 * | `GET /conversations/:id/messages`        | `chat.read`  | membros do projeto               |
 * | `POST /conversations/:id/messages`       | `chat.write` | todos menos `viewer`             |
 *
 * As duas passam pelo guarda de projeto, que resolve o projeto a partir da
 * conversa: quem é da organização mas não do projeto não lê o que se conversa
 * lá dentro.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import type { ConversationService } from '../conversations/service.js';
import { projectContext, requireProjectPermission } from '../projects/access.js';
import {
  conversationParamsSchema,
  createMessageRequestSchema,
  messageEnvelope,
  messageErrorResponses,
  messageListQuerySchema,
  messagePageEnvelope,
} from './schemas.js';
import type { MessageService } from './service.js';

export interface MessageRoutesOptions {
  readonly service: MessageService;
  readonly conversations: ConversationService;
}

export const messageRoutes: FastifyPluginCallbackZod<MessageRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service, conversations } = options;

  app.get(
    '/conversations/:conversationId/messages',
    {
      preHandler: requireProjectPermission(app, 'chat.read', {
        from: 'conversation',
        resourceType: 'message',
      }),
      schema: {
        tags: ['messages'],
        summary: 'List the messages of a conversation',
        description:
          'Ordered by sequence. `afterSequence` reads forward from a known point, which is how a client resumes after losing the realtime window.',
        security: [{ bearerAuth: [] }],
        params: conversationParamsSchema,
        querystring: messageListQuerySchema,
        response: { 200: messagePageEnvelope, ...messageErrorResponses },
      },
    },
    async (request) => {
      const page = await service.list({
        conversationId: request.params.conversationId,
        limit: request.query.limit,
        cursor: request.query.cursor,
        afterSequence: request.query.afterSequence,
        authorType: request.query.authorType,
      });

      return ok(request, page);
    },
  );

  app.post(
    '/conversations/:conversationId/messages',
    {
      preHandler: requireProjectPermission(app, 'chat.write', {
        from: 'conversation',
        resourceType: 'message',
      }),
      schema: {
        tags: ['messages'],
        summary: 'Post a message to a conversation',
        description:
          'Envelope and ordered parts are written in one transaction, together with the `message.created` event. Raw model reasoning is never stored — only the authorized operational summary.',
        security: [{ bearerAuth: [] }],
        params: conversationParamsSchema,
        body: createMessageRequestSchema,
        response: { 201: messageEnvelope, ...messageErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const { project } = projectContext(request);
      const conversation = await conversations.findRow(request.params.conversationId);

      const message = await service.create({
        conversation,
        projectId: project.id,
        actorUserId: auth.userId,
        request: request.body,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'message.created',
        resourceType: 'message',
        resourceId: message.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        // O conteúdo da mensagem não entra na auditoria: o `Docs/09` pede para
        // minimizar conteúdo no Hub, e o rastro precisa do fato, não do texto.
        metadata: {
          conversationId: conversation.id,
          sequence: message.sequence,
          partTypes: message.parts.map((part) => part.type),
        },
      });

      return reply.code(201).send(ok(request, message));
    },
  );

  done();
};
