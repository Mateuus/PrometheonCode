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
  SyncIncident,
  Task,
  User,
} from './types';

/**
 * PROVISÓRIO — dados de exemplo.
 *
 * A Hub API (`Docs/06`) ainda não existe. Enquanto isso, as telas precisam ser
 * navegáveis e revisáveis, então este módulo devolve dados plausíveis com o
 * mesmo formato do contrato. Ele só é consultado quando `HUB_WEB_SAMPLE_DATA`
 * está ligado; com o flag desligado, nada aqui é importado em tempo de execução.
 *
 * Quando a API subir: apagar este arquivo e o ramo de exemplo em `queries.ts`.
 * Nenhum outro lugar depende dele.
 */

/** Datas relativas ao agora, para as telas não parecerem congeladas em 1970. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return minutesAgo(days * 24 * 60);
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
}

export const sampleUser: User = {
  id: '01JB7Q4X2N0000000000000001',
  name: 'Mateus Rodrigues',
  email: 'mateus@prometheoncode.xyz',
  createdAt: daysAgo(240),
};

export const sampleOrganizations: Organization[] = [
  {
    id: '01JB7Q4X2N0000000000000010',
    slug: 'prometheon',
    name: 'Prometheon',
    viewerRole: 'owner',
    memberCount: 7,
    projectCount: 3,
    planId: 'plan_free',
  },
  {
    id: '01JB7Q4X2N0000000000000011',
    slug: 'acme-labs',
    name: 'Acme Labs',
    viewerRole: 'developer',
    memberCount: 24,
    projectCount: 6,
    planId: 'plan_free',
  },
];

export const sampleProjects: Project[] = [
  {
    id: '01JB7Q4X2N0000000000000100',
    organizationId: sampleOrganizations[0]!.id,
    name: 'prometheon-code',
    description: 'Extensão do VS Code e o Core local.',
    repositoryUrl: 'https://github.com/Mateuus/PrometheonCode',
    defaultBranch: 'main',
    openTaskCount: 12,
    activeAgentCount: 2,
    lastActivityAt: minutesAgo(4),
  },
  {
    id: '01JB7Q4X2N0000000000000101',
    organizationId: sampleOrganizations[0]!.id,
    name: 'hub-api',
    description: 'Fastify, contratos e OpenAPI do Hub.',
    repositoryUrl: 'https://github.com/Mateuus/PrometheonHub',
    defaultBranch: 'main',
    openTaskCount: 5,
    activeAgentCount: 1,
    lastActivityAt: minutesAgo(38),
  },
  {
    id: '01JB7Q4X2N0000000000000102',
    organizationId: sampleOrganizations[0]!.id,
    name: 'infrastructure',
    description: 'Compose, observabilidade e migrações.',
    repositoryUrl: 'https://github.com/Mateuus/PrometheonInfra',
    defaultBranch: 'main',
    openTaskCount: 0,
    activeAgentCount: 0,
    lastActivityAt: daysAgo(3),
  },
];

export const sampleMembers: Member[] = [
  {
    id: '01JB7Q4X2N0000000000000200',
    userId: sampleUser.id,
    name: sampleUser.name,
    email: sampleUser.email,
    role: 'owner',
    status: 'active',
    joinedAt: daysAgo(240),
    lastSeenAt: minutesAgo(0),
    online: true,
  },
  {
    id: '01JB7Q4X2N0000000000000201',
    userId: '01JB7Q4X2N0000000000000002',
    name: 'Ana Prado',
    email: 'ana@prometheoncode.xyz',
    role: 'maintainer',
    status: 'active',
    joinedAt: daysAgo(120),
    lastSeenAt: minutesAgo(3),
    online: true,
  },
  {
    id: '01JB7Q4X2N0000000000000202',
    userId: '01JB7Q4X2N0000000000000003',
    name: 'Bruno Cardoso',
    email: 'bruno@prometheoncode.xyz',
    role: 'developer',
    status: 'active',
    joinedAt: daysAgo(64),
    lastSeenAt: minutesAgo(52),
    online: false,
  },
  {
    id: '01JB7Q4X2N0000000000000203',
    userId: '01JB7Q4X2N0000000000000004',
    name: 'Carla Menezes',
    email: 'carla@prometheoncode.xyz',
    role: 'reviewer',
    status: 'active',
    joinedAt: daysAgo(30),
    lastSeenAt: minutesAgo(11),
    online: true,
  },
  {
    id: '01JB7Q4X2N0000000000000204',
    userId: '01JB7Q4X2N0000000000000005',
    name: 'Diego Nunes',
    email: 'diego@prometheoncode.xyz',
    role: 'viewer',
    status: 'invited',
    joinedAt: daysAgo(2),
    lastSeenAt: null,
    online: false,
  },
];

export const sampleTasks: Task[] = [
  {
    id: '01JB7Q4X2N0000000000000300',
    projectId: sampleProjects[0]!.id,
    title: 'Fechar o protocolo de sessão do Core local',
    status: 'running',
    assigneeName: 'Ana Prado',
    blockedReason: null,
    updatedAt: minutesAgo(6),
  },
  {
    id: '01JB7Q4X2N0000000000000301',
    projectId: sampleProjects[0]!.id,
    title: 'Migrar o painel para a Secondary Side Bar',
    status: 'review',
    assigneeName: 'Bruno Cardoso',
    blockedReason: null,
    updatedAt: minutesAgo(45),
  },
  {
    id: '01JB7Q4X2N0000000000000302',
    projectId: sampleProjects[0]!.id,
    title: 'Publicar o pacote de contratos',
    status: 'blocked',
    assigneeName: null,
    blockedReason: 'Aguardando o schema de auditoria',
    updatedAt: minutesAgo(180),
  },
  {
    id: '01JB7Q4X2N0000000000000303',
    projectId: sampleProjects[0]!.id,
    title: 'Escrever o teste de fumaça do login',
    status: 'backlog',
    assigneeName: null,
    blockedReason: null,
    updatedAt: daysAgo(1),
  },
  {
    id: '01JB7Q4X2N0000000000000304',
    projectId: sampleProjects[0]!.id,
    title: 'Encerrar o rate limit por organização',
    status: 'done',
    assigneeName: 'Carla Menezes',
    blockedReason: null,
    updatedAt: daysAgo(2),
  },
  {
    id: '01JB7Q4X2N0000000000000305',
    projectId: sampleProjects[1]!.id,
    title: 'Gerar a OpenAPI 3.1 no build',
    status: 'running',
    assigneeName: 'Ana Prado',
    blockedReason: null,
    updatedAt: minutesAgo(22),
  },
  {
    id: '01JB7Q4X2N0000000000000306',
    projectId: sampleProjects[1]!.id,
    title: 'Concorrência otimista nas tarefas',
    status: 'blocked',
    assigneeName: 'Bruno Cardoso',
    blockedReason: 'Falta a coluna de versão na migração',
    updatedAt: minutesAgo(300),
  },
];

export const sampleAgents: Agent[] = [
  {
    id: '01JB7Q4X2N0000000000000400',
    projectId: sampleProjects[0]!.id,
    name: 'Prometheus',
    role: 'main',
    status: 'working',
    deviceLabel: 'MATEUS-DESKTOP',
    currentTaskTitle: 'Fechar o protocolo de sessão do Core local',
    lastHeartbeatAt: minutesAgo(0),
  },
  {
    id: '01JB7Q4X2N0000000000000401',
    projectId: sampleProjects[0]!.id,
    name: 'Reviewer',
    role: 'worker',
    status: 'idle',
    deviceLabel: 'MATEUS-DESKTOP',
    currentTaskTitle: null,
    lastHeartbeatAt: minutesAgo(1),
  },
  {
    id: '01JB7Q4X2N0000000000000402',
    projectId: sampleProjects[0]!.id,
    name: 'Docs Writer',
    role: 'worker',
    status: 'offline',
    deviceLabel: 'ANA-NOTEBOOK',
    currentTaskTitle: null,
    lastHeartbeatAt: minutesAgo(190),
  },
  {
    id: '01JB7Q4X2N0000000000000403',
    projectId: sampleProjects[1]!.id,
    name: 'Prometheus',
    role: 'main',
    status: 'working',
    deviceLabel: 'ANA-NOTEBOOK',
    currentTaskTitle: 'Gerar a OpenAPI 3.1 no build',
    lastHeartbeatAt: minutesAgo(0),
  },
];

export const sampleConversations: Conversation[] = [
  {
    id: '01JB7Q4X2N0000000000000500',
    projectId: sampleProjects[0]!.id,
    title: 'Revisar o fluxo de autonomia',
    messageCount: 18,
    updatedAt: minutesAgo(7),
  },
  {
    id: '01JB7Q4X2N0000000000000501',
    projectId: sampleProjects[0]!.id,
    title: 'Plano de migração do painel',
    messageCount: 42,
    updatedAt: minutesAgo(96),
  },
  {
    id: '01JB7Q4X2N0000000000000502',
    projectId: sampleProjects[0]!.id,
    title: 'Erros do empacotamento do vsix',
    messageCount: 9,
    updatedAt: daysAgo(2),
  },
];

export const sampleMessages: Message[] = [
  {
    id: '01JB7Q4X2N0000000000000600',
    conversationId: sampleConversations[0]!.id,
    authorType: 'user',
    authorName: 'Mateus Rodrigues',
    body: 'O modo Agent Team pode delegar sem aprovação quando a autonomia está em Auto?',
    createdAt: minutesAgo(24),
  },
  {
    id: '01JB7Q4X2N0000000000000601',
    conversationId: sampleConversations[0]!.id,
    authorType: 'agent',
    authorName: 'Prometheus',
    body: 'Não. Em Auto eu aprovo o que é seguro e paro no que é arriscado. Delegar para um worker conta como ação segura; escrever fora do escopo autorizado, não.',
    createdAt: minutesAgo(23),
  },
  {
    id: '01JB7Q4X2N0000000000000602',
    conversationId: sampleConversations[0]!.id,
    authorType: 'user',
    authorName: 'Mateus Rodrigues',
    body: 'Então documenta isso no cérebro do projeto e abre a proposta para revisão.',
    createdAt: minutesAgo(9),
  },
  {
    id: '01JB7Q4X2N0000000000000603',
    conversationId: sampleConversations[0]!.id,
    authorType: 'system',
    authorName: 'Hub',
    body: 'Proposta de conhecimento criada e enviada para revisão.',
    createdAt: minutesAgo(7),
  },
];

export const sampleKnowledge: KnowledgeEntry[] = [
  {
    id: '01JB7Q4X2N0000000000000700',
    projectId: sampleProjects[0]!.id,
    title: 'A webview nunca toca em segredo',
    summary:
      'Toda leitura de segredo acontece no processo da extensão, via SecretStorage. A webview só envia mensagens tipadas.',
    status: 'approved',
    authorName: 'Mateus Rodrigues',
    updatedAt: daysAgo(12),
  },
  {
    id: '01JB7Q4X2N0000000000000701',
    projectId: sampleProjects[0]!.id,
    title: 'Autonomia Auto não dispensa aprovação de ação arriscada',
    summary:
      'Em Auto, o agente aprova ações seguras e para nas arriscadas. Bypass só vale dentro do escopo autorizado.',
    status: 'proposed',
    authorName: 'Prometheus',
    updatedAt: minutesAgo(7),
  },
  {
    id: '01JB7Q4X2N0000000000000702',
    projectId: sampleProjects[0]!.id,
    title: 'Instalar dependências com --prefix quebra o pacote',
    summary:
      'O npm grava a raiz como dependência de runtime da extensão. Instalar sempre de dentro de extension/.',
    status: 'approved',
    authorName: 'Ana Prado',
    updatedAt: daysAgo(20),
  },
];

export const sampleAuditEvents: AuditEvent[] = [
  {
    id: '01JB7Q4X2N0000000000000800',
    occurredAt: minutesAgo(3),
    actorName: 'Ana Prado',
    action: 'knowledge.approve',
    target: 'prometheon-code / A webview nunca toca em segredo',
    ipAddress: '187.54.10.22',
  },
  {
    id: '01JB7Q4X2N0000000000000801',
    occurredAt: minutesAgo(41),
    actorName: 'Mateus Rodrigues',
    action: 'members.invite',
    target: 'diego@prometheoncode.xyz',
    ipAddress: '187.54.10.22',
  },
  {
    id: '01JB7Q4X2N0000000000000802',
    occurredAt: minutesAgo(190),
    actorName: 'Prometheus (agente)',
    action: 'agent.start_remote',
    target: 'prometheon-code / MATEUS-DESKTOP',
    ipAddress: '10.0.4.19',
  },
  {
    id: '01JB7Q4X2N0000000000000803',
    occurredAt: daysAgo(1),
    actorName: 'Bruno Cardoso',
    action: 'project.configure',
    target: 'hub-api',
    ipAddress: '201.17.88.4',
  },
  {
    id: '01JB7Q4X2N0000000000000804',
    occurredAt: daysAgo(2),
    actorName: 'Mateus Rodrigues',
    action: 'organization.manage',
    target: 'Prometheon',
    ipAddress: '187.54.10.22',
  },
];

export const sampleSessions: AuthSession[] = [
  {
    id: '01JB7Q4X2N0000000000000900',
    deviceLabel: 'Windows 11 · Edge 141',
    ipAddress: '187.54.10.22',
    createdAt: daysAgo(1),
    lastActiveAt: minutesAgo(0),
    current: true,
  },
  {
    id: '01JB7Q4X2N0000000000000901',
    deviceLabel: 'Windows 11 · VS Code (Prometheon Code)',
    ipAddress: '187.54.10.22',
    createdAt: daysAgo(9),
    lastActiveAt: minutesAgo(14),
    current: false,
  },
  {
    id: '01JB7Q4X2N0000000000000902',
    deviceLabel: 'Android · Chrome 141',
    ipAddress: '177.9.201.77',
    createdAt: daysAgo(26),
    lastActiveAt: daysAgo(4),
    current: false,
  },
];

const sampleSyncIncidents: SyncIncident[] = [
  {
    id: '01JB7Q4X2N0000000000000A00',
    projectName: 'hub-api',
    summary: 'Heartbeat do device ANA-NOTEBOOK ficou 3 minutos sem chegar.',
    occurredAt: minutesAgo(190),
    severity: 'warning',
  },
];

/**
 * Um único plano gratuito, como o produto oferece hoje. A tela de planos já
 * trabalha com lista e com limites por plano, então acrescentar um plano pago é
 * acrescentar um item aqui — nenhuma tela muda.
 */
