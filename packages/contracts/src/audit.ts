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

export const SECURITY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export const securitySeveritySchema = z.enum(SECURITY_SEVERITIES);

/**
 * Evento de segurança: falha de login, reuso de refresh token, permissão negada.
 *
 * `type` é texto livre, não enum: a coluna é `varchar` justamente para que um
 * tipo novo não exija migração, e um enum fechado aqui derrubaria a listagem
 * assim que outra parte do sistema gravasse algo que este contrato não conhece.
 */
export const securityEventSchema = z.object({
  id: ulidSchema,
  /** Nulo em evento anterior à identificação do tenant (login falho). */
  organizationId: ulidSchema.nullable(),
  userId: ulidSchema.nullable(),
  type: shortTextSchema,
  severity: securitySeveritySchema,
  ipAddress: z.string().max(45).nullable(),
  userAgent: z.string().max(512).nullable(),
  /** Contexto já redigido; nunca token, senha ou credencial. */
  details: metadataSchema.nullable(),
  occurredAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
});

export type SecurityEvent = z.infer<typeof securityEventSchema>;

export const securityEventListQuerySchema = cursorPageQuerySchema.extend({
  type: shortTextSchema.optional(),
  severity: securitySeveritySchema.optional(),
  userId: ulidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  /** `true` traz só o que ainda não foi tratado. */
  unresolved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional(),
});

export const securityEventPageSchema = cursorPageSchema(securityEventSchema);

/** Estados de `data_export_jobs` e `deletion_jobs`. */
export const DATA_JOB_STATUSES = [
  'pending',
  'scheduled',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export const dataJobStatusSchema = z.enum(DATA_JOB_STATUSES);

export type DataJobStatus = z.infer<typeof dataJobStatusSchema>;

export const EXPORT_SCOPES = [
  'organization',
  'project',
  'conversation',
  'user',
] as const;

export const exportScopeSchema = z.enum(EXPORT_SCOPES);

export const EXPORT_FORMATS = ['json', 'zip'] as const;

export const exportFormatSchema = z.enum(EXPORT_FORMATS);

/** Pedido de exportação de dados (`Docs/09`, privacidade). */
export const dataExportJobSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  scope: exportScopeSchema,
  scopeId: ulidSchema.nullable(),
  format: exportFormatSchema,
  status: dataJobStatusSchema,
  requestedBy: publicUserSchema.nullable(),
  requestedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  /** Só depois de concluído, e por tempo limitado. */
  downloadExpiresAt: isoDateTimeSchema.nullable(),
  errorMessage: z.string().max(2_000).nullable(),
});

export type DataExportJob = z.infer<typeof dataExportJobSchema>;

export const createDataExportRequestSchema = z.object({
  scope: exportScopeSchema.default('organization'),
  /** Obrigatório quando o escopo não é a organização inteira. */
  scopeId: ulidSchema.optional(),
  format: exportFormatSchema.default('json'),
});

export const DELETION_TARGETS = [
  'organization',
  'project',
  'conversation',
  'user',
  'knowledge_item',
] as const;

export const deletionTargetSchema = z.enum(DELETION_TARGETS);

/** Pedido de exclusão de dados (`Docs/09`, privacidade). */
export const deletionJobSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  targetType: deletionTargetSchema,
  targetId: ulidSchema,
  status: dataJobStatusSchema,
  /** Quando o apagamento definitivo acontece: a janela de arrependimento. */
  scheduledFor: isoDateTimeSchema,
  reason: z.string().max(512).nullable(),
  requestedBy: publicUserSchema.nullable(),
  requestedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
  errorMessage: z.string().max(2_000).nullable(),
});

export type DeletionJob = z.infer<typeof deletionJobSchema>;

export const createDeletionRequestSchema = z.object({
  targetType: deletionTargetSchema,
  targetId: ulidSchema,
  reason: z.string().trim().max(512).optional(),
  /** Dias de espera antes do apagamento. O padrão é a janela de recuperação. */
  graceDays: z.int().min(0).max(90).optional(),
});

export const dataJobListQuerySchema = cursorPageQuerySchema.extend({
  status: dataJobStatusSchema.optional(),
});

export const dataExportPageSchema = cursorPageSchema(dataExportJobSchema);
export const deletionJobPageSchema = cursorPageSchema(deletionJobSchema);
