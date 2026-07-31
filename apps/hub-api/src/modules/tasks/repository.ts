/**
 * Acesso ao banco do módulo de tarefas.
 *
 * Duas decisões concentram o risco deste módulo e as duas estão aqui:
 *
 * - `nextNumber()` — o número curto por projeto, distribuído sem corrida;
 * - `claim()` / `release()` / `releaseExpired()` — a disputa pela tarefa,
 *   decidida por `UPDATE` condicional, nunca por leitura seguida de escrita.
 */

import {
  newId,
  outboxMessages,
  projects,
  runInTransaction,
  taskAssignments,
  taskDependencies,
  tasks,
  users,
  writable,
  type Database,
  type Task,
  type TransactionExecutor,
} from '@prometheon/database';

import { decodeCursor } from '../../shared/cursor.js';
import { affectedRows, applyKeyset, escapeLike } from '../../shared/query.js';
import type { AssignmentRow, DependencyRow, TaskRow } from './types.js';

export type { TransactionExecutor } from '@prometheon/database';

/** Colunas que o contrato de tarefa expõe. Lista explícita: nada de `SELECT *`. */
const TASK_COLUMNS = [
  'id',
  'organizationId',
  'projectId',
  'conversationId',
  'number',
  'title',
  'description',
  'status',
  'priority',
  'tags',
  'scope',
  'claimedByUserId',
  'claimedByDeviceId',
  'claimedByAgentRunId',
  'claimedAt',
  'claimExpiresAt',
  'dueAt',
  'createdAt',
  'updatedAt',
  'createdBy',
  'version',
] as const;

/** Estados em que a tarefa ainda é trabalho a fazer. */
export const CLAIMABLE_STATUSES = ['backlog', 'ready', 'claimed', 'in_progress'] as const;

/** Atribuições que ainda valem: as demais são histórico. */
const LIVE_ASSIGNMENT_STATUSES = ['assigned', 'accepted'] as const;

export interface TaskListFilters {
  readonly status?: TaskRow['status'] | undefined;
  readonly priority?: TaskRow['priority'] | undefined;
  readonly assigneeUserId?: string | undefined;
  readonly assigneeType?: 'none' | 'user' | 'agent' | undefined;
  readonly tag?: string | undefined;
  readonly search?: string | undefined;
}

export interface ClaimInput {
  readonly taskId: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly agentRunId: string | null;
  readonly expiresAt: Date;
  readonly scope: Record<string, unknown> | null;
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  /**
   * Reserva o próximo número curto do projeto.
   *
   * Mesmo mecanismo de `conversations.last_sequence`, e pela mesma razão: o
   * `UPDATE` toma o lock da linha do projeto, e o `SELECT` seguinte, dentro da
   * mesma transação, lê o valor recém-escrito. `MAX(number) + 1` corre com
   * outra criação simultânea e produz duas tarefas com o mesmo `#n` — que o
   * unique `(project_id, number)` transformaria em erro 500.
   */
  static async nextNumber(tx: TransactionExecutor, projectId: string): Promise<number> {
    await tx
      .createQueryBuilder()
      .update(projects)
      .set({ lastTaskNumber: () => 'last_task_number + 1' })
      .where('id = :projectId', { projectId })
      .execute();

    const rows: { lastTaskNumber: number | string }[] = await tx.query(
      'SELECT last_task_number AS lastTaskNumber FROM projects WHERE id = ? LIMIT 1',
      [projectId],
    );

    const number = rows[0]?.lastTaskNumber;

    if (number === undefined) {
      throw new Error(`O projeto ${projectId} não existe mais.`);
    }

    return Number(number);
  }

  async listForProject(input: {
    projectId: string;
    limit: number;
    cursor: string | undefined;
    filters: TaskListFilters;
  }): Promise<TaskRow[]> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const query = this.db.manager
      .createQueryBuilder(tasks, 'task')
      .select(TASK_COLUMNS.map((column) => `task.${column}`))
      .where('task.projectId = :projectId', { projectId: input.projectId });

    applyKeyset(query, 'task', { createdAt: 'createdAt', id: 'id' }, after);

    if (input.filters.status !== undefined) {
      query.andWhere('task.status = :status', { status: input.filters.status });
    }

    if (input.filters.priority !== undefined) {
      query.andWhere('task.priority = :priority', { priority: input.filters.priority });
    }

    if (input.filters.search !== undefined && input.filters.search !== '') {
      query.andWhere('task.title LIKE :search', {
        search: `%${escapeLike(input.filters.search)}%`,
      });
    }

