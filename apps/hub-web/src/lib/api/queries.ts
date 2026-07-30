import 'server-only';
import type { z } from 'zod';
import { accessToken } from '@/lib/auth/session';
import { hubRequest, type HubRequestOptions } from './client';
import { failure, success, type ApiResult } from './result';
import {
  activeAgentListSchema,
  auditPageSchema,
  conversationPageSchema,
  deviceSessionListSchema,
  knowledgePageSchema,
  memberPageSchema,
  meResponseSchema,
  messagePageSchema,
  organizationPageSchema,
  organizationWithAccessSchema,
  planListSchema,
  presenceListSchema,
  projectPageSchema,
  projectSchema,
  sessionPageSchema,
  subscriptionOverviewSchema,
  taskPageSchema,
} from './schemas';
import type {
  ActiveAgent,
  AuditLog,
  Conversation,
  DashboardSummary,
  DeviceSession,
  KnowledgeItemSummary,
  Message,
  OrganizationMember,
  OrganizationRole,
  OrganizationWithAccess,
  Page,
  Plan,
  PresenceEntry,
  Project,
  Session,
  SubscriptionOverview,
  Task,
} from './types';

/**
 * Leituras do domínio, contra a Hub API de verdade.
 *
 * Duas coisas valem para tudo aqui:
 *
 * - **A organização é resolvida por ULID.** A API não aceita slug em rota
 *   nenhuma (`organizationParamsSchema` exige ULID). O slug que está na URL do
 *   Hub Web vira id por `GET /v1/me`, que já lista as organizações do usuário
 *   com slug e papel — uma chamada barata que também serve de autorização
 *   preliminar.
 * - **Listagem é paginada por cursor.** `data` vem como
 *   `{ items, pageInfo }`; as funções abaixo entregam `items` já desempacotado,
 *   e devolvem a página inteira só onde a tela realmente pagina.
 */

/** Tamanho de página das listagens que a tela mostra por inteiro. */
const PAGE_LIMIT = 100;

async function get<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: Omit<HubRequestOptions, 'accessToken' | 'method'>,
): Promise<ApiResult<T>> {
  const token = await accessToken();
  if (!token) {
    return failure('unauthorized', { code: 'SESSION_EXPIRED' });
  }
  return hubRequest(path, schema, { ...options, accessToken: token });
}

/** Desembrulha `{ items, pageInfo }` quando a tela só quer a lista. */
function items<T>(result: ApiResult<{ items: T[] }>): ApiResult<T[]> {
  return result.ok ? { ...result, data: result.data.items } : result;
}

// ---------------------------------------------------------------- identidade

export interface Viewer {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    avatarUrl: string | null;
    /** Preferências editáveis em `/settings/account`. */
    locale: string;
    timeZone: string;
  };
  organizations: { id: string; name: string; slug: string; role: OrganizationRole }[];
  activeOrganizationId: string | null;
}

export async function getViewer(): Promise<ApiResult<Viewer>> {
  const result = await get('/v1/me', meResponseSchema);
  return result.ok
    ? {
        ...result,
        data: {
          user: {
            id: result.data.user.id,
            name: result.data.user.name,
            email: result.data.user.email,
            emailVerified: result.data.user.emailVerified,
            avatarUrl: result.data.user.avatarUrl,
            locale: result.data.user.locale,
            timeZone: result.data.user.timeZone,
          },
          organizations: [...result.data.organizations],
          activeOrganizationId: result.data.activeOrganizationId,
        },
      }
    : result;
}

/**
 * Sessões vivas da conta.
 *
 * A API já marca qual delas é a que está fazendo a chamada (`current`), e é essa
 * marca que a tela usa — o `sessionId` guardado no cookie do Hub Web serviria,
 * mas duplicaria a decisão em dois lugares que podem discordar.
 */
export async function listSessions(): Promise<ApiResult<Session[]>> {
  return items(await get('/v1/me/sessions', sessionPageSchema, { query: { limit: PAGE_LIMIT } }));
}

/**
 * Dispositivos conectados — a extensão do VS Code.
 *
 * Vive na mesma tela das sessões: as duas listas respondem "onde eu estou
 * logado?", e separá-las faria alguém fechar as sessões, achar que terminou, e
 * deixar o editor conectado com uma credencial que vale 90 dias.
 */
