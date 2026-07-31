/**
 * Rotas de tarefa.
 *
 * Autorização por rota (`Docs/09`):
 *
 * | Rota                              | Permissão     | Quem passa                         |
 * | --------------------------------- | ------------- | ---------------------------------- |
 * | `GET /projects/:projectId/tasks`  | `chat.read`   | membros do projeto                 |
 * | `POST /projects/:projectId/tasks` | `task.create` | owner, admin, maintainer, developer|
 * | `PATCH /tasks/:taskId`            | `task.create` | os mesmos                          |
 * | `POST /tasks/:taskId/claim`       | `task.create` | os mesmos                          |
 * | `POST /tasks/:taskId/release`     | `task.create` | os mesmos                          |
 *
 * `PATCH` exige **também** `task.assign` quando o corpo troca o responsável.
 * São duas permissões distintas no `Docs/09` e a diferença importa: um
 * `developer` corrige o título da própria tarefa, mas não decide de quem é o
 * trabalho.
 *
 * `claim` e `release` usam `task.create` — e não `task.assign` — porque
 * reivindicar é assumir trabalho para si, que é justamente o que se espera de
 * quem executa. Exigir `task.assign` deixaria o `developer` de fora da fila
 * que ele existe para atender.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { PAYLOAD_LIMITS } from '../../config/index.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { projectContext, requireAlso, requireProjectPermission } from '../projects/access.js';
import { taskNotFound } from './errors.js';
import { TaskRepository } from './repository.js';
import {
  claimTaskRequestSchema,
  createTaskRequestSchema,
  projectParamsSchema,
  releaseTaskRequestSchema,
  taskEnvelope,
  taskErrorResponses,
  taskListQuerySchema,
  taskPageEnvelope,
  taskParamsSchema,
  updateTaskRequestSchema,
} from './schemas.js';
import { toAssignee, type TaskActor, type TaskService } from './service.js';
import type { TaskRow } from './types.js';

export interface TaskRoutesOptions {
  readonly service: TaskService;
}

export const taskRoutes: FastifyPluginCallbackZod<TaskRoutesOptions> = (app, options, done) => {
  const { service } = options;
  const repository = new TaskRepository(app.db);

  /** Quem age, no formato que o serviço e o evento esperam. */
  function actorOf(request: Parameters<typeof requestOrigin>[0]): TaskActor {
    const auth = request.auth;

    if (auth === undefined) {
      throw unauthenticated();
    }

    return { userId: auth.userId, kind: auth.kind, deviceId: auth.deviceId };
  }

  async function loadTask(taskId: string): Promise<TaskRow> {
    const task = await repository.findById(taskId);

    if (task === undefined) {
      throw taskNotFound();
    }

    return task;
  }

  app.get(
    '/projects/:projectId/tasks',
    {
      preHandler: requireProjectPermission(app, 'chat.read', {
        from: 'project',
        resourceType: 'task',
      }),
      schema: {
        tags: ['tasks'],
        summary: 'List the tasks of a project',
        description: 'Expired claims are returned to the queue before the page is read.',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        querystring: taskListQuerySchema,
        response: { 200: taskPageEnvelope, ...taskErrorResponses },
      },
    },
    async (request) => {
      const { project } = projectContext(request);

      const page = await service.list({
        projectId: project.id,
        organizationId: project.organizationId,
        limit: request.query.limit,
        cursor: request.query.cursor,
        filters: {
          status: request.query.status,
          priority: request.query.priority,
          assigneeUserId: request.query.assigneeUserId,
          assigneeType: request.query.assigneeType,
          tag: request.query.tag,
          search: request.query.search,
        },
      });

      return ok(request, page);
    },
  );

  app.post(
    '/projects/:projectId/tasks',
    {
      bodyLimit: PAYLOAD_LIMITS.global,
      preHandler: requireProjectPermission(app, 'task.create', {
        from: 'project',
        resourceType: 'task',
      }),
      schema: {
        tags: ['tasks'],
        summary: 'Create a task in a project',
        description:
          'A task with dependencies is born `blocked`; without them, `ready`. Naming an assignee also requires `task.assign`.',
        security: [{ bearerAuth: [] }],
        params: projectParamsSchema,
        body: createTaskRequestSchema,
        response: { 201: taskEnvelope, ...taskErrorResponses },
      },
    },
    async (request, reply) => {
      const { project } = projectContext(request);
      const actor = actorOf(request);

      if (
        request.body.assigneeUserId !== undefined ||
        request.body.assignedAgentProfileId !== undefined
      ) {
        await requireAlso(app, request, 'task.assign');
      }

      const task = await service.create({
        organizationId: project.organizationId,
        projectId: project.id,
        actor,
        request: request.body,
      });

      await audit(request, 'task.created', task.id, { number: task.title });

      return reply.code(201).send(ok(request, task));
    },
  );

  app.patch(
    '/tasks/:taskId',
    {
      bodyLimit: PAYLOAD_LIMITS.global,
      preHandler: requireProjectPermission(app, 'task.create', {
        from: 'task',
        resourceType: 'task',
      }),
      schema: {
        tags: ['tasks'],
        summary: 'Update a task',
        description:
          'Optimistic concurrency: send the version you read. Changing the assignee also requires `task.assign`.',
        security: [{ bearerAuth: [] }],
        params: taskParamsSchema,
        body: updateTaskRequestSchema,
        response: { 200: taskEnvelope, ...taskErrorResponses },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const task = await loadTask(request.params.taskId);
      const { version, dependsOn, assigneeUserId, assignedAgentProfileId, ...fields } =
        request.body;

      const changesAssignee =
        assigneeUserId !== undefined || assignedAgentProfileId !== undefined;

      if (changesAssignee) {
        await requireAlso(app, request, 'task.assign');
      }

      const updated = await service.update({
        task,
        actor,
        version,
        fields,
        dependsOn,
        assignee: changesAssignee
          ? toAssignee(assigneeUserId, assignedAgentProfileId)
          : undefined,
      });

      await audit(request, 'task.updated', task.id, {
        changed: Object.keys(request.body).filter((key) => key !== 'version'),
      });

      return ok(request, updated);
    },
  );

  app.post(
    '/tasks/:taskId/claim',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: requireProjectPermission(app, 'task.create', {
        from: 'task',
        resourceType: 'task',
      }),
      schema: {
        tags: ['tasks'],
        summary: 'Claim a task',
        description:
          'The database decides the winner: only one of two simultaneous claims succeeds, the other gets `TASK_ALREADY_CLAIMED`. The claim expires, so a device that disappears does not hold the task forever.',
        security: [{ bearerAuth: [] }],
        params: taskParamsSchema,
        body: claimTaskRequestSchema,
        response: { 200: taskEnvelope, ...taskErrorResponses },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const task = await loadTask(request.params.taskId);

      const claimed = await service.claim({
        task,
        actor,
        leaseSeconds: request.body.leaseSeconds,
        agentRunId: request.body.agentRunId,
        deviceId: request.body.deviceId,
        scope: request.body.scope,
      });

      await audit(request, 'task.claimed', task.id, {
        expiresAt: claimed.claim?.expiresAt ?? null,
      });

      return ok(request, claimed);
    },
  );

  app.post(
    '/tasks/:taskId/release',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: requireProjectPermission(app, 'task.create', {
        from: 'task',
        resourceType: 'task',
      }),
      schema: {
        tags: ['tasks'],
        summary: 'Release a task you hold',
        description: 'Releasing a task you do not hold fails with `TASK_NOT_CLAIMED_BY_ACTOR`.',
        security: [{ bearerAuth: [] }],
        params: taskParamsSchema,
        body: releaseTaskRequestSchema,
        response: { 200: taskEnvelope, ...taskErrorResponses },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const task = await loadTask(request.params.taskId);

      const released = await service.release({ task, actor, status: request.body.status });

      await audit(request, 'task.released', task.id, { status: released.status });

      return ok(request, released);
    },
  );

  /** Auditoria das ações críticas de tarefa (`Docs/06`). */
  async function audit(
    request: Parameters<typeof requestOrigin>[0],
    action: string,
    taskId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const auth = request.auth;
    const { project } = projectContext(request);
    const origin = requestOrigin(request);

    await recordAudit(app.db, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorType: auth?.kind === 'device' ? 'device' : 'user',
      actorId: auth?.userId ?? null,
      actorLabel: auth?.email ?? null,
      action,
      resourceType: 'task',
      resourceId: taskId,
      requestId: request.id,
      ip: origin.ip,
      userAgent: origin.userAgent,
      metadata,
    });
  }

  done();
};
