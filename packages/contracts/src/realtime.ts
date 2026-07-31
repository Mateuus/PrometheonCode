/**
 * Protocolo de tempo real (`Docs/08`).
 *
 * O envelope é versionado e carrega `cursor` para retomada. Os payloads são
 * propositalmente enxutos — o WebSocket avisa que algo mudou, e o cliente busca
 * o estado completo pelo REST quando precisa. Isso mantém o payload limitado e
 * evita que a entidade inteira tenha dois formatos concorrentes.
 *
 * Entrega é pelo menos uma vez: o consumidor precisa deduplicar por `id`.
 */

import { z } from 'zod';

import { messageAuthorTypeSchema, messageStatusSchema } from './messages.js';
import { organizationRoleSchema } from './permissions.js';
import {
  cursorSchema,
  isoDateTimeSchema,
  shortTextSchema,
  ulidSchema,
} from './primitives.js';
import { taskStatusSchema } from './tasks.js';

/** Versão do protocolo falada por este pacote. */
export const REALTIME_PROTOCOL_VERSION = 1;

export const REALTIME_EVENT_TYPES = [
  'presence.changed',
  'device.changed',
  'member.joined',
  'agent.started',
  'agent.updated',
  'agent.stopped',
  'task.created',
  'task.updated',
  'task.claimed',
  'task.released',
  'message.created',
  'message.updated',
  'approval.requested',
  'approval.resolved',
  'knowledge.proposed',
  'knowledge.reviewed',
  'scope.reserved',
  'scope.conflict',
  'git.webhook.processed',
] as const;

export const realtimeEventTypeSchema = z.enum(REALTIME_EVENT_TYPES);

export type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>;

/** Campos comuns a todo evento. */
const envelopeBase = {
  id: ulidSchema,
  version: z.int().positive(),
  organizationId: ulidSchema,
  projectId: ulidSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  cursor: cursorSchema,
};

/** Monta o envelope de um tipo de evento com o payload que lhe corresponde. */
export function realtimeEvent<
  T extends RealtimeEventType,
  D extends z.ZodType,
>(type: T, data: D) {
  return z.object({
    ...envelopeBase,
    type: z.literal(type),
    data,
  });
}

const actorSchema = z.object({
  type: z.enum(['user', 'agent', 'system', 'device']),
  id: ulidSchema.nullable(),
});

export const presenceChangedEventSchema = realtimeEvent(
  'presence.changed',
  z.object({
    userId: ulidSchema,
    status: z.enum(['online', 'idle', 'offline']),
    deviceCount: z.int().nonnegative(),
  }),
);

export const deviceChangedEventSchema = realtimeEvent(
  'device.changed',
  z.object({
    deviceId: ulidSchema,
    status: z.enum(['online', 'idle', 'offline', 'revoked']),
  }),
);

/**
 * `member.joined` — alguém passou a fazer parte da organização.
 *
 * O payload é enxuto como os demais (`Docs/08`): quem já está conectado descobre
 * que a lista de membros mudou e vai buscá-la pelo REST. O e-mail do convidado
 * **não** entra aqui — o evento chega a todo mundo que assina a organização, e
 * nem todo papel tem direito de ler o cadastro dos outros.
 */
export const memberJoinedEventSchema = realtimeEvent(
  'member.joined',
  z.object({
    memberId: ulidSchema,
    userId: ulidSchema,
    role: organizationRoleSchema,
    /** Convite que originou a associação; nulo quando não houve convite. */
    invitationId: ulidSchema.nullable(),
  }),
);

const agentEventData = z.object({
  agentRunId: ulidSchema,
  taskId: ulidSchema.nullable(),
  conversationId: ulidSchema.nullable(),
  deviceId: ulidSchema.nullable(),
  status: z.enum([
    'starting',
    'running',
    'waiting_approval',
    'paused',
    'succeeded',
    'failed',
    'cancelled',
  ]),
});

export const agentStartedEventSchema = realtimeEvent(
  'agent.started',
  agentEventData,
);
export const agentUpdatedEventSchema = realtimeEvent(
  'agent.updated',
  agentEventData,
);
export const agentStoppedEventSchema = realtimeEvent(
  'agent.stopped',
  agentEventData.extend({ reason: shortTextSchema.nullable() }),
);

// O estado vem do próprio contrato de tarefa: duplicar o enum aqui já custou
// um valor esquecido (`failed`), e um evento com estado fora do enum é
// descartado pelo cliente exatamente quando mais importa.
const taskEventData = z.object({
  taskId: ulidSchema,
  status: taskStatusSchema,
  version: z.int().nonnegative(),
  actor: actorSchema,
});

export const taskCreatedEventSchema = realtimeEvent(
  'task.created',
  taskEventData,
);
export const taskUpdatedEventSchema = realtimeEvent(
  'task.updated',
  taskEventData,
);
export const taskClaimedEventSchema = realtimeEvent(
  'task.claimed',
  taskEventData.extend({ leaseExpiresAt: isoDateTimeSchema }),
);
export const taskReleasedEventSchema = realtimeEvent(
  'task.released',
  taskEventData,
);

const messageEventData = z.object({
  conversationId: ulidSchema,
  messageId: ulidSchema,
  sequence: z.int().nonnegative(),
  authorType: messageAuthorTypeSchema,
  status: messageStatusSchema,
});

export const messageCreatedEventSchema = realtimeEvent(
  'message.created',
  messageEventData,
);
export const messageUpdatedEventSchema = realtimeEvent(
  'message.updated',
  messageEventData,
);

