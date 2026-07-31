/**
 * Rotas dos papéis de agente da organização.
 *
 * | Rota                                        | Permissão           | Quem passa               |
 * | ------------------------------------------- | ------------------- | ------------------------ |
 * | `GET  /organizations/:orgId/agent-roles`    | `agent.observe`     | reviewer para cima       |
 * | `POST /organizations/:orgId/agent-roles`    | `project.configure` | owner, admin, maintainer |
 *
 * Nenhuma permissão nova: ler papel é observar a configuração dos agentes, e
 * escrevê-la é configurar como o time trabalha. Inventar um par de permissões
 * só para esta tabela obrigaria a revisar a matriz inteira do `Docs/09` para
 * distinguir duas coisas que já estão distinguidas.
 *
 * A escrita é substituição em bloco (`POST`, não `PUT`, para acompanhar o resto
 * da API): o corpo é a lista que a organização passa a ter.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import {
  agentRoleErrorResponses,
  agentRoleListEnvelope,
  organizationParamsSchema,
  replaceAgentRolesSchema,
} from './schemas.js';
import type { AgentRoleService } from './service.js';

export interface AgentRoleRoutesOptions {
  readonly service: AgentRoleService;
}

export const agentRoleRoutes: FastifyPluginCallbackZod<AgentRoleRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  app.get(
    '/organizations/:orgId/agent-roles',
    {
      preHandler: app.requirePermission('agent.observe', { resourceType: 'agent_role' }),
      schema: {
        tags: ['agent-roles'],
        summary: 'Agent roles defined by the organization',
        description:
          'Named roles the team created beyond the built-in ones. The built-in roles are code and are not listed here.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        response: { 200: agentRoleListEnvelope, ...agentRoleErrorResponses },
      },
    },
    async (request) => {
      const items = await service.list(request.params.orgId);

      return ok(request, { items });
    },
  );

  app.post(
    '/organizations/:orgId/agent-roles',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('project.configure', { resourceType: 'agent_role' }),
      schema: {
        tags: ['agent-roles'],
        summary: 'Replace the agent roles of the organization',
        description:
          'The body is the whole list. A role missing from it is removed — that is what makes a deletion visible in the request itself.',
        security: [{ bearerAuth: [] }],
        params: organizationParamsSchema,
        body: replaceAgentRolesSchema,
        response: { 200: agentRoleListEnvelope, ...agentRoleErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const organizationId = request.params.orgId;
      const items = await service.replace(organizationId, request.body.roles, auth.userId);
      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'agent_role.replaced',
        resourceType: 'agent_role',
        resourceId: organizationId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { count: items.length, ids: items.map((role) => role.id) },
      });

      return ok(request, { items });
    },
  );

  done();
};
