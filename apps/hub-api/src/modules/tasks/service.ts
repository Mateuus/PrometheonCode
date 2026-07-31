/**
 * Regras de tarefa.
 *
 * A parte que decide se este módulo presta é a disputa por uma tarefa. Três
 * exigências, e nenhuma delas se resolve em memória do processo:
 *
 * 1. duas reivindicações simultâneas — só uma pode ganhar, e quem decide é o
 *    banco (`TaskRepository.claim()`);
 * 2. reivindicação precisa expirar — quem reivindicou e sumiu não trava a
 *    tarefa (`releaseExpired()`, chamada antes de toda leitura e de todo claim);
 * 3. soltar tarefa alheia falha com erro claro (`TASK_NOT_CLAIMED_BY_ACTOR`).
 *
 * Todo evento de domínio — `task.created`, `task.updated`, `task.claimed`,
 * `task.released` — é gravado no outbox **dentro da transação da mudança**
 * (`Docs/08`).
 */

import type {
  CreateTaskRequest,
  Task,
  TaskScope,
  TaskStatus,
} from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { buildPage, type CursorPage } from '../../shared/cursor.js';
import {
  recordTaskClaimed,
  recordTaskCreated,
  recordTaskReleased,
  recordTaskUpdated,
  type EventActor,
} from '../../shared/events.js';
import { toIso, toIsoOrNull } from '../../shared/time.js';
import {
  dependencyCycle,
  invalidDependency,
  taskAlreadyClaimed,
  taskNotClaimable,
  taskNotClaimedByActor,
  taskNotFound,
  taskVersionConflict,
} from './errors.js';
import {
  CLAIMABLE_STATUSES,
  TaskRepository,
  type TaskListFilters,
  type TransactionExecutor,
} from './repository.js';
import type { AssignmentRow, TaskRow } from './types.js';

/**
 * Teto do prazo de reivindicação, em segundos.
 *
 * O contrato aceita até 24 horas; o servidor impõe o teto porque o prazo é a
 * única coisa que devolve à fila uma tarefa presa a um dispositivo que caiu.
 * Um prazo de um dia transformaria "expira" em "expira amanhã".
 */
export const MAX_LEASE_SECONDS = 3_600;

export interface TaskServiceDeps {
  readonly db: Database;
}

export interface TaskActor {
  readonly userId: string;
  readonly kind: 'user' | 'device';
  readonly deviceId: string | null;
}

export class TaskService {
  private readonly repository: TaskRepository;

  constructor(deps: TaskServiceDeps) {
    this.repository = new TaskRepository(deps.db);
  }

  /**
   * Devolve à fila o que venceu, antes de qualquer leitura ou disputa.
   *
   * Chamada em `list`, `claim` e `release`: assim a expiração vale sem depender
   * de um job periódico estar de pé, e o resultado que o cliente vê já é o
   * estado correto.
   */
  private async sweepExpired(projectId: string, organizationId: string): Promise<void> {
    await this.repository.releaseExpired({
      projectId,
      onCommitted: async (tx, task) => {
        await recordTaskReleased(tx, {
          organizationId,
          projectId,
          taskId: task.id,
          status: task.status,
          version: task.version,
          // Quem soltou foi o relógio, não uma pessoa.
          actor: { type: 'system', id: null },
        });
      },
    });
  }

  async list(input: {
    projectId: string;
    organizationId: string;
    limit: number;
    cursor: string | undefined;
    filters: TaskListFilters;
  }): Promise<CursorPage<Task>> {
    await this.sweepExpired(input.projectId, input.organizationId);

    const rows = await this.repository.listForProject(input);
    const page = buildPage(rows, input.limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return { items: await this.decorate(page.items), pageInfo: page.pageInfo };
  }

  async get(taskId: string): Promise<Task> {
    const row = await this.repository.findById(taskId);

    if (row === undefined) {
      throw taskNotFound();
    }

    const [task] = await this.decorate([row]);

    if (task === undefined) {
      throw taskNotFound();
    }

    return task;
  }

  async create(input: {
    organizationId: string;
    projectId: string;
    actor: TaskActor;
    request: CreateTaskRequest;
  }): Promise<Task> {
    const dependsOn = await this.validateDependencies(input.projectId, input.request.dependsOn);

    const dedupeKey =
      input.request.idempotencyKey === undefined
        ? null
        : `task:${input.projectId}:${input.request.idempotencyKey}`;

    if (dedupeKey !== null) {
      const known = await this.repository.findByIdempotencyKey(dedupeKey);

      if (known !== undefined) {
        return this.get(known);
      }
    }

    const taskId = await this.repository.create({
      organizationId: input.organizationId,
      projectId: input.projectId,
      conversationId: input.request.conversationId ?? null,
      title: input.request.title,
      description: input.request.description ?? null,
      priority: input.request.priority,
      tags: input.request.tags,
      scope: input.request.scope === undefined ? null : { ...input.request.scope },
      dueAt: input.request.dueAt === undefined ? null : new Date(input.request.dueAt),
      dependsOn,
      assignee: toAssignee(
        input.request.assigneeUserId,
        input.request.assignedAgentProfileId,
      ),
      createdBy: input.actor.userId,
      onCommitted: async (tx, task) => {
        await recordTaskCreated(tx, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          taskId: task.id,
          status: task.status,
          version: task.version,
          actor: actorOf(input.actor),
          dedupeKey,
        });
      },
    });

    return this.get(taskId);
  }