export async function listDevices(): Promise<ApiResult<DeviceSession[]>> {
  return items(await get('/v1/me/devices', deviceSessionListSchema));
}

export async function listOrganizations(): Promise<ApiResult<OrganizationWithAccess[]>> {
  return items(await get('/v1/organizations', organizationPageSchema, { query: { limit: PAGE_LIMIT } }));
}

/**
 * Traduz o slug da URL no ULID que a API entende.
 * Slug desconhecido é `not-found`, não `forbidden`: quem não é membro não
 * precisa saber se a organização existe.
 */
export async function resolveOrganizationId(slug: string): Promise<ApiResult<string>> {
  const viewer = await getViewer();
  if (!viewer.ok) {
    return viewer;
  }
  const found = viewer.data.organizations.find((organization) => organization.slug === slug);
  return found ? { ...viewer, data: found.id } : failure('not-found', { code: 'ORGANIZATION_NOT_FOUND' });
}

export async function getOrganizationBySlug(slug: string): Promise<ApiResult<OrganizationWithAccess>> {
  const id = await resolveOrganizationId(slug);
  return id.ok
    ? get(`/v1/organizations/${encodeURIComponent(id.data)}`, organizationWithAccessSchema)
    : id;
}

export async function listMembers(organizationId: string): Promise<ApiResult<OrganizationMember[]>> {
  return items(
    await get(`/v1/organizations/${encodeURIComponent(organizationId)}/members`, memberPageSchema, {
      query: { limit: PAGE_LIMIT },
    }),
  );
}

export async function getSubscription(
  organizationId: string,
): Promise<ApiResult<SubscriptionOverview>> {
  return get(
    `/v1/organizations/${encodeURIComponent(organizationId)}/subscription`,
    subscriptionOverviewSchema,
  );
}

// ------------------------------------------------------------------ projetos

export async function listProjects(organizationId: string): Promise<ApiResult<Project[]>> {
  return items(
    await get(`/v1/organizations/${encodeURIComponent(organizationId)}/projects`, projectPageSchema, {
      query: { limit: PAGE_LIMIT },
    }),
  );
}

export async function getProject(projectId: string): Promise<ApiResult<Project>> {
  return get(`/v1/projects/${encodeURIComponent(projectId)}`, projectSchema);
}

export async function listConversations(projectId: string): Promise<ApiResult<Conversation[]>> {
  return items(
    await get(`/v1/projects/${encodeURIComponent(projectId)}/conversations`, conversationPageSchema, {
      query: { limit: PAGE_LIMIT },
    }),
  );
}

/**
 * Mensagens de uma conversa, na ordem em que se lê.
 * Sem `afterSequence` a API responde da mais nova para a mais velha; a tela
 * quer o contrário, então a inversão acontece aqui e não em cada componente.
 */
