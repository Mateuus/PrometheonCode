import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/env';
import { accessToken } from '@/lib/auth/session';
import { hubRequest } from './client';
import { failure, success, type ApiResult } from './result';
import {
  agentSchema,
  auditEventSchema,
  authSessionSchema,
  conversationSchema,
  dashboardSummarySchema,
  invitationSchema,
  knowledgeEntrySchema,
  memberSchema,
  messageSchema,
  organizationSchema,
  planSchema,
  projectSchema,
  taskSchema,
  userSchema,
} from './schemas';
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
 * Leituras do domínio.
 *
 * Cada função tem dois caminhos: a chamada HTTP definitiva, escrita contra os
 * endpoints do `Docs/06`, e o ramo de dados de exemplo que vale enquanto a Hub
 * API não sobe. O flag é `HUB_WEB_SAMPLE_DATA`; nenhuma tela sabe qual dos dois
 * respondeu.
 */

function sampleDataEnabled(): boolean {
  return env().HUB_WEB_SAMPLE_DATA;
}

/** Importa os dados de exemplo só quando o flag pede — provisório. */
async function samples() {
  return import('./sample-data');
}

async function get<T>(path: string, schema: z.ZodType<T>): Promise<ApiResult<T>> {
  return hubRequest(path, schema, { accessToken: await accessToken() });
}

// ---------------------------------------------------------------- identidade

export async function getCurrentUser(): Promise<ApiResult<User>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleUser);
  }
  return get('/v1/me', userSchema);
}

export async function listOrganizations(): Promise<ApiResult<Organization[]>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleOrganizations);
  }
  return get('/v1/organizations', z.array(organizationSchema));
}

export async function getOrganizationBySlug(slug: string): Promise<ApiResult<Organization>> {
  if (sampleDataEnabled()) {
    const found = (await samples()).sampleOrganizations.find((org) => org.slug === slug);
    return found ? success(found) : failure('not-found');
  }
  // A API resolve por id; o slug vira id numa busca prévia quando ela existir.
  return get(`/v1/organizations/${encodeURIComponent(slug)}`, organizationSchema);
}

export async function listMembers(organizationId: string): Promise<ApiResult<Member[]>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleMembers);
  }
  return get(`/v1/organizations/${encodeURIComponent(organizationId)}/members`, z.array(memberSchema));
}

export async function listSessions(): Promise<ApiResult<AuthSession[]>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleSessions);
  }
  return get('/v1/me/sessions', z.array(authSessionSchema));
}

export async function getInvitation(token: string): Promise<ApiResult<Invitation>> {
  if (sampleDataEnabled()) {
    const sample = (await samples()).sampleInvitation;
    // Um token qualquer serve para ver a tela válida; `invalid` mostra a outra.
    return token === 'invalid' ? failure('not-found') : success({ ...sample, token });
  }
  return get(`/v1/invitations/${encodeURIComponent(token)}`, invitationSchema);
}

// ------------------------------------------------------------------ projetos

export async function listProjects(organizationId: string): Promise<ApiResult<Project[]>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleProjects);
  }
  return get(`/v1/organizations/${encodeURIComponent(organizationId)}/projects`, z.array(projectSchema));
}

export async function getProject(projectId: string): Promise<ApiResult<Project>> {
  if (sampleDataEnabled()) {
    const found = (await samples()).sampleProjects.find((project) => project.id === projectId);
    return found ? success(found) : failure('not-found');
  }
  return get(`/v1/projects/${encodeURIComponent(projectId)}`, projectSchema);
}

export async function listConversations(projectId: string): Promise<ApiResult<Conversation[]>> {
  if (sampleDataEnabled()) {
    const all = (await samples()).sampleConversations;
    return success(all.filter((item) => item.projectId === projectId));
  }
  return get(`/v1/projects/${encodeURIComponent(projectId)}/conversations`, z.array(conversationSchema));
}

export async function listMessages(conversationId: string): Promise<ApiResult<Message[]>> {
  if (sampleDataEnabled()) {
    const all = (await samples()).sampleMessages;
    return success(all.filter((item) => item.conversationId === conversationId));
  }
  return get(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`, z.array(messageSchema));
}

export async function listTasks(projectId: string): Promise<ApiResult<Task[]>> {
  if (sampleDataEnabled()) {
    const all = (await samples()).sampleTasks;
    return success(all.filter((item) => item.projectId === projectId));
  }
  return get(`/v1/projects/${encodeURIComponent(projectId)}/tasks`, z.array(taskSchema));
}

export async function listAgents(projectId: string): Promise<ApiResult<Agent[]>> {
  if (sampleDataEnabled()) {
    const all = (await samples()).sampleAgents;
    return success(all.filter((item) => item.projectId === projectId));
  }
  return get(`/v1/projects/${encodeURIComponent(projectId)}/agents/active`, z.array(agentSchema));
}

export async function listKnowledge(projectId: string): Promise<ApiResult<KnowledgeEntry[]>> {
  if (sampleDataEnabled()) {
    const all = (await samples()).sampleKnowledge;
    return success(all.filter((item) => item.projectId === projectId));
  }
  return get(`/v1/projects/${encodeURIComponent(projectId)}/knowledge`, z.array(knowledgeEntrySchema));
}

// --------------------------------------------------------- painel e auditoria

export async function getDashboard(organizationId: string): Promise<ApiResult<DashboardSummary>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleDashboard());
  }
  return get(`/v1/organizations/${encodeURIComponent(organizationId)}/dashboard`, dashboardSummarySchema);
}

export async function listAuditEvents(organizationId: string): Promise<ApiResult<AuditEvent[]>> {
  if (sampleDataEnabled()) {
    return success((await samples()).sampleAuditEvents);
  }
  return get(`/v1/audit?organizationId=${encodeURIComponent(organizationId)}`, z.array(auditEventSchema));
}

// -------------------------------------------------------------------- planos

export async function listPlans(): Promise<ApiResult<Plan[]>> {
  if (sampleDataEnabled()) {
    return success((await samples()).samplePlans);
  }
  return get('/v1/admin/plans', z.array(planSchema));
}
