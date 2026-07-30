import 'server-only';
import { z } from 'zod';
import {
  acceptInvitationResponseSchema,
  invitationSchema,
  organizationMemberSchema,
} from '@prometheon/contracts';
import { accessToken } from '@/lib/auth/session';
import { hubRequest, type HubRequestOptions } from './client';
import { failure, type ApiResult } from './result';
import { conversationSchema, messageSchema, projectSchema, taskSchema } from './schemas';
import type { Conversation, Message, OrganizationRole, Project, Task, TaskPriority, TaskStatus } from './types';

/**
 * Escritas no domínio.
 *
 * Toda escrita é um comando da Hub API — o Hub Web não decide nada por conta
 * própria. Vale repetir o que o `Docs/05` diz: esconder um botão não autoriza
 * ninguém. A interface usa `@prometheon/permissions` para não **oferecer** o que
 * seria negado, e a API nega de novo se a oferta escapar.
 *
 * Os comandos que criam recurso aceitam `idempotencyKey` porque o usuário clica
 * duas vezes, a rede repete e o `Docs/06` pede que isso não vire dois registros.
 */

async function send<T>(
  path: string,
  schema: z.ZodType<T>,
  options: Omit<HubRequestOptions, 'accessToken'>,
): Promise<ApiResult<T>> {
  const token = await accessToken();
  if (!token) {
    return failure('unauthorized', { code: 'SESSION_EXPIRED' });
  }
  return hubRequest(path, schema, { ...options, accessToken: token });
}

// ------------------------------------------------------------------ projetos

export async function createProject(
  organizationId: string,
  input: { name: string; description?: string | undefined; visibility?: 'organization' | 'private' },
): Promise<ApiResult<Project>> {
  return send(`/v1/organizations/${encodeURIComponent(organizationId)}/projects`, projectSchema, {
    method: 'POST',
    body: {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      visibility: input.visibility ?? 'organization',
      tags: [],
    },
    idempotencyKey: crypto.randomUUID(),
  });
}

export async function updateProject(
  projectId: string,
  input: { name?: string; description?: string | null; version: number },
): Promise<ApiResult<Project>> {
  return send(`/v1/projects/${encodeURIComponent(projectId)}`, projectSchema, {
    method: 'PATCH',
    body: input,
  });
}

// ------------------------------------------------------------------- conversa

export async function createConversation(
  projectId: string,
  input: { title?: string | undefined },
): Promise<ApiResult<Conversation>> {
  return send(`/v1/projects/${encodeURIComponent(projectId)}/conversations`, conversationSchema, {
    method: 'POST',
    // A conversa nasce vazia: a API não aceita uma primeira mensagem embutida
    // no mesmo comando, e o Hub Web não finge que aceita.
    body: { ...(input.title ? { title: input.title } : {}), origin: 'web' },
    idempotencyKey: crypto.randomUUID(),
  });
}

/**
 * Manda uma mensagem de texto.
 * `parts` é uma união discriminada por `type`; texto é uma parte entre várias
 * (ferramenta, artefato, erro), e é por isso que o corpo não é uma string.
 */
export async function createMessage(
  conversationId: string,
  text: string,
): Promise<ApiResult<Message>> {
  return send(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`, messageSchema, {
    method: 'POST',
    body: {
      authorType: 'user',
      parts: [{ type: 'text', text }],
      idempotencyKey: crypto.randomUUID(),
    },
  });
}

// -------------------------------------------------------------------- tarefas

export async function createTask(
  projectId: string,
  input: { title: string; description?: string | undefined; priority?: TaskPriority },
): Promise<ApiResult<Task>> {
  return send(`/v1/projects/${encodeURIComponent(projectId)}/tasks`, taskSchema, {
    method: 'POST',
    body: {
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      priority: input.priority ?? 'normal',
      idempotencyKey: crypto.randomUUID(),
    },
  });
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  version: number,
): Promise<ApiResult<Task>> {
  return send(`/v1/tasks/${encodeURIComponent(taskId)}`, taskSchema, {
    method: 'PATCH',
    body: { status, version },
  });
}

// -------------------------------------------------------------------- membros

export async function inviteMember(
  organizationId: string,
  input: { email: string; role: OrganizationRole },
): Promise<ApiResult<z.infer<typeof invitationSchema>>> {
  return send(`/v1/organizations/${encodeURIComponent(organizationId)}/invitations`, invitationSchema, {
    method: 'POST',
    body: { email: input.email, role: input.role, projectIds: [] },
  });
}

/**
 * Aceita um convite com a conta que já está autenticada.
 *
 * A API confere que o endereço do convite é o da conta e que ele está
 * confirmado; o Hub Web não repete essa decisão, apenas traduz a recusa.
 */
export async function acceptInvitation(
  token: string,
): Promise<ApiResult<z.infer<typeof acceptInvitationResponseSchema>>> {
  return send('/v1/invitations/accept', acceptInvitationResponseSchema, {
    method: 'POST',
    body: { token },
  });
}

export async function updateMember(
  organizationId: string,
  memberId: string,
  input: { role?: OrganizationRole; status?: 'active' | 'suspended'; version: number },
): Promise<ApiResult<z.infer<typeof organizationMemberSchema>>> {
  return send(
    `/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`,
    organizationMemberSchema,
    { method: 'PATCH', body: input },
  );
}

// -------------------------------------------------------------- organizações

export async function createOrganization(name: string): Promise<ApiResult<{ id: string; slug: string }>> {
  return send('/v1/organizations', z.object({ id: z.string(), slug: z.string() }).loose(), {
    method: 'POST',
    body: { name },
  });
}
