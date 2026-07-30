/**
 * Tarefas e orquestração (`Docs/06`, `Docs/07`).
 *
 * Uma tarefa é reivindicada (`claim`) por um agente ou por uma pessoa e
 * liberada (`release`) depois. A reivindicação tem prazo para que trabalho não
 * fique preso quando um dispositivo cai.
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import {
  idempotencyKeySchema,
  isoDateTimeSchema,
  longTextSchema,
  shortTextSchema,
  tagsSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

/**
 * `failed` estava no `Docs/07` e faltava aqui. Ele não é sinônimo de
 * `cancelled`: cancelada é decisão de quem coordena, falha é desfecho da
 * execução — e só a segunda justifica uma nova tentativa.
 */
export const TASK_STATUSES = [
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

export const taskStatusSchema = z.enum(TASK_STATUSES);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const taskPrioritySchema = z.enum(TASK_PRIORITIES);

export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const TASK_ASSIGNEE_TYPES = ['none', 'user', 'agent'] as const;

export const taskAssigneeTypeSchema = z.enum(TASK_ASSIGNEE_TYPES);

/** Escopo reservado por uma tarefa; o Hub usa isto para detectar conflito. */
export const taskScopeSchema = z.object({
  /** Caminhos ou globs que a tarefa pretende alterar. */
  paths: z.array(z.string().min(1).max(512)).max(200),
  /** Reserva exclusiva impede outra tarefa de tocar nos mesmos caminhos. */
  exclusive: z.boolean(),
});

export type TaskScope = z.infer<typeof taskScopeSchema>;

export const taskClaimSchema = z.object({
  claimedBy: z.enum(['user', 'agent']),
  userId: ulidSchema.nullable(),
  agentRunId: ulidSchema.nullable(),
  deviceId: ulidSchema.nullable(),
  claimedAt: isoDateTimeSchema,
  /** A reivindicação expira e a tarefa volta para `ready`. */
  expiresAt: isoDateTimeSchema,
});

export type TaskClaim = z.infer<typeof taskClaimSchema>;

export const taskSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  projectId: ulidSchema,
  title: shortTextSchema,
  description: longTextSchema.nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  tags: tagsSchema,
  assigneeType: taskAssigneeTypeSchema,
  assignee: publicUserSchema.nullable(),
  assignedAgentProfileId: ulidSchema.nullable(),
  /** Tarefas que precisam terminar antes desta. */
  dependsOn: z.array(ulidSchema),
  scope: taskScopeSchema.nullable(),
  claim: taskClaimSchema.nullable(),
  conversationId: ulidSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  createdBy: ulidSchema,
  version: versionSchema,
});

export type Task = z.infer<typeof taskSchema>;

export const createTaskRequestSchema = z.object({
  title: shortTextSchema,
  description: longTextSchema.optional(),
  priority: taskPrioritySchema.default('normal'),
  tags: tagsSchema.default([]),
  assigneeUserId: ulidSchema.optional(),
  assignedAgentProfileId: ulidSchema.optional(),
  dependsOn: z.array(ulidSchema).max(50).default([]),
  scope: taskScopeSchema.optional(),
  conversationId: ulidSchema.optional(),
  dueAt: isoDateTimeSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  title: shortTextSchema.optional(),
  description: longTextSchema.nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  tags: tagsSchema.optional(),
  assigneeUserId: ulidSchema.nullable().optional(),
  assignedAgentProfileId: ulidSchema.nullable().optional(),
  dependsOn: z.array(ulidSchema).max(50).optional(),
  scope: taskScopeSchema.nullable().optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  version: versionSchema,
});

export const claimTaskRequestSchema = z.object({
  /** Execução do agente que está assumindo, quando for um agente. */
  agentRunId: ulidSchema.optional(),
  deviceId: ulidSchema.optional(),
  /** Duração da reivindicação em segundos; o servidor impõe um teto. */
  leaseSeconds: z.int().positive().max(86_400).default(900),
  scope: taskScopeSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const releaseTaskRequestSchema = z.object({
  /** Estado em que a tarefa fica após ser liberada. */
  status: z
    .enum(['ready', 'blocked', 'in_review', 'done', 'cancelled', 'failed'])
    .default('ready'),
  note: longTextSchema.optional(),
});

export const taskListQuerySchema = cursorPageQuerySchema.extend({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assigneeUserId: ulidSchema.optional(),
  assigneeType: taskAssigneeTypeSchema.optional(),
  tag: z.string().trim().max(48).optional(),
  search: z.string().trim().max(120).optional(),
});

export const taskPageSchema = cursorPageSchema(taskSchema);

// ---------------------------------------------------------------------------
// Execuções de agente
// ---------------------------------------------------------------------------

export const AGENT_RUN_STATUSES = [
  'starting',
  'running',
  'waiting_approval',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  projectId: ulidSchema,
  taskId: ulidSchema.nullable(),
  conversationId: ulidSchema.nullable(),
  deviceId: ulidSchema.nullable(),
  agentProfileId: ulidSchema,
  agentProfileName: shortTextSchema,
  status: agentRunStatusSchema,
  startedBy: publicUserSchema.nullable(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  /** Última atividade observada; alimenta a lista de agentes ativos. */
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;

export const activeAgentPageSchema = cursorPageSchema(agentRunSchema);

// ---------------------------------------------------------------------------
// Aprovações
// ---------------------------------------------------------------------------

export const approvalSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  projectId: ulidSchema,
  agentRunId: ulidSchema,
  taskId: ulidSchema.nullable(),
  /** O que o agente quer fazer e precisa de autorização humana. */
  action: shortTextSchema,
  reason: longTextSchema,
  status: z.enum(['requested', 'approved', 'rejected', 'expired']),
  requestedAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedBy: publicUserSchema.nullable(),
  expiresAt: isoDateTimeSchema,
});

export type Approval = z.infer<typeof approvalSchema>;

export const resolveApprovalRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: longTextSchema.optional(),
});

export const approvalPageSchema = cursorPageSchema(approvalSchema);
