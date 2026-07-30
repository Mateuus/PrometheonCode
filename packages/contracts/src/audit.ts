/**
 * Auditoria (`Docs/06`, `Docs/07`).
 *
 * O log é append-oriented: registro de auditoria não é editado nem apagado pela
 * API, só consultado por quem tem `audit.read`.
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import {
  isoDateSchema,
  isoDateTimeSchema,
  metadataSchema,
  shortTextSchema,
  ulidSchema,
} from './primitives.js';

export const AUDIT_ACTOR_TYPES = ['user', 'agent', 'system', 'device'] as const;

export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

export const AUDIT_RESOURCE_TYPES = [
  'organization',
  'member',
  'invitation',
  'project',
  'conversation',
  'message',
  'task',
  'agent_run',
  'approval',
  'knowledge',
  'device',
  'git_connection',
  'subscription',
  'session',
] as const;

export const auditResourceTypeSchema = z.enum(AUDIT_RESOURCE_TYPES);

export const auditLogSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  actorType: auditActorTypeSchema,
  actorUser: publicUserSchema.nullable(),
  actorDeviceId: ulidSchema.nullable(),
  /** Verbo no formato `recurso.acao`, por exemplo `project.created`. */
  action: shortTextSchema,
  resourceType: auditResourceTypeSchema,
  resourceId: ulidSchema.nullable(),
  projectId: ulidSchema.nullable(),
  ipAddress: z.string().max(45).nullable(),
  userAgent: z.string().max(512).nullable(),
  requestId: z.string().max(64).nullable(),
  /** Contexto adicional, já sem segredo — a redaction acontece na escrita. */
  metadata: metadataSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export type AuditLog = z.infer<typeof auditLogSchema>;

export const auditListQuerySchema = cursorPageQuerySchema.extend({
  actorType: auditActorTypeSchema.optional(),
  actorUserId: ulidSchema.optional(),
  resourceType: auditResourceTypeSchema.optional(),
  resourceId: ulidSchema.optional(),
  projectId: ulidSchema.optional(),
  action: shortTextSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditPageSchema = cursorPageSchema(auditLogSchema);

/** Evento de segurança: falha de login, token inválido, limite estourado. */
export const securityEventSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema.nullable(),
  kind: z.enum([
    'login_failed',
    'token_rejected',
    'permission_denied',
    'rate_limited',
    'suspicious_payload',
    'device_revoked',
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  ipAddress: z.string().max(45).nullable(),
  detail: shortTextSchema,
  occurredAt: isoDateTimeSchema,
});

export const securityEventPageSchema = cursorPageSchema(securityEventSchema);

/** Pedido de exportação ou de exclusão de dados (`Docs/09`, privacidade). */
export const dataJobSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  kind: z.enum(['export', 'deletion']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  requestedBy: publicUserSchema,
  requestedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  /** Disponível por tempo limitado, apenas para exportação concluída. */
  downloadUrl: z.url().nullable(),
  expiresOn: isoDateSchema.nullable(),
});

export type DataJob = z.infer<typeof dataJobSchema>;