  async update(input: {
    task: TaskRow;
    actor: TaskActor;
    version: number;
    fields: {
      title?: string | undefined;
      description?: string | null | undefined;
      status?: TaskStatus | undefined;
      priority?: Task['priority'] | undefined;
      tags?: string[] | undefined;
      scope?: TaskScope | null | undefined;
      dueAt?: string | null | undefined;
    };
    dependsOn: string[] | undefined;
    assignee: { type: 'user' | 'agent_profile'; id: string } | null | undefined;
  }): Promise<Task> {
    const dependsOn =
      input.dependsOn === undefined
        ? undefined
        : await this.validateDependencies(input.task.projectId, input.dependsOn, input.task.id);

    const fields: Record<string, unknown> = {};

    if (input.fields.title !== undefined) {
      fields['title'] = input.fields.title;
    }

    if (input.fields.description !== undefined) {
      fields['description'] = input.fields.description;
    }

    if (input.fields.status !== undefined) {
      fields['status'] = input.fields.status;

      if (input.fields.status === 'done') {
        fields['completedAt'] = new Date();
      }
    }

    if (input.fields.priority !== undefined) {
      fields['priority'] = input.fields.priority;
    }

    if (input.fields.tags !== undefined) {
      fields['tags'] = input.fields.tags;
    }

    if (input.fields.scope !== undefined) {
      fields['scope'] = input.fields.scope === null ? null : { ...input.fields.scope };
    }

    if (input.fields.dueAt !== undefined) {
      fields['dueAt'] = input.fields.dueAt === null ? null : new Date(input.fields.dueAt);
    }

    const updated = await this.repository.update({
      task: input.task,
      version: input.version,
      fields,
      dependsOn,
      assignee: input.assignee,
      actorId: input.actor.userId,
      onCommitted: async (tx, task) => {
        await recordTaskUpdated(tx, {
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId: task.id,
          status: task.status,
          version: task.version,
          actor: actorOf(input.actor),
        });

        // Terminar uma tarefa pode liberar quem dependia dela. Acontece na
        // mesma transação, com os eventos de quem foi liberado — do contrário
        // essas tarefas ficariam `blocked` para sempre.
        if (task.status === 'done' || task.status === 'cancelled') {
          await this.unblockDependents(tx, task);
        }
      },
    });

    if (updated === undefined) {
      throw taskVersionConflict();
    }

    return this.get(updated.id);
  }

  /**
   * Reivindica a tarefa para quem chama.
   *
   * A varredura de vencidas roda antes: uma tarefa cujo prazo expirou precisa
   * estar disponível para quem chega agora, e não continuar `claimed` no nome
   * de alguém que sumiu.
   */
  async claim(input: {
    task: TaskRow;
    actor: TaskActor;
    leaseSeconds: number;
    agentRunId: string | undefined;
    deviceId: string | undefined;
    scope: TaskScope | undefined;
  }): Promise<Task> {
    await this.sweepExpired(input.task.projectId, input.task.organizationId);

    const current = await this.repository.findById(input.task.id);

    if (current === undefined) {
      throw taskNotFound();
    }

    if (!(CLAIMABLE_STATUSES as readonly string[]).includes(current.status)) {
      throw taskNotClaimable(current.status);
    }

    const leaseSeconds = Math.min(input.leaseSeconds, MAX_LEASE_SECONDS);
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000);

    const claimed = await this.repository.claim({
      taskId: input.task.id,
      userId: input.actor.userId,
      deviceId: input.deviceId ?? input.actor.deviceId,
      agentRunId: input.agentRunId ?? null,
      expiresAt,
      scope: input.scope === undefined ? null : { ...input.scope },
      onCommitted: async (tx, task) => {
        await recordTaskClaimed(tx, {
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId: task.id,
          status: task.status,
          version: task.version,
          actor: actorOf(input.actor),
          leaseExpiresAt: expiresAt,
        });
      },
    });

    // Nenhuma linha afetada: entre a leitura acima e o `UPDATE`, outra pessoa
    // reivindicou. É exatamente a corrida que o `UPDATE` condicional resolve —
    // e o desfecho correto é este erro, não uma segunda tentativa.
    if (claimed === undefined) {
      throw taskAlreadyClaimed();
    }

