/**
 * FRONTEIRA DE TIPOS DO DOMÍNIO — ponto único de troca.
 *
 * Os tipos e os schemas Zod da Hub API moram em `@prometheon/contracts`, que é
 * o mesmo pacote que a API usa para validar o que responde. Este módulo é o
 * re-export: nenhuma tela importa `@prometheon/contracts` diretamente, para que
 * uma divergência entre o contrato publicado e o que a API realmente devolve
 * tenha um único lugar para ser costurada (ver `schemas.ts`).
 *
 * Convenções do `Docs/03`: id é ULID em string, data é ISO 8601 em UTC e
 * dinheiro é inteiro na menor unidade da moeda.
 */

export type { Role } from '@prometheon/permissions';

import type {
  AuditLog as AuditLogType,
  KnowledgeItemSummary as KnowledgeItemSummaryType,
  OrganizationWithAccess as OrganizationWithAccessType,
  Project as ProjectType,
  SubscriptionOverview as SubscriptionOverviewType,
  Task as TaskType,
} from '@prometheon/contracts';

export type {
  AuditLog,
  Conversation,
  ConversationParticipant,
  CurrentUser,
  Invitation,
  KnowledgeItemSummary,
  KnowledgeStatus,
  Message,
  MessagePart,
  MessageAuthorType,
  Organization,
  OrganizationMember,
  OrganizationRole,
  OrganizationWithAccess,
  PageInfo,
  Permission,
  Plan,
  PlanLimits,
  PresenceEntry,
  Project,
  ProjectSettings,
  PublicUser,
  RealtimeEvent,
  RealtimeEventType,
  Subscription,
  SubscriptionOverview,
  Task,
  TaskPriority,
  TaskStatus,
  Usage,
  WorkMode,
} from '@prometheon/contracts';

export type Iso8601 = string;

/** Uma página de resultados; toda listagem da API responde neste formato. */
export interface Page<T> {
  items: T[];
  pageInfo: {
    nextCursor: string | null;
    previousCursor: string | null;
    hasMore: boolean;
  };
}

/**
 * Dispositivo com agente ativo num projeto.
 *
 * A API responde com um schema próprio do módulo de dispositivos, que não está
 * em `@prometheon/contracts` — daí a declaração local.
 * Fonte: `apps/hub-api/src/modules/devices/schemas.ts`.
 */
export interface ActiveAgent {
  deviceId: string;
  deviceName: string;
  kind: 'vscode' | 'cli' | 'ci' | 'other';
  platform: string | null;
  clientVersion: string | null;
  status: 'online' | 'idle';
  owner: { id: string; name: string; email: string; avatarUrl: string | null };
  activeAgentRunIds: string[];
  lastSeenAt: Iso8601;
}

/** Bilhete de conexão do canal ao vivo, emitido por `/api/realtime/ticket`. */
export interface RealtimeTicket {
  token: string;
  url: string;
  protocolVersion: number;
  heartbeatIntervalMs: number;
}

/**
 * Painel da organização.
 *
 * A Hub API **não tem** um endpoint de dashboard: este objeto é composto no
 * servidor do Hub Web a partir de leituras reais (`queries.ts`). O tipo existe
 * para que a tela não precise saber de quantas chamadas ele nasceu.
 */
export interface DashboardSummary {
  organization: OrganizationWithAccessType;
  recentProjects: ProjectType[];
  projectCount: number;
  activeTasks: TaskType[];
  blockedTasks: TaskType[];
  pendingReviews: TaskType[];
  knowledgeProposals: KnowledgeItemSummaryType[];
  activeAgents: ActiveAgent[];
  subscription: SubscriptionOverviewType | null;
  recentActivity: AuditLogType[];
  /** `true` quando algum projeto não respondeu — os números são um piso. */
  partial: boolean;
}
