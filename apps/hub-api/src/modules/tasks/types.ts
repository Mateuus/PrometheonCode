/** Tipos internos do módulo de tarefas. */

import type { TaskPriority, TaskStatus } from '@prometheon/contracts';

export interface TaskRow {
  id: string;
  organizationId: string;
  projectId: string;
  conversationId: string | null;
  number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[] | null;
  /** JSON livre na coluna; vira `taskScopeSchema` só na fronteira do contrato. */
  scope: Record<string, unknown> | null;
  claimedByUserId: string | null;
  claimedByDeviceId: string | null;
  claimedByAgentRunId: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  version: number;
}

export interface AssignmentRow {
  taskId: string;
  assigneeType: 'user' | 'agent_profile';
  assigneeId: string;
  userName: string | null;
  userEmail: string | null;
  userAvatarUrl: string | null;
}

export interface DependencyRow {
  taskId: string;
  dependsOnTaskId: string;
}