    return this.get(claimed.id);
  }

  async release(input: {
    task: TaskRow;
    actor: TaskActor;
    status: Exclude<TaskStatus, 'backlog' | 'claimed' | 'in_progress'>;
  }): Promise<Task> {
    await this.sweepExpired(input.task.projectId, input.task.organizationId);

    const released = await this.repository.release({
      taskId: input.task.id,
      userId: input.actor.userId,
      status: input.status,
      onCommitted: async (tx, task) => {
        await recordTaskReleased(tx, {
          organizationId: task.organizationId,
          projectId: task.projectId,
          taskId: task.id,
          status: task.status,
          version: task.version,
          actor: actorOf(input.actor),
        });

        // Soltar concluindo também encerra a tarefa: quem dependia dela sai de
        // `blocked` aqui, pelo mesmo caminho do `PATCH`.
        if (task.status === 'done' || task.status === 'cancelled') {
          await this.unblockDependents(tx, task);
        }
      },
    });

    if (released === undefined) {
      throw taskNotClaimedByActor();
    }

    return this.get(released.id);
  }

  /** Libera quem dependia da tarefa recém-encerrada, com evento para cada uma. */
  private async unblockDependents(
    tx: TransactionExecutor,
    completed: TaskRow,
  ): Promise<void> {
    const unblocked = await this.repository.unblockDependents({
      tx,
      completedTaskId: completed.id,
      at: new Date(),
    });

    for (const taskId of unblocked) {
      const row = await this.repository.readInTransaction(tx, taskId);

      await recordTaskUpdated(tx, {
        organizationId: row.organizationId,
        projectId: row.projectId,
        taskId: row.id,
        status: row.status,
        version: row.version,
        // Quem liberou foi o fim da dependência, não uma pessoa.
        actor: { type: 'system', id: null },
      });
    }
  }

  /** Dependências precisam ser tarefas do mesmo projeto, e não a própria tarefa. */
  private async validateDependencies(
    projectId: string,
    dependsOn: readonly string[],
    selfId?: string,
  ): Promise<string[]> {
    const unique = [...new Set(dependsOn)];

    if (selfId !== undefined && unique.includes(selfId)) {
      throw dependencyCycle();
    }

    const known = await this.repository.idsInProject(projectId, unique);

    for (const taskId of unique) {
      if (!known.has(taskId)) {
        throw invalidDependency(taskId);
      }
    }

    return unique;
  }

  /** Junta atribuições e dependências à página lida. */
  private async decorate(rows: readonly TaskRow[]): Promise<Task[]> {
    const ids = rows.map((row) => row.id);
    const [assignments, dependencies] = await Promise.all([
      this.repository.assignmentsOf(ids),
      this.repository.dependenciesOf(ids),
    ]);

    return rows.map((row) =>
      toTaskView(row, assignments.get(row.id), dependencies.get(row.id) ?? []),
    );
  }
}

function actorOf(actor: TaskActor): EventActor {
  return { type: actor.kind === 'device' ? 'device' : 'user', id: actor.userId };
}

export function toAssignee(
  assigneeUserId: string | null | undefined,
  agentProfileId: string | null | undefined,
): { type: 'user' | 'agent_profile'; id: string } | null {
  if (typeof assigneeUserId === 'string') {
    return { type: 'user', id: assigneeUserId };
  }

  if (typeof agentProfileId === 'string') {
    return { type: 'agent_profile', id: agentProfileId };
  }

  return null;
}

/**
 * Escopo gravado em JSON, lido de volta como contrato.
 *
 * A coluna é livre e pode ter sido escrita por uma versão anterior do escopo;
 * o que não couber no formato atual sai como `null` em vez de fazer a
 * serialização da tarefa inteira falhar.
 */
export function toScopeView(scope: Record<string, unknown> | null): TaskScope | null {
  if (scope === null) {
    return null;
  }

  const paths = scope['paths'];

  if (!Array.isArray(paths)) {
    return null;
  }

  return {
    paths: paths.filter((path): path is string => typeof path === 'string'),
    exclusive: scope['exclusive'] === true,
  };
}

export function toTaskView(
  row: TaskRow,
  assignment: AssignmentRow | undefined,
  dependsOn: string[],
): Task {
  const assigneeType =
    assignment === undefined ? 'none' : assignment.assigneeType === 'user' ? 'user' : 'agent';

  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: row.tags ?? [],
    assigneeType,
    assignee:
      assignment?.assigneeType === 'user' && assignment.userName !== null
        ? {
            id: assignment.assigneeId,
            name: assignment.userName,
            email: assignment.userEmail ?? '',
            avatarUrl: assignment.userAvatarUrl,
          }
        : null,
    assignedAgentProfileId:
      assignment?.assigneeType === 'agent_profile' ? assignment.assigneeId : null,
    dependsOn,
    scope: toScopeView(row.scope),
    // Reivindicação vencida é lida como ausente mesmo antes de a varredura
    // passar: quem lê nunca vê como ocupada uma tarefa que já pode ser assumida.
    claim:
      row.claimExpiresAt === null ||
      row.claimedAt === null ||
      row.claimExpiresAt.getTime() <= Date.now()
        ? null
        : {
            claimedBy: row.claimedByAgentRunId === null ? 'user' : 'agent',
            userId: row.claimedByUserId,
            agentRunId: row.claimedByAgentRunId,
            deviceId: row.claimedByDeviceId,
            claimedAt: toIso(row.claimedAt),
            expiresAt: toIso(row.claimExpiresAt),
          },
    conversationId: row.conversationId,
    dueAt: toIsoOrNull(row.dueAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    createdBy: row.createdBy ?? row.id,
    version: row.version,
  };
}
