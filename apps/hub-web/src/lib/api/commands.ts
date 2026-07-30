import 'server-only';
import { z } from 'zod';
import { invitationSchema, organizationMemberSchema } from '@prometheon/contracts';
import { accessToken } from '@/lib/auth/session';
import { hubRequest, type HubRequestOptions } from './client';
import { failure, type ApiResult } from './result';
import {
  changePasswordResponseSchema,
  conversationSchema,
  messageSchema,
  projectSchema,
  revokeDeviceResultSchema,
  revokeSessionResultSchema,
  taskSchema,
  updateProfileResponseSchema,
} from './schemas';
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

// --------------------------------------------------------------------- conta

/**
 * Edita o próprio perfil (`PATCH /v1/me`).
 *
 * O corpo é parcial de propósito: o que não for enviado fica como está na API.
 * `avatarUrl: null` é o pedido explícito de remover a imagem, e por isso é
 * diferente de não mandar o campo.
 *
 * O e-mail não está aqui porque não está no contrato — trocar de endereço exige
 * verificar o novo antes de o antigo perder valor.
 */
export async function updateProfile(input: {
  name?: string | undefined;
  locale?: string | undefined;
  timeZone?: string | undefined;
  avatarUrl?: string | null | undefined;
}): Promise<ApiResult<z.infer<typeof updateProfileResponseSchema>>> {
  return send('/v1/me', updateProfileResponseSchema, { method: 'PATCH', body: input });
}

/**
 * Troca a senha estando logado (`POST /v1/me/password`).
 *
 * A API exige a senha atual, derruba as outras sessões da conta preservando
 * esta, e desconecta **todos** os dispositivos. Não há nada a fazer com o cookie
 * local: a sessão que fez a chamada continua valendo, e é justamente por isso
 * que a pessoa não é deslogada.
 *
 * A resposta traz quantos caíram de cada tipo, e a tela precisa dizer os dois —
 * quem trocou a senha vai ter de entrar de novo no VS Code, e descobrir isso na
 * próxima vez que abrir o editor é a pior hora.
 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<ApiResult<z.infer<typeof changePasswordResponseSchema>>> {
  return send('/v1/me/password', changePasswordResponseSchema, { method: 'POST', body: input });
}

/**
 * Derruba uma sessão da conta (`DELETE /v1/sessions/:id`).
 *
 * O nome carrega o `Account` para não colidir com o `revokeSession` de
 * `lib/auth/session`, que é outra coisa: aquele encerra **esta** sessão pelo
 * `logout`, este derruba qualquer uma da lista.
 */
export async function revokeAccountSession(
  sessionId: string,
): Promise<ApiResult<z.infer<typeof revokeSessionResultSchema>>> {
  return send(`/v1/sessions/${encodeURIComponent(sessionId)}`, revokeSessionResultSchema, {
    method: 'DELETE',
  });
}

/**
 * Desconecta um dispositivo.
 *
 * Não devolve `current` como a revogação de sessão: o Hub Web nunca é o
 * dispositivo da lista — quem está ali é a extensão do VS Code. Derrubar um não
 * pode deslogar esta aba.
 */
export async function revokeAccountDevice(
  deviceId: string,
): Promise<ApiResult<z.infer<typeof revokeDeviceResultSchema>>> {
  return send(`/v1/devices/${encodeURIComponent(deviceId)}`, revokeDeviceResultSchema, {
    method: 'DELETE',
  });
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