    if (input.filters.tag !== undefined && input.filters.tag !== '') {
      // `JSON_CONTAINS` casa com o elemento inteiro, não com um pedaço dele —
      // `?tag=api` não pode trazer a tarefa etiquetada como `api-gateway`.
      query.andWhere('json_contains(task.tags, :tag)', {
        tag: JSON.stringify(input.filters.tag),
      });
    }

    if (input.filters.assigneeUserId !== undefined) {
      query.andWhere(
        `exists (select 1 from task_assignments a
                  where a.task_id = task.id
                    and a.assignee_type = 'user'
                    and a.assignee_id = :assigneeUserId
                    and a.status in (:...liveStatuses))`,
        { assigneeUserId: input.filters.assigneeUserId, liveStatuses: [...LIVE_ASSIGNMENT_STATUSES] },
      );
    }

    if (input.filters.assigneeType !== undefined) {
      if (input.filters.assigneeType === 'none') {
        query.andWhere(
          `not exists (select 1 from task_assignments a
                        where a.task_id = task.id
                          and a.status in (:...liveStatuses))`,
          { liveStatuses: [...LIVE_ASSIGNMENT_STATUSES] },
        );
      } else {
        const assigneeType = input.filters.assigneeType === 'agent' ? 'agent_profile' : 'user';
        query.andWhere(
          `exists (select 1 from task_assignments a
                    where a.task_id = task.id
                      and a.assignee_type = :assigneeType
                      and a.status in (:...liveStatuses))`,
          { assigneeType, liveStatuses: [...LIVE_ASSIGNMENT_STATUSES] },
        );
      }
    }

    const rows = await query
      .orderBy('task.createdAt', 'DESC')
      .addOrderBy('task.id', 'DESC')
      .limit(input.limit + 1)
      .getMany();