export const approvalRequestedEventSchema = realtimeEvent(
  'approval.requested',
  z.object({
    approvalId: ulidSchema,
    agentRunId: ulidSchema,
    taskId: ulidSchema.nullable(),
    action: shortTextSchema,
    expiresAt: isoDateTimeSchema,
  }),
);

export const approvalResolvedEventSchema = realtimeEvent(
  'approval.resolved',
  z.object({
    approvalId: ulidSchema,
    decision: z.enum(['approved', 'rejected', 'expired']),
    resolvedBy: ulidSchema.nullable(),
  }),
);

export const knowledgeProposedEventSchema = realtimeEvent(
  'knowledge.proposed',
  z.object({
    knowledgeId: ulidSchema,
    title: shortTextSchema,
    proposedBy: ulidSchema,
  }),
);

export const knowledgeReviewedEventSchema = realtimeEvent(
  'knowledge.reviewed',
  z.object({
    knowledgeId: ulidSchema,
    decision: z.enum(['approve', 'reject', 'request_changes']),
    reviewedBy: ulidSchema,
  }),
);

export const scopeReservedEventSchema = realtimeEvent(
  'scope.reserved',
  z.object({
    taskId: ulidSchema,
    agentRunId: ulidSchema.nullable(),
    paths: z.array(z.string().max(512)).max(200),
    exclusive: z.boolean(),
  }),
);

export const scopeConflictEventSchema = realtimeEvent(
  'scope.conflict',
  z.object({
    taskId: ulidSchema,
    conflictingTaskId: ulidSchema,
    paths: z.array(z.string().max(512)).max(200),
  }),
);

export const gitWebhookProcessedEventSchema = realtimeEvent(
  'git.webhook.processed',
  z.object({
    connectionId: ulidSchema,
    repositoryId: ulidSchema.nullable(),
    provider: z.enum(['github', 'gitlab', 'bitbucket', 'azure_devops', 'other']),
    eventName: shortTextSchema,
    deliveryId: z.string().max(128),
  }),
);

/** Qualquer evento do protocolo, discriminado por `type`. */
export const realtimeEventSchema = z.discriminatedUnion('type', [
  presenceChangedEventSchema,
  deviceChangedEventSchema,
  memberJoinedEventSchema,
  agentStartedEventSchema,
  agentUpdatedEventSchema,
  agentStoppedEventSchema,
  taskCreatedEventSchema,
  taskUpdatedEventSchema,
  taskClaimedEventSchema,
  taskReleasedEventSchema,
  messageCreatedEventSchema,
  messageUpdatedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  knowledgeProposedEventSchema,
  knowledgeReviewedEventSchema,
  scopeReservedEventSchema,
  scopeConflictEventSchema,
  gitWebhookProcessedEventSchema,
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

// ---------------------------------------------------------------------------
// Handshake e mensagens de controle
// ---------------------------------------------------------------------------

/** Assinatura de um canal: organização inteira ou um projeto específico. */
export const realtimeSubscriptionSchema = z.object({
  organizationId: ulidSchema,
  projectId: ulidSchema.nullable(),
  /** Vazio significa "todos os tipos". */
  eventTypes: z.array(realtimeEventTypeSchema).max(REALTIME_EVENT_TYPES.length),
});

export type RealtimeSubscription = z.infer<typeof realtimeSubscriptionSchema>;

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.int().positive(),
  deviceId: ulidSchema.nullable(),
  clientVersion: z.string().max(64).nullable(),
  subscriptions: z.array(realtimeSubscriptionSchema).min(1).max(50),
  /** Último cursor recebido; o servidor retoma a partir dele. */
  cursor: cursorSchema.nullable(),
});

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  subscriptions: z.array(realtimeSubscriptionSchema).min(1).max(50),
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  subscriptions: z.array(realtimeSubscriptionSchema).min(1).max(50),
});

export const pingMessageSchema = z.object({
  type: z.literal('ping'),
  sentAt: isoDateTimeSchema,
});

/** Confirma o processamento até um cursor, para o servidor liberar buffer. */
export const ackMessageSchema = z.object({
  type: z.literal('ack'),
  cursor: cursorSchema,
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  pingMessageSchema,
  ackMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const welcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.int().positive(),
  sessionId: ulidSchema,
  serverTime: isoDateTimeSchema,
  heartbeatIntervalMs: z.int().positive(),
  /** Cursor a partir do qual a sessão está entregando. */
  resumeCursor: cursorSchema.nullable(),
  /**
   * `true` quando a janela de retomada expirou: o cliente precisa recarregar o
   * estado por REST antes de confiar nos eventos seguintes.
   */
  resumeGap: z.boolean(),
  subscriptions: z.array(realtimeSubscriptionSchema),
});

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
  sentAt: isoDateTimeSchema,
  serverTime: isoDateTimeSchema,
});

export const realtimeErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.enum([
    'PROTOCOL_VERSION_UNSUPPORTED',
    'TOKEN_INVALID',
    'TOKEN_EXPIRED',
    'SUBSCRIPTION_DENIED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'BACKPRESSURE',
    'INTERNAL_ERROR',
  ]),
  message: z.string().max(1024),
  /** `true` quando reconectar resolve. */
  retryable: z.boolean(),
});

export const eventMessageSchema = z.object({
  type: z.literal('event'),
  event: realtimeEventSchema,
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  welcomeMessageSchema,
  eventMessageSchema,
  pongMessageSchema,
  realtimeErrorMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