export async function listMessages(conversationId: string): Promise<ApiResult<Message[]>> {
  const result = await get(
    `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    messagePageSchema,
    { query: { limit: PAGE_LIMIT } },
  );
  return result.ok
    ? { ...result, data: [...result.data.items].sort((a, b) => a.sequence - b.sequence) }
    : result;
}

export async function listTasks(projectId: string): Promise<ApiResult<Task[]>> {
  return items(
    await get(`/v1/projects/${encodeURIComponent(projectId)}/tasks`, taskPageSchema, {
      query: { limit: PAGE_LIMIT },
    }),
  );
}

export async function listActiveAgents(projectId: string): Promise<ApiResult<ActiveAgent[]>> {
  const result = await get(
    `/v1/projects/${encodeURIComponent(projectId)}/agents/active`,
    activeAgentListSchema,
  );
  return result.ok ? { ...result, data: result.data.agents } : result;
}

export async function listPresence(projectId: string): Promise<ApiResult<PresenceEntry[]>> {
  const result = await get(`/v1/projects/${encodeURIComponent(projectId)}/presence`, presenceListSchema);
  return result.ok ? { ...result, data: [...result.data.entries] } : result;
}

export async function listKnowledge(projectId: string): Promise<ApiResult<KnowledgeItemSummary[]>> {
  return items(
    await get(`/v1/projects/${encodeURIComponent(projectId)}/knowledge`, knowledgePageSchema, {
      query: { limit: PAGE_LIMIT },
    }),
  );
}

// --------------------------------------------------------------- auditoria

/**
 * Registro de auditoria.
 *
 * A API resolve a organização pelo **token**, não pela URL: `GET /v1/audit` não
 * aceita `organizationId`. Quem estiver vendo uma organização que não é a ativa
 * da sessão precisa saber disso — a tela avisa em vez de mostrar a lista errada.
 */
export async function listAuditEvents(cursor?: string): Promise<ApiResult<Page<AuditLog>>> {
  const result = await get('/v1/audit', auditPageSchema, {
    query: { limit: 50, ...(cursor ? { cursor } : {}) },
  });
  return result.ok
    ? { ...result, data: { items: [...result.data.items], pageInfo: result.data.pageInfo } }
    : result;
}

// -------------------------------------------------------------------- planos

export async function listPlans(): Promise<ApiResult<Plan[]>> {
  const result = await get('/v1/admin/plans', planListSchema);
  return result.ok ? { ...result, data: [...result.data.plans] } : result;
}

// ----------------------------------------------------------------- dashboard

/** Projetos que entram na agregação do painel. Mais que isso é conta demais. */
const DASHBOARD_PROJECT_FANOUT = 6;

const ACTIVE_TASK_STATUSES = new Set(['claimed', 'in_progress']);
const PENDING_KNOWLEDGE_STATUSES = new Set(['proposed', 'draft']);

/**
 * Painel da organização.
 *
 * **A Hub API não tem endpoint de dashboard.** O que existe é a assinatura
 * (que já traz uso e limites), a lista de projetos e, por projeto, tarefas,
 * conhecimento e agentes. O painel é composto aqui, em paralelo e com um teto
 * de projetos — um leque sem limite viraria uma tela que fica mais lenta a cada
 * projeto novo.
 *
 * Quando um projeto não responde, o painel continua de pé e marca `partial`:
 * a tela diz que os números são um piso, em vez de fingir precisão.
 */
export async function getDashboard(organizationId: string): Promise<ApiResult<DashboardSummary>> {
  const [organization, projects, subscription, activity] = await Promise.all([
    get(`/v1/organizations/${encodeURIComponent(organizationId)}`, organizationWithAccessSchema),
    listProjects(organizationId),
    getSubscription(organizationId),
    listAuditEvents(),
  ]);

  if (!organization.ok) {
    return organization;
  }
  if (!projects.ok) {
    return projects;
  }

  const recentProjects = [...projects.data]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, DASHBOARD_PROJECT_FANOUT);

  const perProject = await Promise.all(
    recentProjects.map(async (project) => ({
      tasks: await listTasks(project.id),
      knowledge: await listKnowledge(project.id),
      agents: await listActiveAgents(project.id),
    })),
  );

  let partial = false;
  const tasks: Task[] = [];
  const knowledge: KnowledgeItemSummary[] = [];
  const agents: ActiveAgent[] = [];

  for (const bundle of perProject) {
    if (bundle.tasks.ok) {
      tasks.push(...bundle.tasks.data);
    } else {
      partial = true;
    }
    if (bundle.knowledge.ok) {
      knowledge.push(...bundle.knowledge.data);
    } else {
      partial = true;
    }
    if (bundle.agents.ok) {
      agents.push(...bundle.agents.data);
    } else {
      partial = true;
    }
  }

  return success({
    organization: organization.data,
    recentProjects,
    projectCount: projects.data.length,
    activeTasks: tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)),
    blockedTasks: tasks.filter((task) => task.status === 'blocked'),
    pendingReviews: tasks.filter((task) => task.status === 'in_review'),
    knowledgeProposals: knowledge.filter((entry) => PENDING_KNOWLEDGE_STATUSES.has(entry.status)),
    activeAgents: agents,
    subscription: subscription.ok ? subscription.data : null,
    recentActivity: activity.ok ? activity.data.items.slice(0, 8) : [],
    partial,
  });
}
