// Orquestração: tarefas, execuções de agente, aprovações, revisões e artefatos.
//
// É o grupo com mais eventos de tempo real (`Docs/08`); por isso quase toda
// tabela tem um índice `(…, status, updated_at)` ou `(…, created_at)` para as
// listas do Hub Web e para a retomada por cursor.

import {
  bigint,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

import { agentProfiles, autonomyLevel, projects, workMode } from './project.js';
import { conversations } from './chat.js';
import { devices, users } from './identity.js';
import { organizations } from './organization.js';
import {
  auditColumns,
  createdAt,
  organizationId,
  primaryId,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
} from './columns.js';

export const taskStatus = [
  'backlog',
  'ready',
  'claimed',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
  'failed',
] as const;
export const taskPriority = ['low', 'normal', 'high', 'urgent'] as const;

export const tasks = mysqlTable(
  'tasks',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Conversa que originou a tarefa, quando houver.
    conversationId: ulidColumn('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    parentTaskId: ulidColumn('parent_task_id'),
    // Número curto por projeto, para as pessoas ("#42"). O ULID continua sendo
    // a identidade real.
    number: int('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: mediumtext('description'),
    status: mysqlEnum('status', taskStatus).notNull().default('backlog'),
    priority: mysqlEnum('priority', taskPriority).notNull().default('normal'),
    workMode: mysqlEnum('work_mode', workMode).notNull().default('plan'),
    autonomy: mysqlEnum('autonomy', autonomyLevel).notNull().default('manual'),
    // Escopo reservado pela tarefa (arquivos/diretórios), base dos eventos
    // `scope.reserved` e `scope.conflict` do `Docs/08`.
    scope: json('scope').$type<Record<string, unknown>>(),
    branchName: varchar('branch_name', { length: 255 }),
    claimedByDeviceId: ulidColumn('claimed_by_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    claimedByUserId: ulidColumn('claimed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    claimedAt: utcDatetime('claimed_at'),
    startedAt: utcDatetime('started_at'),
    completedAt: utcDatetime('completed_at'),
    dueAt: utcDatetime('due_at'),
    blockedReason: varchar('blocked_reason', { length: 512 }),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_tasks_project_number').on(table.projectId, table.number),
    index('idx_tasks_project_status_updated_at').on(table.projectId, table.status, table.updatedAt),
    index('idx_tasks_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_tasks_parent').on(table.parentTaskId),
  ],
);

/** Natureza da dependência entre tarefas. */
export const taskDependencyType = ['blocks', 'relates_to', 'duplicates'] as const;

export const taskDependencies = mysqlTable(
  'task_dependencies',
  {
    taskId: ulidColumn('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: ulidColumn('depends_on_task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', taskDependencyType).notNull().default('blocks'),
    organizationId: organizationId(),
    createdAt: createdAt(),
    createdBy: ulidColumn('created_by'),
  },
  // Junção pura: o par já é a identidade.
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    index('idx_task_dependencies_depends_on').on(table.dependsOnTaskId),
  ],
);

export const assigneeType = ['user', 'agent_profile'] as const;
export const assignmentStatus = ['assigned', 'accepted', 'released', 'completed', 'failed'] as const;

export const taskAssignments = mysqlTable(
  'task_assignments',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    taskId: ulidColumn('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    assigneeType: mysqlEnum('assignee_type', assigneeType).notNull(),
    // Referência polimórfica: `users.id` ou `agent_profiles.id`.
    assigneeId: ulidColumn('assignee_id').notNull(),
    agentRunId: ulidColumn('agent_run_id'),
    status: mysqlEnum('status', assignmentStatus).notNull().default('assigned'),
    assignedBy: ulidColumn('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: utcDatetime('assigned_at').notNull(),
    acceptedAt: utcDatetime('accepted_at'),
    releasedAt: utcDatetime('released_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    index('idx_task_assignments_task_created_at').on(table.taskId, table.createdAt),
    index('idx_task_assignments_assignee').on(table.assigneeType, table.assigneeId, table.status),
    index('idx_task_assignments_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const agentRunStatus = [
  'queued',
  'starting',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
/** Onde o agente roda: máquina do usuário ou infraestrutura do Hub. */
export const agentRunMode = ['local', 'remote'] as const;

export const agentRuns = mysqlTable(
  'agent_runs',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: ulidColumn('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    conversationId: ulidColumn('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    agentProfileId: ulidColumn('agent_profile_id').references(() => agentProfiles.id, {
      onDelete: 'set null',
    }),
    deviceId: ulidColumn('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // ID da sessão no CLI/adaptador, para retomada (`Docs/04`).
    externalSessionId: varchar('external_session_id', { length: 191 }),
    status: mysqlEnum('status', agentRunStatus).notNull().default('queued'),
    mode: mysqlEnum('mode', agentRunMode).notNull().default('local'),
    workMode: mysqlEnum('work_mode', workMode).notNull().default('plan'),
    autonomy: mysqlEnum('autonomy', autonomyLevel).notNull().default('manual'),
    startedAt: utcDatetime('started_at'),
    finishedAt: utcDatetime('finished_at'),
    heartbeatAt: utcDatetime('heartbeat_at'),
    exitCode: int('exit_code'),
    errorCode: varchar('error_code', { length: 96 }),
    errorMessage: text('error_message'),
    inputTokens: int('input_tokens'),
    outputTokens: int('output_tokens'),
    // Custo em inteiro na menor unidade da moeda.
    costCents: int('cost_cents'),
    // Result Package resumido (`Docs/10`); o detalhe vai para `artifacts`.
    resultSummary: mediumtext('result_summary'),
    ...auditColumns(),
  },
  (table) => [
    index('idx_agent_runs_project_status_updated_at').on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
    index('idx_agent_runs_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_agent_runs_task_created_at').on(table.taskId, table.createdAt),
    index('idx_agent_runs_heartbeat').on(table.status, table.heartbeatAt),
  ],
);

export const agentRunEvents = mysqlTable(
  'agent_run_events',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    agentRunId: ulidColumn('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    // Ordem por agregado, exigida pelas garantias do `Docs/08`.
    sequence: bigint('sequence', { mode: 'number', unsigned: true }).notNull(),
    type: varchar('type', { length: 96 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>(),
    occurredAt: utcDatetime('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_agent_run_events_run_sequence').on(table.agentRunId, table.sequence),
    index('idx_agent_run_events_run_occurred_at').on(table.agentRunId, table.occurredAt),
    index('idx_agent_run_events_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

/** O que está sendo aprovado. `bypass` é o break-glass local do `Docs/09`. */
export const approvalKind = [
  'tool_call',
  'file_write',
  'command',
  'merge',
  'remote_start',
  'knowledge_publish',
  'bypass',
] as const;
export const approvalStatus = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export const riskLevel = ['low', 'medium', 'high'] as const;
/** Quem pediu a aprovação. */
export const requesterType = ['user', 'agent', 'system'] as const;

export const approvals = mysqlTable(
  'approvals',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    taskId: ulidColumn('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    agentRunId: ulidColumn('agent_run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    conversationId: ulidColumn('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    kind: mysqlEnum('kind', approvalKind).notNull(),
    status: mysqlEnum('status', approvalStatus).notNull().default('pending'),
    risk: mysqlEnum('risk', riskLevel).notNull().default('medium'),
    // Descrição estruturada do que será feito (comando, arquivos, diff).
    subject: json('subject').$type<Record<string, unknown>>(),
    requestedByType: mysqlEnum('requested_by_type', requesterType).notNull(),
    requestedById: ulidColumn('requested_by_id'),
    decidedByUserId: ulidColumn('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: utcDatetime('decided_at'),
    expiresAt: utcDatetime('expires_at'),
    reason: varchar('reason', { length: 512 }),
    ...auditColumns(),
  },
  (table) => [
    index('idx_approvals_org_status_created_at').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index('idx_approvals_task_created_at').on(table.taskId, table.createdAt),
    index('idx_approvals_run').on(table.agentRunId, table.status),
  ],
);

export const reviewStatus = ['pending', 'approved', 'changes_requested', 'rejected'] as const;

export const reviews = mysqlTable(
  'reviews',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: ulidColumn('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    agentRunId: ulidColumn('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    // Artefato revisado (diff, PR). Sem FK: `artifacts` é definido adiante e a
    // ida e volta criaria referência circular entre as duas tabelas.
    artifactId: ulidColumn('artifact_id'),
    reviewerUserId: ulidColumn('reviewer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: mysqlEnum('status', reviewStatus).notNull().default('pending'),
    summary: mediumtext('summary'),
    checklist: json('checklist').$type<Record<string, unknown>>(),
    submittedAt: utcDatetime('submitted_at'),
    decidedAt: utcDatetime('decided_at'),
    ...auditColumns(),
  },
  (table) => [
    index('idx_reviews_task_created_at').on(table.taskId, table.createdAt),
    index('idx_reviews_project_status_updated_at').on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
    index('idx_reviews_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const artifactType = [
  'diff',
  'patch',
  'file',
  'report',
  'test_result',
  'commit',
  'pull_request',
  'log',
] as const;

export const artifacts = mysqlTable(
  'artifacts',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: ulidColumn('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: ulidColumn('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    agentRunId: ulidColumn('agent_run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', artifactType).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    // Conteúdo grande fica no storage isolado; aqui vai a chave ou a URI.
    storageKey: varchar('storage_key', { length: 512 }),
    uri: varchar('uri', { length: 1024 }),
    mimeType: varchar('mime_type', { length: 191 }),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    metadata: json('metadata').$type<Record<string, unknown>>(),
    ...auditColumns(),
  },
  (table) => [
    index('idx_artifacts_task_created_at').on(table.taskId, table.createdAt),
    index('idx_artifacts_run_created_at').on(table.agentRunId, table.createdAt),
    index('idx_artifacts_org_created_at').on(table.organizationId, table.createdAt),
  ],
);
