// Orquestração: tarefas, execuções de agente, aprovações, revisões e artefatos.
//
// É o grupo com mais eventos de tempo real (`Docs/08`); por isso quase toda
// tabela tem um índice `(…, status, updated_at)` ou `(…, created_at)` para as
// listas do Hub Web e para a retomada por cursor.

import { EntitySchema } from 'typeorm';

import { autonomyLevel, workMode, type AutonomyLevel, type WorkMode } from './project.js';
import {
  auditColumns,
  createdAt,
  createdBy,
  enumColumn,
  jsonColumn,
  nullableUnsignedBigint,
  organizationId,
  primaryId,
  requiredText,
  requiredUlidColumn,
  requiredUtcDatetime,
  text,
  timestamps,
  ulidColumn,
  unsignedBigint,
  utcDatetime,
  version,
  type AuditFields,
  type TimestampFields,
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
export type TaskStatus = (typeof taskStatus)[number];
export const taskPriority = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof taskPriority)[number];

export interface Task extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  conversationId: string | null;
  parentTaskId: string | null;
  number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  workMode: WorkMode;
  autonomy: AutonomyLevel;
  scope: Record<string, unknown> | null;
  tags: string[] | null;
  branchName: string | null;
  claimedByDeviceId: string | null;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  claimedByAgentRunId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  dueAt: Date | null;
  blockedReason: string | null;
}

export const tasks = new EntitySchema<Task>({
  name: 'tasks',
  tableName: 'tasks',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    // Conversa que originou a tarefa, quando houver.
    conversationId: ulidColumn('conversation_id'),
    parentTaskId: ulidColumn('parent_task_id'),
    // Número curto por projeto, para as pessoas ("#42"). O ULID continua sendo
    // a identidade real.
    number: { type: 'int', name: 'number', nullable: false },
    title: requiredText('title', 255),
    description: { type: 'mediumtext', name: 'description', nullable: true },
    status: enumColumn('status', taskStatus, { default: 'backlog' }),
    priority: enumColumn('priority', taskPriority, { default: 'normal' }),
    workMode: enumColumn('work_mode', workMode, { default: 'plan' }),
    autonomy: enumColumn('autonomy', autonomyLevel, { default: 'manual' }),
    // Escopo reservado pela tarefa (arquivos/diretórios), base dos eventos
    // `scope.reserved` e `scope.conflict` do `Docs/08`.
    scope: jsonColumn('scope'),
    branchName: text('branch_name', 255),
    claimedByDeviceId: ulidColumn('claimed_by_device_id'),
    claimedByUserId: ulidColumn('claimed_by_user_id'),
    claimedAt: utcDatetime('claimed_at'),
    startedAt: utcDatetime('started_at'),
    completedAt: utcDatetime('completed_at'),
    dueAt: utcDatetime('due_at'),
    blockedReason: text('blocked_reason', 512),
    ...auditColumns(),
    // Etiquetas livres do contrato de tarefa, como em `projects.tags`.
    tags: jsonColumn('tags'),
    // Prazo da reivindicação. Sem ele, quem reivindica e some trava a tarefa
    // para sempre; com ele, a reivindicação vencida é indistinguível de
    // nenhuma reivindicação, e outra pessoa consegue assumir.
    claimExpiresAt: utcDatetime('claim_expires_at'),
    claimedByAgentRunId: ulidColumn('claimed_by_agent_run_id'),
  },
  uniques: [{ name: 'uq_tasks_project_number', columns: ['projectId', 'number'] }],
  indices: [
    { name: 'idx_tasks_project_status_updated_at', columns: ['projectId', 'status', 'updatedAt'] },
    { name: 'idx_tasks_project_created_at', columns: ['projectId', 'createdAt'] },
    { name: 'idx_tasks_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_tasks_parent', columns: ['parentTaskId'] },
    // Varredura das reivindicações vencidas: o filtro é sempre
    // `status = 'claimed' AND claim_expires_at <= now`.
    { name: 'idx_tasks_claim_expires_at', columns: ['status', 'claimExpiresAt'] },
  ],
});

/** Natureza da dependência entre tarefas. */
export const taskDependencyType = ['blocks', 'relates_to', 'duplicates'] as const;
export type TaskDependencyType = (typeof taskDependencyType)[number];

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  type: TaskDependencyType;
  organizationId: string;
  createdAt: Date;
  createdBy: string | null;
}

export const taskDependencies = new EntitySchema<TaskDependency>({
  name: 'task_dependencies',
  tableName: 'task_dependencies',
  // Junção pura: o par já é a identidade.
  columns: {
    taskId: { type: 'char', length: 26, name: 'task_id', primary: true, nullable: false },
    dependsOnTaskId: {
      type: 'char',
      length: 26,
      name: 'depends_on_task_id',
      primary: true,
      nullable: false,
    },
    type: enumColumn('type', taskDependencyType, { default: 'blocks' }),
    organizationId: organizationId(),
    createdAt: createdAt(),
    createdBy: createdBy(),
  },
  indices: [{ name: 'idx_task_dependencies_depends_on', columns: ['dependsOnTaskId'] }],
});

