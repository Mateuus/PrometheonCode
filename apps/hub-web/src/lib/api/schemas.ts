import { z } from 'zod';
import { ROLES } from '@prometheon/permissions';
import type {
  Agent,
  AuditEvent,
  AuthSession,
  Conversation,
  DashboardSummary,
  Invitation,
  KnowledgeEntry,
  Member,
  Message,
  Organization,
  Plan,
  Project,
  Task,
  User,
} from './types';

/**
 * Validação de runtime da fronteira com a Hub API.
 *
 * "Toda fronteira valida runtime" é regra do `Docs/03`: o que chega da rede é
 * desconhecido até passar por aqui. Os schemas acompanham `types.ts` e trocam
 * junto com ele quando `@prometheon/contracts` publicar os oficiais.
 */

const iso = z.string().datetime({ offset: true }).or(z.string());
const role = z.enum(ROLES);

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  createdAt: iso,
}) satisfies z.ZodType<User>;

export const organizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  viewerRole: role,
  memberCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
  planId: z.string(),
}) satisfies z.ZodType<Organization>;

export const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role,
  status: z.enum(['active', 'invited', 'suspended']),
  joinedAt: iso,
  lastSeenAt: iso.nullable(),
  online: z.boolean(),
}) satisfies z.ZodType<Member>;

export const invitationSchema = z.object({
  token: z.string(),
  organizationName: z.string(),
  organizationSlug: z.string(),
  role,
  invitedEmail: z.string(),
  expiresAt: iso,
}) satisfies z.ZodType<Invitation>;

export const authSessionSchema = z.object({
  id: z.string(),
  deviceLabel: z.string(),
  ipAddress: z.string(),
  createdAt: iso,
  lastActiveAt: iso,
  current: z.boolean(),
}) satisfies z.ZodType<AuthSession>;

export const projectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string(),
  repositoryUrl: z.string(),
  defaultBranch: z.string(),
  openTaskCount: z.number().int().nonnegative(),
  activeAgentCount: z.number().int().nonnegative(),
  lastActivityAt: iso,
}) satisfies z.ZodType<Project>;

export const conversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  messageCount: z.number().int().nonnegative(),
  updatedAt: iso,
}) satisfies z.ZodType<Conversation>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  authorType: z.enum(['user', 'agent', 'system']),
  authorName: z.string(),
  body: z.string(),
  createdAt: iso,
}) satisfies z.ZodType<Message>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(['backlog', 'running', 'blocked', 'review', 'done']),
  assigneeName: z.string().nullable(),
  blockedReason: z.string().nullable(),
  updatedAt: iso,
}) satisfies z.ZodType<Task>;

export const agentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  role: z.enum(['main', 'worker']),
  status: z.enum(['idle', 'working', 'offline', 'paused']),
  deviceLabel: z.string(),
  currentTaskTitle: z.string().nullable(),
  lastHeartbeatAt: iso.nullable(),
}) satisfies z.ZodType<Agent>;

export const knowledgeEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(['proposed', 'approved', 'rejected']),
  authorName: z.string(),
  updatedAt: iso,
}) satisfies z.ZodType<KnowledgeEntry>;

export const auditEventSchema = z.object({
  id: z.string(),
  occurredAt: iso,
  actorName: z.string(),
  action: z.string(),
  target: z.string(),
  ipAddress: z.string(),
}) satisfies z.ZodType<AuditEvent>;

const usageMetricSchema = z.object({
  used: z.number(),
  limit: z.number().nullable(),
  unit: z.enum(['count', 'megabytes']),
});

export const dashboardSummarySchema = z.object({
  recentProjects: z.array(projectSchema),
  membersOnline: z.array(memberSchema),
  agentsWorking: z.array(agentSchema),
  blockedTasks: z.array(taskSchema),
  pendingReviews: z.array(taskSchema),
  knowledgeProposals: z.array(knowledgeEntrySchema),
  usage: z.object({
    messages: usageMetricSchema,
    tasks: usageMetricSchema,
    storage: usageMetricSchema,
  }),
  syncIncidents: z.array(
    z.object({
      id: z.string(),
      projectName: z.string(),
      summary: z.string(),
      occurredAt: iso,
      severity: z.enum(['warning', 'error']),
    }),
  ),
}) satisfies z.ZodType<DashboardSummary>;

export const planSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  isDefault: z.boolean(),
  visible: z.boolean(),
  limits: z.object({
    membersPerOrganization: z.number().int().nullable(),
    projectsPerOrganization: z.number().int().nullable(),
    concurrentAgents: z.number().int().nullable(),
    messagesPerMonth: z.number().int().nullable(),
    knowledgeStorageMb: z.number().int().nullable(),
    auditRetentionDays: z.number().int().nullable(),
  }),
  organizationCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<Plan>;
