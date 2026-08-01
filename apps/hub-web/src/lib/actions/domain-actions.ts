'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ORGANIZATION_ROLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  projectSettingsSchema,
} from '@prometheon/contracts';
import {
  acceptInvitation,
  createConversation,
  createMessage,
  createProject,
  createTask,
  inviteMember,
  updateProject,
  updateTaskStatus,
} from '@/lib/api/commands';
import { resolveOrganizationId } from '@/lib/api/queries';
import type { ApiFailure } from '@/lib/api/result';
import { formError, formSuccess, type FormState } from './form-state';

/**
 * Escritas disparadas por formulário.
 *
 * A action valida a entrada, chama o comando e devolve uma chave de tradução.
 * Ela **não** decide permissão: quem nega é a Hub API, e a tradução do erro só
 * existe para o usuário entender a negativa — inclusive a de e-mail não
 * confirmado, que é a mais comum numa conta recém-criada.
 */

function translateFailure(failure: ApiFailure): FormState {
  switch (failure.kind) {
    case 'offline':
      return formError('auth.error.offline');
    case 'unauthorized':
      return formError('state.unauthorized.title');
    case 'email-unverified':
      return formError('auth.verify.requiredToWrite');
    case 'forbidden':
      return formError('state.forbidden.title');
    default:
      return formError(
        failure.code === 'PLAN_LIMIT_EXCEEDED' ? 'error.planLimit' : 'auth.error.generic',
      );
  }
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

// ------------------------------------------------------------------ projetos

export async function createProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const organizationSlug = field(formData, 'organizationSlug');
  const name = field(formData, 'name');
  const description = field(formData, 'description');

  if (name === '') {
    return formError('projects.error.nameRequired', { name: 'projects.error.nameRequired' });
  }

  const organizationId = await resolveOrganizationId(organizationSlug);
  if (!organizationId.ok) {
    return translateFailure(organizationId);
  }

  const created = await createProject(organizationId.data, {
    name,
    ...(description === '' ? {} : { description }),
  });
  if (!created.ok) {
    return translateFailure(created);
  }

  revalidatePath(`/app/${organizationSlug}/projects`);
  redirect(`/app/${organizationSlug}/projects/${created.data.id}`);
}

export async function updateProjectAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = field(formData, 'projectId');
  const name = field(formData, 'name');
  const description = field(formData, 'description');
  const version = z.coerce.number().int().safeParse(field(formData, 'version'));

  if (name === '') {
    return formError('projects.error.nameRequired', { name: 'projects.error.nameRequired' });
  }
  if (!version.success) {
    return formError('auth.error.generic');
  }

  const updated = await updateProject(projectId, {
    name,
    description: description === '' ? null : description,
    version: version.data,
  });
  if (!updated.ok) {
    return updated.code === 'VERSION_CONFLICT'
      ? formError('projects.error.versionConflict')
      : translateFailure(updated);
  }

  revalidatePath(field(formData, 'returnTo') || '/app');
  return formSuccess('projects.saved');
}

/**
 * Salva o comportamento do projeto — o objeto `settings` inteiro.
 *
 * A entrada é validada com o próprio `projectSettingsSchema` do contrato antes
 * de ir à rede: o que a Hub API recusaria nem chega a sair daqui, e os dois
 * campos digitados à mão ganham erro por campo em vez de uma recusa genérica.
 * Checkbox desmarcado não viaja no `FormData`, então a ausência é o `false`.
 */
export async function updateProjectBehaviorAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const projectId = field(formData, 'projectId');
  const version = z.coerce.number().int().safeParse(field(formData, 'version'));
  if (!version.success) {
    return formError('auth.error.generic');
  }

  const retention = field(formData, 'conversationRetentionDays');
  const settings = projectSettingsSchema.safeParse({
    defaultWorkMode: field(formData, 'defaultWorkMode'),
    defaultAutonomy: field(formData, 'defaultAutonomy'),
    requireReview: formData.get('requireReview') !== null,
    allowRemoteAgents: formData.get('allowRemoteAgents') !== null,
    // `Number` em vez de coerção por campo: assim NaN, decimal e fora do teto
    // reprovam no schema com o `path` certo, e o erro cai no campo culpado.
    contextBudgetTokens: Number(field(formData, 'contextBudgetTokens')),
    // Vazio é escolha, não esquecimento: `null` segue a política da organização.
    conversationRetentionDays: retention === '' ? null : Number(retention),
  });

  if (!settings.success) {
    const fieldErrors: NonNullable<FormState['fieldErrors']> = {};
    for (const issue of settings.error.issues) {
      if (issue.path[0] === 'contextBudgetTokens') {
        fieldErrors.contextBudgetTokens = 'projectSettings.error.contextBudget';
      } else if (issue.path[0] === 'conversationRetentionDays') {
        fieldErrors.conversationRetentionDays = 'projectSettings.error.retention';
      }
    }
    // Selects e checkboxes não produzem valor inválido sem adulteração; se foi
    // o caso, o genérico basta.
    return formError(
      fieldErrors.contextBudgetTokens ??
        fieldErrors.conversationRetentionDays ??
        'auth.error.generic',
      fieldErrors,
    );
  }

  const updated = await updateProject(projectId, {
    settings: settings.data,
    version: version.data,
  });
  if (!updated.ok) {
    // Concorrência otimista: a mensagem manda recarregar para ler a versão nova.
    return updated.code === 'VERSION_CONFLICT'
      ? formError('projects.error.versionConflict')
      : translateFailure(updated);
  }

  // A visão geral repete estes valores no card de comportamento; revalidar só a
  // página do formulário deixaria aquele card mostrando o passado.
  const projectPath = field(formData, 'projectPath');
  if (projectPath !== '') {
    revalidatePath(projectPath);
    revalidatePath(`${projectPath}/settings`);
  }
  return formSuccess('projects.saved');
}