export const samplePlans: Plan[] = [
  {
    id: 'plan_free',
    slug: 'free',
    name: 'Free',
    priceCents: 0,
    currency: 'BRL',
    isDefault: true,
    visible: true,
    limits: {
      membersPerOrganization: 10,
      projectsPerOrganization: 5,
      concurrentAgents: 3,
      messagesPerMonth: 2000,
      knowledgeStorageMb: 512,
      auditRetentionDays: 30,
    },
    organizationCount: 2,
  },
];

export const sampleInvitation: Invitation = {
  token: 'sample-invite-token',
  organizationName: 'Prometheon',
  organizationSlug: 'prometheon',
  role: 'developer',
  invitedEmail: 'convidado@prometheoncode.xyz',
  expiresAt: daysAhead(6),
};

export function sampleDashboard(): DashboardSummary {
  return {
    recentProjects: sampleProjects,
    membersOnline: sampleMembers.filter((member) => member.online),
    agentsWorking: sampleAgents.filter((agent) => agent.status === 'working'),
    blockedTasks: sampleTasks.filter((task) => task.status === 'blocked'),
    pendingReviews: sampleTasks.filter((task) => task.status === 'review'),
    knowledgeProposals: sampleKnowledge.filter((entry) => entry.status === 'proposed'),
    usage: {
      messages: { used: 1284, limit: 2000, unit: 'count' },
      tasks: { used: 317, limit: null, unit: 'count' },
      storage: { used: 148, limit: 512, unit: 'megabytes' },
    },
    syncIncidents: sampleSyncIncidents,
  };
}
