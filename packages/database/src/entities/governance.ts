// Governança: auditoria, eventos de segurança, exportação e exclusão.
//
// `audit_logs` e `security_events` são append-oriented (`Docs/09`): não têm
// `updated_at` nem `version` porque nada os altera depois de escritos. Corrigir
// um registro de auditoria é escrever outro, nunca sobrescrever.

import { EntitySchema } from 'typeorm';

import {
  createdAt,
  enumColumn,
  jsonColumn,
  nullableUnsignedBigint,
  organizationId,
  primaryId,
  requiredText,
  requiredUlidColumn,
  requiredUtcDatetime,
  text,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
  type TimestampFields,
} from './columns.js';

export const actorType = ['user', 'agent', 'device', 'system'] as const;
export type ActorType = (typeof actorType)[number];
export const auditResult = ['success', 'denied', 'failure'] as const;
export type AuditResult = (typeof auditResult)[number];

export interface AuditLog {
  id: string;
  organizationId: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  result: AuditResult;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export const auditLogs = new EntitySchema<AuditLog>({
  name: 'audit_logs',
  tableName: 'audit_logs',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    actorType: enumColumn('actor_type', actorType),
    // Referência polimórfica (usuário, dispositivo, execução de agente). Sem
    // FK: o registro precisa sobreviver à exclusão do ator.
    actorId: ulidColumn('actor_id'),
    actorLabel: text('actor_label', 191),
    action: requiredText('action', 128),
    resourceType: requiredText('resource_type', 64),
    resourceId: text('resource_id', 191),
    projectId: ulidColumn('project_id'),
    result: enumColumn('result', auditResult, { default: 'success' }),
    reason: text('reason', 512),
    requestId: text('request_id', 64),
    ip: text('ip', 45),
    userAgent: text('user_agent', 512),
    // Detalhes já redigidos: nada de segredo, token ou conteúdo de arquivo.
    metadata: jsonColumn('metadata'),
    createdAt: createdAt(),
  },
  indices: [
    // Índice pedido pelo `Docs/07` para a consulta de auditoria.
    {
      name: 'idx_audit_logs_org_actor_created_at',
      columns: ['organizationId', 'actorId', 'createdAt'],
    },
    { name: 'idx_audit_logs_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_audit_logs_resource', columns: ['resourceType', 'resourceId', 'createdAt'] },
    {
      name: 'idx_audit_logs_org_action_created_at',
      columns: ['organizationId', 'action', 'createdAt'],
    },
  ],
});

export const securitySeverity = ['low', 'medium', 'high', 'critical'] as const;
export type SecuritySeverity = (typeof securitySeverity)[number];

export interface SecurityEvent {
  id: string;
  organizationId: string | null;
  userId: string | null;
  type: string;
  severity: SecuritySeverity;
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
  occurredAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
}

export const securityEvents = new EntitySchema<SecurityEvent>({
  name: 'security_events',
  tableName: 'security_events',
  columns: {
    id: primaryId(),
    // Nulo em eventos anteriores à identificação do tenant (login falho, por
    // exemplo). Por isso não usa o helper `organizationId()`.
    organizationId: ulidColumn('organization_id'),
    userId: ulidColumn('user_id'),
    // `login_failed`, `refresh_token_reuse`, `permission_denied`, `bypass_used`…
    type: requiredText('type', 96),
    severity: enumColumn('severity', securitySeverity, { default: 'low' }),
    ip: text('ip', 45),
    userAgent: text('user_agent', 512),
    details: jsonColumn('details'),
    occurredAt: requiredUtcDatetime('occurred_at'),
    resolvedAt: utcDatetime('resolved_at'),
    resolvedByUserId: ulidColumn('resolved_by_user_id'),
    createdAt: createdAt(),
  },
  indices: [
    { name: 'idx_security_events_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_security_events_type_created_at', columns: ['type', 'createdAt'] },
    { name: 'idx_security_events_user_created_at', columns: ['userId', 'createdAt'] },
  ],
});

export const jobStatus = [
  'pending',
  'scheduled',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof jobStatus)[number];
export const exportScope = ['organization', 'project', 'conversation', 'user'] as const;
export type ExportScope = (typeof exportScope)[number];
export const exportFormat = ['json', 'zip'] as const;
export type ExportFormat = (typeof exportFormat)[number];

export interface DataExportJob extends TimestampFields {
  id: string;
  organizationId: string;
  requestedByUserId: string | null;
  scope: ExportScope;
  scopeId: string | null;
  format: ExportFormat;
  status: JobStatus;
  storageKey: string | null;
  sizeBytes: number | null;
  downloadExpiresAt: Date | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  version: number;
}

export const dataExportJobs = new EntitySchema<DataExportJob>({
  name: 'data_export_jobs',
  tableName: 'data_export_jobs',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    requestedByUserId: ulidColumn('requested_by_user_id'),
    scope: enumColumn('scope', exportScope),
    scopeId: ulidColumn('scope_id'),
    format: enumColumn('format', exportFormat, { default: 'json' }),
    status: enumColumn('status', jobStatus, { default: 'pending' }),
    storageKey: text('storage_key', 512),
    sizeBytes: nullableUnsignedBigint('size_bytes'),
    // O link de download expira; o pacote exportado não fica disponível para
    // sempre (`Docs/09`, privacidade).
    downloadExpiresAt: utcDatetime('download_expires_at'),
    errorMessage: { type: 'text', name: 'error_message', nullable: true },
    startedAt: utcDatetime('started_at'),
    completedAt: utcDatetime('completed_at'),
    ...timestamps(),
    version: version(),
  },
  indices: [
    { name: 'idx_data_export_jobs_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_data_export_jobs_status', columns: ['status', 'createdAt'] },
  ],
});

export const deletionTarget = [
  'organization',
  'project',
  'conversation',
  'user',
  'knowledge_item',
] as const;
export type DeletionTarget = (typeof deletionTarget)[number];

export interface DeletionJob extends TimestampFields {
  id: string;
  organizationId: string;
  requestedByUserId: string | null;
  targetType: DeletionTarget;
  targetId: string;
  status: JobStatus;
  scheduledFor: Date;
  reason: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  version: number;
}

export const deletionJobs = new EntitySchema<DeletionJob>({
  name: 'deletion_jobs',
  tableName: 'deletion_jobs',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    requestedByUserId: ulidColumn('requested_by_user_id'),
    targetType: enumColumn('target_type', deletionTarget),
    targetId: requiredUlidColumn('target_id'),
    status: enumColumn('status', jobStatus, { default: 'pending' }),
    // Quando o apagamento definitivo acontece — é a janela de recuperação que
    // justifica o `deleted_at` das tabelas correspondentes.
    scheduledFor: requiredUtcDatetime('scheduled_for'),
    reason: text('reason', 512),
    errorMessage: { type: 'text', name: 'error_message', nullable: true },
    startedAt: utcDatetime('started_at'),
    completedAt: utcDatetime('completed_at'),
    cancelledAt: utcDatetime('cancelled_at'),
    ...timestamps(),
    version: version(),
  },
  indices: [
    { name: 'idx_deletion_jobs_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_deletion_jobs_status_scheduled', columns: ['status', 'scheduledFor'] },
    { name: 'idx_deletion_jobs_target', columns: ['targetType', 'targetId'] },
  ],
});
