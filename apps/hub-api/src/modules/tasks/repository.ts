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
  taskAssignments,
  taskDependencies,
  tasks,
  users,
  type Database,
} from '@prometheon/database';
import { and, desc, eq, inArray, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor } from '../../shared/cursor.js';
import { affectedRows, allRows, escapeLike, keysetCondition } from '../projects/repository.js';
import type { AssignmentRow, DependencyRow, TaskRow } from './types.js';

export type TransactionExecutor = Parameters<Parameters<Database['transaction']>[0]>[0];

const taskColumns = {
  id: tasks.id,
  organizationId: tasks.organizationId,
  projectId: tasks.projectId,
  conversationId: tasks.conversationId,
  number: tasks.number,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  tags: tasks.tags,
  scope: tasks.scope,
  claimedByUserId: tasks.claimedByUserId,
  claimedByDeviceId: tasks.claimedByDeviceId,
  claimedByAgentRunId: tasks.claimedByAgentRunId,
  claimedAt: tasks.claimedAt,
  claimExpiresAt: tasks.claimExpiresAt,
  dueAt: tasks.dueAt,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  createdBy: tasks.createdBy,
  version: tasks.version,
} as const;

/** Estados em que a tarefa ainda é trabalho a fazer. */
export const CLAIMABLE_STATUSES = ['backlog', 'ready', 'claimed', 'in_progress'] as const;

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
      .update(projects)
      .set({ lastTaskNumber: sql`${projects.lastTaskNumber} + 1` })
      .where(eq(projects.id, projectId));

    const rows = await tx
      .select({ lastTaskNumber: projects.lastTaskNumber })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const number = rows[0]?.lastTaskNumber;

    if (number === undefined) {
      throw new Error(`O projeto ${projectId} não existe mais.`);
    }

    return number;
  }

  async listForProject(input: {
    projectId: string;
    limit: number;
    cursor: string | undefined;
    filters: TaskListFilters;
  }): Promise<TaskRow[]> {
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const conditions: (SQL | undefined)[] = [
      eq(tasks.projectId, input.projectId),
      keysetCondition(tasks.createdAt, tasks.id, after),
    ];

    if (input.filters.status !== undefined) {
      conditions.push(eq(tasks.status, input.filters.status));
    }

    if (input.filters.priority !== undefined) {
      conditions.push(eq(tasks.priority, input.filters.priority));
    }

    if (input.filters.search !== undefined && input.filters.search !== '') {
      conditions.push(like(tasks.title, `%${escapeLike(input.filters.search)}%`));
    }

    if (input.filters.tag !== undefined && input.filters.tag !== '') {
      conditions.push(sql`json_contains(${tasks.tags}, ${JSON.stringify(input.filters.tag)})`);
    }

    if (input.filters.assigneeUserId !== undefined) {
      conditions.push(
        sql`exists (select 1 from task_assignments a
                     where a.task_id = ${tasks.id}
                       and a.assignee_type = 'user'
                       and a.assignee_id = ${input.filters.assigneeUserId}
                       and a.status in ('assigned', 'accepted'))`,
      );
    }

    if (input.filters.assigneeType !== undefined) {
      const assigneeType = input.filters.assigneeType === 'agent' ? 'agent_profile' : 'user';

      conditions.push(
        input.filters.assigneeType === 'none'
          ? sql`not exists (select 1 from task_assignments a
                             where a.task_id = ${tasks.id}
                               and a.status in ('assigned', 'accepted'))`
          : sql`exists (select 1 from task_assignments a
                         where a.task_id = ${tasks.id}
                           and a.assignee_type = ${assigneeType}
                           and a.status in ('assigned', 'accepted'))`,
      );
    }

    return this.db
      .select(taskColumns)
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(input.limit + 1);
  }

  async findById(taskId: string): Promise<TaskRow | undefined> {
    const rows = await this.db
      .select(taskColumns)
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    return rows[0];
  }

  /** Tarefas do projeto entre os IDs pedidos; valida dependências. */
  async idsInProject(projectId: string, taskIds: string[]): Promise<Set<string>> {
    if (taskIds.length === 0) {
      return new Set();
    }

    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.id, taskIds)));

    return new Set(rows.map((row) => row.id));
  }

  async assignmentsOf(taskIds: string[]): Promise<Map<string, AssignmentRow>> {
    if (taskIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select({
        taskId: taskAssignments.taskId,
        assigneeType: taskAssignments.assigneeType,
        assigneeId: taskAssignments.assigneeId,
        userName: users.displayName,
        userEmail: users.email,
        userAvatarUrl: users.avatarUrl,
      })
      .from(taskAssignments)
      .leftJoin(
        users,
        and(
          eq(users.id, taskAssignments.assigneeId),
          eq(taskAssignments.assigneeType, 'user'),
        ),
      )
      .where(
        and(
          inArray(taskAssignments.taskId, taskIds),
          inArray(taskAssignments.status, ['assigned', 'accepted']),
        ),
      )
      .orderBy(desc(taskAssignments.assignedAt));

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

    const rows: DependencyRow[] = await this.db
      .select({
        taskId: taskDependencies.taskId,
        dependsOnTaskId: taskDependencies.dependsOnTaskId,
      })
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, taskIds));

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

    await this.db.transaction(async (tx) => {
      const number = await TaskRepository.nextNumber(tx, input.projectId);
      const createdAt = new Date();

      await tx.insert(tasks).values({
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
      });

      if (input.dependsOn.length > 0) {
        await tx.insert(taskDependencies).values(
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
        await tx.insert(taskAssignments).values({
          id: newId(),
          organizationId: input.organizationId,
          taskId,
          assigneeType: input.assignee.type,
          assigneeId: input.assignee.id,
          status: 'assigned',
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
    return this.db.transaction(async (tx) => {
      const result = await tx
        .update(tasks)
        .set({
          ...input.fields,
          version: sql`${tasks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, input.task.id), eq(tasks.version, input.version)));

      if (affectedRows(result) === 0) {
        return undefined;
      }

      if (input.dependsOn !== undefined) {
        await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, input.task.id));

        if (input.dependsOn.length > 0) {
          await tx.insert(taskDependencies).values(
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
          .update(taskAssignments)
          .set({ status: 'released', releasedAt: new Date() })
          .where(
            and(
              eq(taskAssignments.taskId, input.task.id),
              inArray(taskAssignments.status, ['assigned', 'accepted']),
            ),
          );

        if (input.assignee !== null) {
          await tx.insert(taskAssignments).values({
            id: newId(),
            organizationId: input.task.organizationId,
            taskId: input.task.id,
            assigneeType: input.assignee.type,
            assigneeId: input.assignee.id,
            status: 'assigned',
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
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const result = await tx
        .update(tasks)
        .set({
          status: 'claimed',
          claimedByUserId: input.userId,
          claimedByDeviceId: input.deviceId,
          claimedByAgentRunId: input.agentRunId,
          claimedAt: now,
          claimExpiresAt: input.expiresAt,
          ...(input.scope === null ? {} : { scope: input.scope }),
          version: sql`${tasks.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            inArray(tasks.status, [...CLAIMABLE_STATUSES]),
            or(
              isNull(tasks.claimExpiresAt),
              lte(tasks.claimExpiresAt, now),
              eq(tasks.claimedByUserId, input.userId),
            ),
          ),
        );

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
    return this.db.transaction(async (tx) => {
      const result = await tx
        .update(tasks)
        .set({
          status: input.status,
          claimedByUserId: null,
          claimedByDeviceId: null,
          claimedByAgentRunId: null,
          claimedAt: null,
          claimExpiresAt: null,
          ...(input.status === 'done' ? { completedAt: new Date() } : {}),
          version: sql`${tasks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.claimedByUserId, input.userId)));

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
   * as mesmas linhas.
   */
  async releaseExpired(input: {
    projectId: string;
    now?: Date;
    limit?: number;
    onCommitted: (tx: TransactionExecutor, released: TaskRow) => Promise<void>;
  }): Promise<TaskRow[]> {
    const now = input.now ?? new Date();

    return this.db.transaction(async (tx) => {
      const candidates = allRows<{ id: string }>(
        await tx.execute(sql`
          select id from tasks
           where project_id = ${input.projectId}
             and status = 'claimed'
             and claim_expires_at is not null
             and claim_expires_at <= ${now}
           limit ${input.limit ?? 50}
           for update skip locked
        `),
      );

      const released: TaskRow[] = [];

      for (const candidate of candidates) {
        const result = await tx
          .update(tasks)
          .set({
            status: 'ready',
            claimedByUserId: null,
            claimedByDeviceId: null,
            claimedByAgentRunId: null,
            claimedAt: null,
            claimExpiresAt: null,
            version: sql`${tasks.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(tasks.id, candidate.id),
              eq(tasks.status, 'claimed'),
              lte(tasks.claimExpiresAt, now),
            ),
          );

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
    const rows = await this.db
      .select({ aggregateId: outboxMessages.aggregateId })
      .from(outboxMessages)
      .where(eq(outboxMessages.dedupeKey, dedupeKey))
      .limit(1);

    return rows[0]?.aggregateId;
  }

  /**
   * Libera as tarefas que só estavam esperando esta.
   *
   * Sem isto, uma tarefa criada com `dependsOn` nasceria `blocked` e ficaria
   * assim para sempre: nada mais no sistema olharia a dependência de novo, e o
   * trabalho desapareceria da fila justamente quando ficou pronto para começar.
   *
   * A condição é `NOT EXISTS` de bloqueador em aberto — e não "o bloqueador que
   * acabou de terminar", porque uma tarefa pode depender de várias.
   */
  async unblockDependents(input: {
    tx: TransactionExecutor;
    completedTaskId: string;
    at: Date;
  }): Promise<string[]> {
    const candidates = allRows<{ id: string }>(
      await input.tx.execute(sql`
        select t.id
          from tasks t
          join task_dependencies d on d.task_id = t.id
         where d.depends_on_task_id = ${input.completedTaskId}
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
         for update
      `),
    );

    const unblocked: string[] = [];

    for (const candidate of candidates) {
      const result = await input.tx
        .update(tasks)
        .set({
          status: 'ready',
          version: sql`${tasks.version} + 1`,
          updatedAt: input.at,
        })
        .where(and(eq(tasks.id, candidate.id), eq(tasks.status, 'blocked')));

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
  const rows = await tx.select(taskColumns).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`A tarefa ${taskId} sumiu no meio da transação.`);
  }

  return row;
}