export const assigneeType = ['user', 'agent_profile'] as const;
export type AssigneeType = (typeof assigneeType)[number];
export const assignmentStatus = [
  'assigned',
  'accepted',
  'released',
  'completed',
  'failed',
] as const;
export type AssignmentStatus = (typeof assignmentStatus)[number];

export interface TaskAssignment extends TimestampFields {
  id: string;
  organizationId: string;
  taskId: string;
  assigneeType: AssigneeType;
  assigneeId: string;
  agentRunId: string | null;
  status: AssignmentStatus;
  assignedBy: string | null;
  assignedAt: Date;
  acceptedAt: Date | null;
  releasedAt: Date | null;
  version: number;
}

export const taskAssignments = new EntitySchema<TaskAssignment>({
  name: 'task_assignments',
  tableName: 'task_assignments',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    taskId: requiredUlidColumn('task_id'),
    assigneeType: enumColumn('assignee_type', assigneeType),
    // Referência polimórfica: `users.id` ou `agent_profiles.id`.
    assigneeId: requiredUlidColumn('assignee_id'),
    agentRunId: ulidColumn('agent_run_id'),
    status: enumColumn('status', assignmentStatus, { default: 'assigned' }),
    assignedBy: ulidColumn('assigned_by'),
    assignedAt: requiredUtcDatetime('assigned_at'),
    acceptedAt: utcDatetime('accepted_at'),
    releasedAt: utcDatetime('released_at'),
    ...timestamps(),
    version: version(),
  },
  indices: [
    { name: 'idx_task_assignments_task_created_at', columns: ['taskId', 'createdAt'] },
    { name: 'idx_task_assignments_assignee', columns: ['assigneeType', 'assigneeId', 'status'] },
    { name: 'idx_task_assignments_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

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
export type AgentRunStatus = (typeof agentRunStatus)[number];
/** Onde o agente roda: máquina do usuário ou infraestrutura do Hub. */
export const agentRunMode = ['local', 'remote'] as const;
export type AgentRunMode = (typeof agentRunMode)[number];

export interface AgentRun extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string | null;
  conversationId: string | null;
  agentProfileId: string | null;
  deviceId: string | null;
  externalSessionId: string | null;
  status: AgentRunStatus;
  mode: AgentRunMode;
  workMode: WorkMode;
  autonomy: AutonomyLevel;
  startedAt: Date | null;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: number | null;
  resultSummary: string | null;
}

export const agentRuns = new EntitySchema<AgentRun>({
  name: 'agent_runs',
  tableName: 'agent_runs',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    taskId: ulidColumn('task_id'),
    conversationId: ulidColumn('conversation_id'),
    agentProfileId: ulidColumn('agent_profile_id'),
    deviceId: ulidColumn('device_id'),
    // ID da sessão no CLI/adaptador, para retomada (`Docs/04`).
    externalSessionId: text('external_session_id', 191),
    status: enumColumn('status', agentRunStatus, { default: 'queued' }),
    mode: enumColumn('mode', agentRunMode, { default: 'local' }),
    workMode: enumColumn('work_mode', workMode, { default: 'plan' }),
    autonomy: enumColumn('autonomy', autonomyLevel, { default: 'manual' }),
    startedAt: utcDatetime('started_at'),
    finishedAt: utcDatetime('finished_at'),
    heartbeatAt: utcDatetime('heartbeat_at'),
    exitCode: { type: 'int', name: 'exit_code', nullable: true },
    errorCode: text('error_code', 96),
    errorMessage: { type: 'text', name: 'error_message', nullable: true },
    inputTokens: { type: 'int', name: 'input_tokens', nullable: true },
    outputTokens: { type: 'int', name: 'output_tokens', nullable: true },
    // Custo em inteiro na menor unidade da moeda.
    costCents: { type: 'int', name: 'cost_cents', nullable: true },
    // Result Package resumido (`Docs/10`); o detalhe vai para `artifacts`.
    resultSummary: { type: 'mediumtext', name: 'result_summary', nullable: true },
    ...auditColumns(),
  },
  indices: [
    {
      name: 'idx_agent_runs_project_status_updated_at',
      columns: ['projectId', 'status', 'updatedAt'],
    },
    { name: 'idx_agent_runs_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_agent_runs_task_created_at', columns: ['taskId', 'createdAt'] },
    { name: 'idx_agent_runs_heartbeat', columns: ['status', 'heartbeatAt'] },
  ],
});

export interface AgentRunEvent {
  id: string;
  organizationId: string;
  agentRunId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

export const agentRunEvents = new EntitySchema<AgentRunEvent>({
  name: 'agent_run_events',
  tableName: 'agent_run_events',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    agentRunId: requiredUlidColumn('agent_run_id'),
    // Ordem por agregado, exigida pelas garantias do `Docs/08`.
    sequence: unsignedBigint('sequence'),
    type: requiredText('type', 96),
    payload: jsonColumn('payload'),
    occurredAt: requiredUtcDatetime('occurred_at'),
    createdAt: createdAt(),
  },
  uniques: [{ name: 'uq_agent_run_events_run_sequence', columns: ['agentRunId', 'sequence'] }],
  indices: [
    { name: 'idx_agent_run_events_run_occurred_at', columns: ['agentRunId', 'occurredAt'] },
    { name: 'idx_agent_run_events_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

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
export type ApprovalKind = (typeof approvalKind)[number];
export const approvalStatus = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export type ApprovalStatus = (typeof approvalStatus)[number];
export const riskLevel = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof riskLevel)[number];
/** Quem pediu a aprovação. */
export const requesterType = ['user', 'agent', 'system'] as const;
export type RequesterType = (typeof requesterType)[number];

export interface Approval extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string | null;
  taskId: string | null;
  agentRunId: string | null;
  conversationId: string | null;
  kind: ApprovalKind;
  status: ApprovalStatus;
  risk: RiskLevel;
  subject: Record<string, unknown> | null;
  requestedByType: RequesterType;
  requestedById: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  reason: string | null;
}

export const approvals = new EntitySchema<Approval>({
  name: 'approvals',
  tableName: 'approvals',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: ulidColumn('project_id'),
    taskId: ulidColumn('task_id'),
    agentRunId: ulidColumn('agent_run_id'),
    conversationId: ulidColumn('conversation_id'),
    kind: enumColumn('kind', approvalKind),
    status: enumColumn('status', approvalStatus, { default: 'pending' }),
    risk: enumColumn('risk', riskLevel, { default: 'medium' }),
    // Descrição estruturada do que será feito (comando, arquivos, diff).
    subject: jsonColumn('subject'),
    requestedByType: enumColumn('requested_by_type', requesterType),
    requestedById: ulidColumn('requested_by_id'),
    decidedByUserId: ulidColumn('decided_by_user_id'),
    decidedAt: utcDatetime('decided_at'),
    expiresAt: utcDatetime('expires_at'),
    reason: text('reason', 512),
    ...auditColumns(),
  },
  indices: [
    {
      name: 'idx_approvals_org_status_created_at',
      columns: ['organizationId', 'status', 'createdAt'],
    },
    { name: 'idx_approvals_task_created_at', columns: ['taskId', 'createdAt'] },
    { name: 'idx_approvals_run', columns: ['agentRunId', 'status'] },
  ],
});

export const reviewStatus = ['pending', 'approved', 'changes_requested', 'rejected'] as const;
export type ReviewStatus = (typeof reviewStatus)[number];

export interface Review extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string | null;
  agentRunId: string | null;
  artifactId: string | null;
  reviewerUserId: string | null;
  status: ReviewStatus;
  summary: string | null;
  checklist: Record<string, unknown> | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
}

export const reviews = new EntitySchema<Review>({
  name: 'reviews',
  tableName: 'reviews',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    taskId: ulidColumn('task_id'),
    agentRunId: ulidColumn('agent_run_id'),
    // Artefato revisado (diff, PR). Sem FK: `artifacts` é definido adiante e a
    // ida e volta criaria referência circular entre as duas tabelas.
    artifactId: ulidColumn('artifact_id'),
    reviewerUserId: ulidColumn('reviewer_user_id'),
    status: enumColumn('status', reviewStatus, { default: 'pending' }),
    summary: { type: 'mediumtext', name: 'summary', nullable: true },
    checklist: jsonColumn('checklist'),
    submittedAt: utcDatetime('submitted_at'),
    decidedAt: utcDatetime('decided_at'),
    ...auditColumns(),
  },
  indices: [
    { name: 'idx_reviews_task_created_at', columns: ['taskId', 'createdAt'] },
    { name: 'idx_reviews_project_status_updated_at', columns: ['projectId', 'status', 'updatedAt'] },
    { name: 'idx_reviews_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

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
export type ArtifactType = (typeof artifactType)[number];

export interface Artifact extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string;
  taskId: string | null;
  agentRunId: string | null;
  type: ArtifactType;
  title: string;
  storageKey: string | null;
  uri: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  metadata: Record<string, unknown> | null;
}

export const artifacts = new EntitySchema<Artifact>({
  name: 'artifacts',
  tableName: 'artifacts',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    projectId: requiredUlidColumn('project_id'),
    taskId: ulidColumn('task_id'),
    agentRunId: ulidColumn('agent_run_id'),
    type: enumColumn('type', artifactType),
    title: requiredText('title', 255),
    // Conteúdo grande fica no storage isolado; aqui vai a chave ou a URI.
    storageKey: text('storage_key', 512),
    uri: text('uri', 1024),
    mimeType: text('mime_type', 191),
    sizeBytes: nullableUnsignedBigint('size_bytes'),
    checksumSha256: text('checksum_sha256', 64),
    metadata: jsonColumn('metadata'),
    ...auditColumns(),
  },
  indices: [
    { name: 'idx_artifacts_task_created_at', columns: ['taskId', 'createdAt'] },
    { name: 'idx_artifacts_run_created_at', columns: ['agentRunId', 'createdAt'] },
    { name: 'idx_artifacts_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});
