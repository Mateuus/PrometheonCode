/**
 * Rotas de dispositivo (`Docs/06`).
 *
 * | Rota                                      | Permissão       | Quem passa            |
 * | ----------------------------------------- | --------------- | --------------------- |
 * | `POST /devices/register`                  | `chat.read`     | qualquer membro ativo |
 * | `POST /devices/:deviceId/heartbeat`       | `chat.read`     | o dono do dispositivo |
 * | `GET /projects/:projectId/agents/active`  | `agent.observe` | todos os papéis       |
 * | `GET /projects/:projectId/presence`       | `chat.read`     | todos os papéis       |
 *
 * `chat.read` no registro e no heartbeat segue a leitura já usada em
 * `modules/organizations`: é a permissão que os seis papéis têm, então exigi-la
 * equivale a "seja membro ativo" — e mantém a decisão dentro de `authorize()`,
 * com o e-mail verificado e a associação conferidos junto, em vez de um `if`.
 * A posse do dispositivo é conferida por cima disso, no serviço: nenhum membro
 * bate o heartbeat da máquina de outro.
 *
 * As rotas de projeto resolvem a organização **a partir do projeto**, não da
 * credencial: sem isso, alguém com duas organizações poderia apontar para o
 * projeto de uma e ser autorizado pelo papel que tem na outra.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { forbidden, unauthenticated } from '../../shared/errors.js';
import {
  activeAgentsEnvelope,
  deviceEnvelope,
  deviceErrorResponses,
  deviceHeartbeatRequestSchema,
  deviceParamsSchema,
  heartbeatEnvelope,
  presenceEnvelope,
  projectParamsSchema,
  registerDeviceRequestSchema,
} from './schemas.js';
import type { DeviceService } from './service.js';

export interface DeviceRoutesOptions {
  readonly service: DeviceService;
}

export const deviceRoutes: FastifyPluginCallbackZod<DeviceRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;

  /** Organização do projeto da rota, para `requirePermission`. */
  const organizationFromProject = async (request: FastifyRequest): Promise<string> => {
    const params = request.params as { projectId: string };

    return service.organizationOfProject(params.projectId);
  };

  app.post(
    '/devices/register',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('chat.read', { resourceType: 'device' }),
      schema: {
        tags: ['devices'],
        summary: 'Register or recognize this installation',
        description:
          'Idempotent by installationId: reinstalling the extension returns the same device.',
        security: [{ bearerAuth: [] }],
        body: registerDeviceRequestSchema,
        response: { 201: deviceEnvelope, ...deviceErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      const origin = requestOrigin(request);
      const device = await service.register({
        userId: auth.userId,
        organizationId: access.organizationId,
        name: request.body.name,
        kind: request.body.kind,
        platform: request.body.platform,
        clientVersion: request.body.clientVersion,
        installationId: request.body.installationId,
        ip: origin.ip,
      });

      await recordAudit(app.db, {
        organizationId: access.organizationId,
        actorType: auth.kind === 'device' ? 'device' : 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'device.registered',
        resourceType: 'device',
        resourceId: device.id,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        // A impressão da instalação não entra na auditoria: ela identifica a
        // máquina e não acrescenta nada ao que o `deviceId` já diz.
        metadata: { kind: device.kind, platform: device.platform },
      });

      return reply.code(201).send(ok(request, device));
    },
  );

  app.post(
    '/devices/:deviceId/heartbeat',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.requirePermission('chat.read', { resourceType: 'device' }),
      schema: {
        tags: ['devices'],
        summary: 'Report that this device is alive',
        description:
          'Feeds device.changed and the active agents list. A device that stops beating leaves both on its own.',
        security: [{ bearerAuth: [] }],
        params: deviceParamsSchema,
        body: deviceHeartbeatRequestSchema,
        response: { 200: heartbeatEnvelope, ...deviceErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;
      const access = request.access;

      if (auth === undefined || access === undefined) {
        throw unauthenticated();
      }

      // Credencial de dispositivo só bate o próprio heartbeat. Um token `pdt_`
      // roubado não pode falar em nome das outras máquinas do mesmo dono.
      if (auth.kind === 'device' && auth.deviceId !== request.params.deviceId) {
        throw forbidden(
          'This credential can only report for its own device.',
          'PERMISSION_DENIED',
        );
      }

      const origin = requestOrigin(request);

      return ok(
        request,
        await service.heartbeat({
          userId: auth.userId,
          organizationId: access.organizationId,
          deviceId: request.params.deviceId,
          status: request.body.status,
          projectIds: request.body.projectIds,
          activeAgentRunIds: request.body.activeAgentRunIds,
          clientVersion: request.body.clientVersion,
          ip: origin.ip,
        }),
      );
    },
  );

  app.get(
    '/projects/:projectId/agents/active',
    {
      preHandler: app.requirePermission('agent.observe', {
        resourceType: 'project',
        resolveOrganizationId: organizationFromProject,
      }),
      schema: {
        tags: ['devices'],
        summary: 'Devices currently running agents on this project',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        response: { 200: activeAgentsEnvelope, ...deviceErrorResponses },
      },
    },
    async (request) =>
      ok(request, { agents: await service.activeAgents(request.params.projectId) }),
  );

  app.get(
    '/projects/:projectId/presence',
    {
      preHandler: app.requirePermission('chat.read', {
        resourceType: 'project',
        resolveOrganizationId: organizationFromProject,
      }),
      schema: {
        tags: ['devices'],
        summary: 'Who is present on this project right now',
        description:
          'REST snapshot of presence. This is what a client reloads after `welcome` reports resumeGap.',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        response: { 200: presenceEnvelope, ...deviceErrorResponses },
      },
    },
    async (request) =>
      ok(request, { entries: await service.projectPresence(request.params.projectId) }),
  );

  done();
};
