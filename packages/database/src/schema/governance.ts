// Governança: auditoria, eventos de segurança, exportação e exclusão.
//
// `audit_logs` e `security_events` são append-oriented (`Docs/09`): não têm
// `updated_at` nem `version` porque nada os altera depois de escritos. Corrigir
// um registro de auditoria é escrever outro, nunca sobrescrever.

import {
  bigint,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';

import { organizations } from './organization.js';
import { users } from './identity.js';
import {
  createdAt,
  organizationId,
  primaryId,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
} from './columns.js';

export const actorType = ['user', 'agent', 'device', 'system'] as const;
export const auditResult = ['success', 'denied', 'failure'] as const;

export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    actorType: mysqlEnum('actor_type', actorType).notNull(),
    // Referência polimórfica (usuário, dispositivo, execução de agente). Sem
    // FK: o registro precisa sobreviver à exclusão do ator.
    actorId: ulidColumn('actor_id'),
    actorLabel: varchar('actor_label', { length: 191 }),
    action: varchar('action', { length: 128 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }).notNull(),
    resourceId: varchar('resource_id', { length: 191 }),
    projectId: ulidColumn('project_id'),
    result: mysqlEnum('result', auditResult).notNull().default('success'),
    reason: varchar('reason', { length: 512 }),
    requestId: varchar('request_id', { length: 64 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),
    // Detalhes já redigidos: nada de segredo, token ou conteúdo de arquivo.
    metadata: json('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    // Índice pedido pelo `Docs/07` para a consulta de auditoria.
    index('idx_audit_logs_org_actor_created_at').on(
      table.organizationId,
      table.actorId,
      table.createdAt,
    ),
    index('idx_audit_logs_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_audit_logs_resource').on(table.resourceType, table.resourceId, table.createdAt),
    index('idx_audit_logs_org_action_created_at').on(
      table.organizationId,
      table.action,
      table.createdAt,
    ),
  ],
);

export const securitySeverity = ['low', 'medium', 'high', 'critical'] as const;

export const securityEvents = mysqlTable(
  'security_events',
  {
    id: primaryId(),
    // Nulo em eventos anteriores à identificação do tenant (login falho, por
    // exemplo). Por isso não usa o helper `organizationId()`.
    organizationId: ulidColumn('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    userId: ulidColumn('user_id').references(() => users.id, { onDelete: 'set null' }),
    // `login_failed`, `refresh_token_reuse`, `permission_denied`, `bypass_used`…
    type: varchar('type', { length: 96 }).notNull(),
    severity: mysqlEnum('severity', securitySeverity).notNull().default('low'),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),
    details: json('details').$type<Record<string, unknown>>(),
    occurredAt: utcDatetime('occurred_at').notNull(),
    resolvedAt: utcDatetime('resolved_at'),
    resolvedByUserId: ulidColumn('resolved_by_user_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_security_events_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_security_events_type_created_at').on(table.type, table.createdAt),
    index('idx_security_events_user_created_at').on(table.userId, table.createdAt),
  ],
);

export const jobStatus = [
  'pending',
  'scheduled',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export const exportScope = ['organization', 'project', 'conversation', 'user'] as const;
export const exportFormat = ['json', 'zip'] as const;

export const dataExportJobs = mysqlTable(
  'data_export_jobs',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    requestedByUserId: ulidColumn('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    scope: mysqlEnum('scope', exportScope).notNull(),
    scopeId: ulidColumn('scope_id'),
    format: mysqlEnum('format', exportFormat).notNull().default('json'),
    status: mysqlEnum('status', jobStatus).notNull().default('pending'),
    storageKey: varchar('storage_key', { length: 512 }),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true }),
    // O link de download expira; o pacote exportado não fica disponível para
    // sempre (`Docs/09`, privacidade).
    downloadExpiresAt: utcDatetime('download_expires_at'),
    errorMessage: text('error_message'),
    startedAt: utcDatetime('started_at'),
    completedAt: utcDatetime('completed_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    index('idx_data_export_jobs_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_data_export_jobs_status').on(table.status, table.createdAt),
  ],
);

export const deletionTarget = [
  'organization',
  'project',
  'conversation',
  'user',
  'knowledge_item',
] as const;

export const deletionJobs = mysqlTable(
  'deletion_jobs',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    requestedByUserId: ulidColumn('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    targetType: mysqlEnum('target_type', deletionTarget).notNull(),
    targetId: ulidColumn('target_id').notNull(),
    status: mysqlEnum('status', jobStatus).notNull().default('pending'),
    // Quando o apagamento definitivo acontece — é a janela de recuperação que
    // justifica o `deleted_at` das tabelas correspondentes.
    scheduledFor: utcDatetime('scheduled_for').notNull(),
    reason: varchar('reason', { length: 512 }),
    errorMessage: text('error_message'),
    startedAt: utcDatetime('started_at'),
    completedAt: utcDatetime('completed_at'),
    cancelledAt: utcDatetime('cancelled_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    index('idx_deletion_jobs_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_deletion_jobs_status_scheduled').on(table.status, table.scheduledFor),
    index('idx_deletion_jobs_target').on(table.targetType, table.targetId),
  ],
);
