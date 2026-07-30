import type { Role } from '@prometheon/permissions';

/**
 * FRONTEIRA DE TIPOS DO DOMÍNIO — ponto único de troca.
 *
 * Tudo que o Hub Web sabe sobre o formato dos dados da Hub API está neste
 * arquivo, e só nele. Quando `@prometheon/contracts` publicar os tipos e os
 * schemas Zod (`Docs/06`), este módulo vira um re-export:
 *
 * ```ts
 * export type { Project, Task, ... } from '@prometheon/contracts';
 * ```
 *
 * Nenhuma tela, componente ou action declara forma de dado por conta própria —
 * assim a troca é uma edição neste arquivo, não uma caçada pelo `src/`.
 *
 * Convenções do `Docs/03`: id é UUID/ULID em string, data é ISO 8601 em UTC e
 * dinheiro é inteiro na menor unidade.
 */

export type { Role } from '@prometheon/permissions';

export type Iso8601 = string;

// --------------------------------------------------------------- identidade

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Iso8601;
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  /** Papel de quem está pedindo — a API resolve pelo token. */
  viewerRole: Role;
  memberCount: number;
  projectCount: number;
  planId: string;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  joinedAt: Iso8601;
  lastSeenAt: Iso8601 | null;
  online: boolean;
}

export interface Invitation {
  token: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
  invitedEmail: string;
  expiresAt: Iso8601;
}

export interface AuthSession {
  id: string;
  deviceLabel: string;
  ipAddress: string;
  createdAt: Iso8601;
  lastActiveAt: Iso8601;
  current: boolean;
}

// ----------------------------------------------------------------- projetos

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  repositoryUrl: string;
  defaultBranch: string;
  openTaskCount: number;
  activeAgentCount: number;
  lastActivityAt: Iso8601;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  messageCount: number;
  updatedAt: Iso8601;
}

export interface Message {
  id: string;
  conversationId: string;
  authorType: 'user' | 'agent' | 'system';
  authorName: string;
  body: string;
  createdAt: Iso8601;
}

export type TaskStatus = 'backlog' | 'running' | 'blocked' | 'review' | 'done';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  assigneeName: string | null;
  blockedReason: string | null;
  updatedAt: Iso8601;
}

export type AgentStatus = 'idle' | 'working' | 'offline' | 'paused';

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role: 'main' | 'worker';
  status: AgentStatus;
  deviceLabel: string;
  currentTaskTitle: string | null;
  lastHeartbeatAt: Iso8601 | null;
}

export type KnowledgeStatus = 'proposed' | 'approved' | 'rejected';

export interface KnowledgeEntry {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  status: KnowledgeStatus;
  authorName: string;
  updatedAt: Iso8601;
}

// --------------------------------------------------------------- auditoria

export interface AuditEvent {
  id: string;
  occurredAt: Iso8601;
  actorName: string;
  action: string;
  target: string;
  ipAddress: string;
}

// --------------------------------------------------------------- dashboard

export interface UsageMetric {
  used: number;
  /** `null` significa sem limite no plano. */
  limit: number | null;
  unit: 'count' | 'megabytes';
}

export interface SyncIncident {
  id: string;
  projectName: string;
  summary: string;
  occurredAt: Iso8601;
  severity: 'warning' | 'error';
}

export interface DashboardSummary {
  recentProjects: Project[];
  membersOnline: Member[];
  agentsWorking: Agent[];
  blockedTasks: Task[];
  pendingReviews: Task[];
  knowledgeProposals: KnowledgeEntry[];
  usage: {
    messages: UsageMetric;
    tasks: UsageMetric;
    storage: UsageMetric;
  };
  syncIncidents: SyncIncident[];
}

// ------------------------------------------------------------------- planos

/** `null` em qualquer limite significa ilimitado. */
export interface PlanLimits {
  membersPerOrganization: number | null;
  projectsPerOrganization: number | null;
  concurrentAgents: number | null;
  messagesPerMonth: number | null;
  knowledgeStorageMb: number | null;
  auditRetentionDays: number | null;
}

export interface Plan {
  id: string;
  slug: string;
  name: string;
  /** Inteiro na menor unidade da moeda; `0` é o plano gratuito. */
  priceCents: number;
  currency: string;
  /** Plano atribuído a organizações novas. */
  isDefault: boolean;
  /** Plano fora do catálogo público continua valendo para quem já o tem. */
  visible: boolean;
  limits: PlanLimits;
  organizationCount: number;
}