// -------------------------------------------------------------------- conversa

export async function createConversationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const organizationSlug = field(formData, 'organizationSlug');
  const projectId = field(formData, 'projectId');
  const title = field(formData, 'title');

  const created = await createConversation(projectId, {
    ...(title === '' ? {} : { title }),
  });
  if (!created.ok) {
    return translateFailure(created);
  }

  const base = `/app/${organizationSlug}/projects/${projectId}/chat`;
  revalidatePath(base);
  redirect(`${base}?conversation=${created.data.id}`);
}

export async function sendMessageAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const conversationId = field(formData, 'conversationId');
  const body = field(formData, 'body');

  if (conversationId === '') {
    return formError('chat.error.noConversation');
  }
  if (body === '') {
    return formError('chat.error.emptyMessage');
  }

  const sent = await createMessage(conversationId, body);
  if (!sent.ok) {
    return translateFailure(sent);
  }

  revalidatePath(field(formData, 'returnTo') || '/app');
  return formSuccess('chat.messageSent');
}

// -------------------------------------------------------------------- tarefas

export async function createTaskAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const projectId = field(formData, 'projectId');
  const title = field(formData, 'title');
  const priority = z.enum(TASK_PRIORITIES).safeParse(field(formData, 'priority'));

  if (title === '') {
    return formError('tasks.error.titleRequired', { title: 'tasks.error.titleRequired' });
  }

  const created = await createTask(projectId, {
    title,
    ...(priority.success ? { priority: priority.data } : {}),
  });
  if (!created.ok) {
    return translateFailure(created);
  }

  revalidatePath(field(formData, 'returnTo') || '/app');
  return formSuccess('tasks.created');
}

export async function updateTaskStatusAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const taskId = field(formData, 'taskId');
  const status = z.enum(TASK_STATUSES).safeParse(field(formData, 'status'));
  const version = z.coerce.number().int().safeParse(field(formData, 'version'));

  if (!status.success || !version.success) {
    return formError('auth.error.generic');
  }

  const updated = await updateTaskStatus(taskId, status.data, version.data);
  if (!updated.ok) {
    // Concorrência otimista: outra pessoa (ou um agente) mexeu antes.
    return updated.code === 'VERSION_CONFLICT'
      ? formError('tasks.error.versionConflict')
      : translateFailure(updated);
  }

  revalidatePath(field(formData, 'returnTo') || '/app');
  return formSuccess('tasks.updatedOk');
}

// -------------------------------------------------------------------- membros

/**
 * Aceita um convite com a conta que já está autenticada.
 *
 * Cada recusa da API vira uma mensagem própria: "venceu", "foi cancelado", "já
 * foi usado" e "é de outro endereço" pedem coisas diferentes de quem recebeu o
 * link, e um erro genérico deixaria a pessoa sem saber se insiste, se pede outro
 * convite ou se já está dentro.
 */
export async function acceptInvitationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = field(formData, 'token');
  if (token === '') {
    return formError('invite.error.invalidToken');
  }

  const accepted = await acceptInvitation(token);
  if (!accepted.ok) {
    switch (accepted.code) {
      case 'INVITATION_EMAIL_MISMATCH':
        return formError('invite.error.emailMismatch');
      case 'INVITATION_EXPIRED':
        return formError('invite.error.expired');
      case 'INVITATION_REVOKED':
        return formError('invite.error.revoked');
      case 'INVITATION_ALREADY_USED':
        return formError('invite.error.alreadyUsed');
      case 'INVITATION_NOT_FOUND':
        return formError('invite.error.invalidToken');
      case 'MEMBER_ALREADY_EXISTS':
        return formError('invite.error.membershipBlocked');
      default:
        return translateFailure(accepted);
    }
  }

  // A lista de organizações do usuário mudou; a casca desenha o seletor a
  // partir dela.
  revalidatePath('/', 'layout');
  redirect(`/app/${accepted.data.organization.slug}`);
}

export async function inviteMemberAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const organizationSlug = field(formData, 'organizationSlug');
  const email = z.string().email().safeParse(field(formData, 'email'));
  const role = z.enum(ORGANIZATION_ROLES).safeParse(field(formData, 'role'));

  if (!email.success) {
    return formError('auth.error.invalidEmail', { email: 'auth.error.invalidEmail' });
  }
  if (!role.success) {
    return formError('auth.error.generic');
  }

  const organizationId = await resolveOrganizationId(organizationSlug);
  if (!organizationId.ok) {
    return translateFailure(organizationId);
  }

  const invited = await inviteMember(organizationId.data, { email: email.data, role: role.data });
  if (!invited.ok) {
    return invited.code === 'MEMBER_ALREADY_EXISTS'
      ? formError('members.error.alreadyMember')
      : translateFailure(invited);
  }

  revalidatePath(`/app/${organizationSlug}/members`);
  return formSuccess('members.invited');
}