    return rows;
  }

  async findById(taskId: string): Promise<TaskRow | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(tasks, 'task')
      .select(TASK_COLUMNS.map((column) => `task.${column}`))
      .where('task.id = :taskId', { taskId })
      .getOne();

    return row ?? undefined;
  }

  /** Tarefas do projeto entre os IDs pedidos; valida dependências. */
  async idsInProject(projectId: string, taskIds: string[]): Promise<Set<string>> {
    if (taskIds.length === 0) {
      return new Set();
    }

    const rows = await this.db.manager
      .createQueryBuilder(tasks, 'task')
      .select('task.id')
      .where('task.projectId = :projectId', { projectId })
      .andWhere('task.id IN (:...taskIds)', { taskIds })
      .getMany();

    return new Set(rows.map((row) => row.id));
  }

  async assignmentsOf(taskIds: string[]): Promise<Map<string, AssignmentRow>> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const rows: AssignmentRow[] = await this.db.manager
      .createQueryBuilder(taskAssignments, 'assignment')
      .select('assignment.task_id', 'taskId')
      .addSelect('assignment.assignee_type', 'assigneeType')
      .addSelect('assignment.assignee_id', 'assigneeId')
      .addSelect('member.display_name', 'userName')
      .addSelect('member.email', 'userEmail')
      .addSelect('member.avatar_url', 'userAvatarUrl')
      .leftJoin(
        users.options.name,
        'member',
        "member.id = assignment.assignee_id AND assignment.assignee_type = 'user'",
      )
      .where('assignment.task_id IN (:...taskIds)', { taskIds })
      .andWhere('assignment.status IN (:...liveStatuses)', {
        liveStatuses: [...LIVE_ASSIGNMENT_STATUSES],
      })
      .orderBy('assignment.assigned_at', 'DESC')
      .getRawMany();

    const latest = new Map<string, AssignmentRow>();

    for (const row of rows) {
      // A consulta vem da mais recente para a mais antiga: a primeira que
      // aparece por tarefa é a que vale.
      if (!latest.has(row.taskId)) {
        latest.set(row.taskId, row);
      }
    }

    return latest;
  }

  async dependenciesOf(taskIds: string[]): Promise<Map<string, string[]>> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const rows: DependencyRow[] = await this.db.manager
      .createQueryBuilder(taskDependencies, 'dependency')
      .select(['dependency.taskId', 'dependency.dependsOnTaskId'])
      .where('dependency.taskId IN (:...taskIds)', { taskIds })
      .getMany();

    const grouped = new Map<string, string[]>();

    for (const row of rows) {
      const list = grouped.get(row.taskId) ?? [];

      list.push(row.dependsOnTaskId);
      grouped.set(row.taskId, list);
    }

    return grouped;
  }

  /** Cria a tarefa, suas dependências, sua atribuição e o evento — em uma transação. */
  async create(input: {
    organizationId: string;
    projectId: string;
    conversationId: string | null;
    title: string;
    description: string | null;
    priority: TaskRow['priority'];
    tags: string[];
    scope: Record<string, unknown> | null;
    dueAt: Date | null;
    dependsOn: string[];
    assignee: { type: 'user' | 'agent_profile'; id: string } | null;
    createdBy: string;
    onCommitted: (tx: TransactionExecutor, created: TaskRow) => Promise<void>;
  }): Promise<string> {
    const taskId = newId();

    await runInTransaction(this.db, async (tx) => {
      const number = await TaskRepository.nextNumber(tx, input.projectId);
      const createdAt = new Date();

      await tx.insert(
        tasks,
        writable<Task>({
          id: taskId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          number,
          title: input.title,
          description: input.description,
          // A tarefa nasce em `ready` quando não depende de ninguém e em
          // `blocked` quando depende: o estado inicial já diz se ela é trabalho
          // disponível, e é isso que a fila de reivindicação lê.
          status: input.dependsOn.length > 0 ? 'blocked' : 'ready',
          priority: input.priority,
          tags: input.tags,
          scope: input.scope,
          dueAt: input.dueAt,
          createdBy: input.createdBy,
          createdAt,
          updatedAt: createdAt,
        }),
      );

      if (input.dependsOn.length > 0) {
        await tx.insert(
          taskDependencies,
          input.dependsOn.map((dependsOnTaskId) => ({
            taskId,
            dependsOnTaskId,
            type: 'blocks' as const,
            organizationId: input.organizationId,
            createdBy: input.createdBy,
          })),
        );
      }

      if (input.assignee !== null) {
        await tx.insert(taskAssignments, {
          id: newId(),
          organizationId: input.organizationId,
          taskId,
          assigneeType: input.assignee.type,
          assigneeId: input.assignee.id,
          status: 'assigned' as const,
          assignedBy: input.createdBy,
          assignedAt: createdAt,
        });
      }

      const created = await readTask(tx, taskId);

      await input.onCommitted(tx, created);
    });

    return taskId;
  }

  /**
   * Atualiza a tarefa com concorrência otimista e grava o evento na mesma
   * transação. Devolve `undefined` quando a versão não confere.
   */
  async update(input: {
    task: TaskRow;
    version: number;
    fields: Record<string, unknown>;
    dependsOn: string[] | undefined;
    assignee: { type: 'user' | 'agent_profile'; id: string } | null | undefined;
    actorId: string;
    onCommitted: (tx: TransactionExecutor, updated: TaskRow) => Promise<void>;
  }): Promise<TaskRow | undefined> {
    return runInTransaction(this.db, async (tx) => {
      const result = await tx
        .createQueryBuilder()
        .update(tasks)
        .set({
          ...input.fields,
          version: () => 'version + 1',
          updatedAt: new Date(),
        })
        .where('id = :id', { id: input.task.id })
        .andWhere('version = :version', { version: input.version })
        .execute();

      if (affectedRows(result) === 0) {
        return undefined;
      }

      if (input.dependsOn !== undefined) {
        await tx.delete(taskDependencies, { taskId: input.task.id });

        if (input.dependsOn.length > 0) {
          await tx.insert(
            taskDependencies,
            input.dependsOn.map((dependsOnTaskId) => ({
              taskId: input.task.id,
              dependsOnTaskId,
              type: 'blocks' as const,
              organizationId: input.task.organizationId,
              createdBy: input.actorId,
            })),
          );
        }
      }

      if (input.assignee !== undefined) {
        // Atribuição anterior vira `released` em vez de sumir: o histórico de
        // quem já respondeu pela tarefa é o que sustenta a auditoria.
        await tx
          .createQueryBuilder()
          .update(taskAssignments)
          .set({ status: 'released', releasedAt: new Date() })
          .where('task_id = :taskId', { taskId: input.task.id })
          .andWhere('status IN (:...liveStatuses)', {
            liveStatuses: [...LIVE_ASSIGNMENT_STATUSES],
          })
          .execute();

        if (input.assignee !== null) {
          await tx.insert(taskAssignments, {
            id: newId(),
            organizationId: input.task.organizationId,
            taskId: input.task.id,
            assigneeType: input.assignee.type,
            assigneeId: input.assignee.id,
            status: 'assigned' as const,
            assignedBy: input.actorId,
            assignedAt: new Date(),
          });
        }
      }

      const updated = await readTask(tx, input.task.id);

      await input.onCommitted(tx, updated);

      return updated;
    });
  }

  /**
   * Reivindica a tarefa.
   *
   * **A decisão é do banco.** O `UPDATE` condicional só afeta a linha se ela
   * ainda estiver disponível; se duas transações tentarem ao mesmo tempo, a
   * segunda espera o lock da primeira, reavalia o `WHERE` contra o estado já
   * comitado e não afeta nada. Ler antes e escrever depois abriria exatamente a
   * janela em que as duas se acham vencedoras.
   *
   * "Disponível" quer dizer uma destas três:
   *
   * - ninguém reivindicou (`claim_expires_at IS NULL`);
   * - a reivindicação venceu (`claim_expires_at <= agora`) — é isto que impede
   *   que quem reivindicou e sumiu trave a tarefa para sempre;
   * - quem reivindicou é quem está chamando agora, e só quer renovar o prazo.
   */
  async claim(
    input: ClaimInput & {
      onCommitted: (tx: TransactionExecutor, claimed: TaskRow) => Promise<void>;
    },
  ): Promise<TaskRow | undefined> {
    return runInTransaction(this.db, async (tx) => {
      const now = new Date();
      const result = await tx
        .createQueryBuilder()
        .update(tasks)
        .set({
          ...writable<Task>({
            status: 'claimed',
            claimedByUserId: input.userId,
            claimedByDeviceId: input.deviceId,
            claimedByAgentRunId: input.agentRunId,
            claimedAt: now,
            claimExpiresAt: input.expiresAt,
            ...(input.scope === null ? {} : { scope: input.scope }),
            updatedAt: now,
          }),
          version: () => 'version + 1',
        })
        .where('id = :id', { id: input.taskId })
        .andWhere('status IN (:...claimable)', { claimable: [...CLAIMABLE_STATUSES] })
        .andWhere(
          '(claim_expires_at IS NULL OR claim_expires_at <= :now OR claimed_by_user_id = :userId)',
          { now, userId: input.userId },
        )
        .execute();

      if (affectedRows(result) === 0) {
        return undefined;
      }

      const claimed = await readTask(tx, input.taskId);

      await input.onCommitted(tx, claimed);

      return claimed;
    });
  }

  /**
   * Solta a tarefa.
   *
   * `claimed_by_user_id = ?` no `WHERE` é o que faz soltar tarefa alheia
   * falhar: nenhuma linha é afetada, e quem chamou recebe
   * `TASK_NOT_CLAIMED_BY_ACTOR`. A verificação e a escrita são o mesmo comando,
   * então não há janela entre uma e outra.
   */
  async release(input: {
    taskId: string;
    userId: string;
    status: TaskRow['status'];
    onCommitted: (tx: TransactionExecutor, released: TaskRow) => Promise<void>;
  }): Promise<TaskRow | undefined> {
    return runInTransaction(this.db, async (tx) => {
      const result = await tx
        .createQueryBuilder()
        .update(tasks)
        .set({
          status: input.status,
          claimedByUserId: null,
          claimedByDeviceId: null,
          claimedByAgentRunId: null,
          claimedAt: null,
          claimExpiresAt: null,
          ...(input.status === 'done' ? { completedAt: new Date() } : {}),
          version: () => 'version + 1',
          updatedAt: new Date(),
        })
        .where('id = :id', { id: input.taskId })
        .andWhere('claimed_by_user_id = :userId', { userId: input.userId })
        .execute();

      if (affectedRows(result) === 0) {
        return undefined;
      }

      const released = await readTask(tx, input.taskId);

      await input.onCommitted(tx, released);

      return released;
    });
  }

  /**
   * Devolve à fila as tarefas cuja reivindicação venceu.
   *
   * Sem esta varredura, a expiração seria só um campo bonito: a tarefa
   * continuaria em `claimed` para sempre, e a lista mostraria trabalho preso a
   * um dispositivo que não existe mais. Cada devolução gera `task.released`,
   * como qualquer outra — quem escuta o WebSocket não precisa saber que a causa
   * foi o relógio.
   *
   * `SKIP LOCKED` deixa duas instâncias varrerem ao mesmo tempo sem disputarem
   * as mesmas linhas. É SQL cru porque o `FOR UPDATE SKIP LOCKED` do query
   * builder só existe em consultas de entidade, e aqui interessa apenas o `id`.
   */
  async releaseExpired(input: {
    projectId: string;
    now?: Date;
    limit?: number;
    onCommitted: (tx: TransactionExecutor, released: TaskRow) => Promise<void>;
  }): Promise<TaskRow[]> {
    const now = input.now ?? new Date();

    return runInTransaction(this.db, async (tx) => {
      const candidates: { id: string }[] = await tx.query(
        `select id from tasks
          where project_id = ?
            and status = 'claimed'
            and claim_expires_at is not null
            and claim_expires_at <= ?
          limit ${input.limit ?? 50}
          for update skip locked`,
        [input.projectId, now],
      );

      const released: TaskRow[] = [];

      for (const candidate of candidates) {
        const result = await tx
          .createQueryBuilder()
          .update(tasks)
          .set({
            status: 'ready',
            claimedByUserId: null,
            claimedByDeviceId: null,
            claimedByAgentRunId: null,
            claimedAt: null,
            claimExpiresAt: null,
            version: () => 'version + 1',
            updatedAt: now,
          })
          .where('id = :id', { id: candidate.id })
          .andWhere("status = 'claimed'")
          .andWhere('claim_expires_at <= :now', { now })
          .execute();

        if (affectedRows(result) === 0) {
          continue;
        }

        const row = await readTask(tx, candidate.id);

        await input.onCommitted(tx, row);
        released.push(row);
      }

      return released;
    });
  }

  /** Tarefa já criada com a mesma chave de idempotência (ver módulo de mensagens). */
  async findByIdempotencyKey(dedupeKey: string): Promise<string | undefined> {
    const row = await this.db.manager
      .createQueryBuilder(outboxMessages, 'outbox')
      .select('outbox.aggregateId')
      .where('outbox.dedupeKey = :dedupeKey', { dedupeKey })
      .getOne();

    return row?.aggregateId;
  }

  /**
   * Libera as tarefas que só estavam esperando esta.
   *
   * Sem isto, uma tarefa criada com `dependsOn` nasceria `blocked` e ficaria
   * assim para sempre: nada mais no sistema olharia a dependência de novo, e o
   * trabalho desapareceria da fila justamente quando ficou pronto para começar.
   *
   * A condição é `NOT EXISTS` de bloqueador em aberto — e não "o bloqueador que
   * acabou de terminar", porque uma tarefa pode depender de várias. O `FOR
   * UPDATE` segura as candidatas até o fim da transação, para que duas
   * conclusões simultâneas não desbloqueiem a mesma tarefa duas vezes.
   */
  async unblockDependents(input: {
    tx: TransactionExecutor;
    completedTaskId: string;
    at: Date;
  }): Promise<string[]> {
    const candidates: { id: string }[] = await input.tx.query(
      `select t.id
         from tasks t
         join task_dependencies d on d.task_id = t.id
        where d.depends_on_task_id = ?
          and d.type = 'blocks'
          and t.status = 'blocked'
          and not exists (
                select 1
                  from task_dependencies other
                  join tasks blocker on blocker.id = other.depends_on_task_id
                 where other.task_id = t.id
                   and other.type = 'blocks'
                   and blocker.status not in ('done', 'cancelled')
              )
        for update`,
      [input.completedTaskId],
    );

    const unblocked: string[] = [];

    for (const candidate of candidates) {
      const result = await input.tx
        .createQueryBuilder()
        .update(tasks)
        .set({
          status: 'ready',
          version: () => 'version + 1',
          updatedAt: input.at,
        })
        .where('id = :id', { id: candidate.id })
        .andWhere("status = 'blocked'")
        .execute();

      if (affectedRows(result) > 0) {
        unblocked.push(candidate.id);
      }
    }

    return unblocked;
  }

  /** Lê a tarefa de dentro de uma transação em curso. */
  async readInTransaction(tx: TransactionExecutor, taskId: string): Promise<TaskRow> {
    return readTask(tx, taskId);
  }
}

/** Lê a tarefa de dentro da transação, já com as colunas do contrato. */
async function readTask(tx: TransactionExecutor, taskId: string): Promise<TaskRow> {
  const row = await tx
    .createQueryBuilder(tasks, 'task')
    .select(TASK_COLUMNS.map((column) => `task.${column}`))
    .where('task.id = :taskId', { taskId })
    .getOne();

  if (row === null) {
    throw new Error(`A tarefa ${taskId} sumiu no meio da transação.`);
  }

  return row;
}
