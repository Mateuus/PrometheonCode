/**
 * Leitura do log de auditoria e dos registros de governança.
 *
 * Sobre `audit_logs` e `security_events` só existe `SELECT`: as duas tabelas são
 * append-oriented (`Docs/09`) e a API não oferece caminho para editar nem apagar
 * uma linha — nem para administrador. Um log que o administrador pode corrigir
 * deixa de ser prova de qualquer coisa.
 *
 * `data_export_jobs` e `deletion_jobs` aceitam escrita porque são pedidos, não
 * registro histórico: o worker os processa e atualiza o estado.
 */

import {
  auditLogs,
  dataExportJobs,
  deletionJobs,
  newId,
  securityEvents,
  users,
  type Database,
} from '@prometheon/database';
import { and, desc, eq, gte, isNull, lt, lte, or, type SQL } from 'drizzle-orm';

import { decodeCursor } from '../../shared/cursor.js';

export interface AuditRow {
  id: string;
  organizationId: string;
  actorType: 'user' | 'agent' | 'device' | 'system';
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  actorName: string | null;
  actorEmail: string | null;
  actorAvatarUrl: string | null;
}

export interface AuditFilter {
  readonly organizationId: string;
  readonly actorType?: 'user' | 'agent' | 'device' | 'system' | undefined;
  readonly actorUserId?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly action?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export type SecurityEventRow = typeof securityEvents.$inferSelect;

export interface SecurityEventFilter {
  readonly organizationId: string;
  readonly type?: string | undefined;
  readonly severity?: 'low' | 'medium' | 'high' | 'critical' | undefined;
  readonly userId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly unresolved?: boolean | undefined;
}

/**
 * Colunas dos pedidos de exportação.
 *
 * `storage_key` não sai daqui: ele é o caminho do pacote no armazenamento, e
 * devolvê-lo transformaria a listagem em um mapa do disco do servidor. O link
 * de download é assinado à parte, quando existir.
 */
const exportColumns = {
  id: dataExportJobs.id,
  organizationId: dataExportJobs.organizationId,
  requestedByUserId: dataExportJobs.requestedByUserId,
  scope: dataExportJobs.scope,
  scopeId: dataExportJobs.scopeId,
  format: dataExportJobs.format,
  status: dataExportJobs.status,
  sizeBytes: dataExportJobs.sizeBytes,
  downloadExpiresAt: dataExportJobs.downloadExpiresAt,
  errorMessage: dataExportJobs.errorMessage,
  completedAt: dataExportJobs.completedAt,
  createdAt: dataExportJobs.createdAt,
  requesterName: users.displayName,
  requesterEmail: users.email,
  requesterAvatarUrl: users.avatarUrl,
} as const;

const deletionColumns = {
  id: deletionJobs.id,
  organizationId: deletionJobs.organizationId,
  requestedByUserId: deletionJobs.requestedByUserId,
  targetType: deletionJobs.targetType,
  targetId: deletionJobs.targetId,
  status: deletionJobs.status,
  scheduledFor: deletionJobs.scheduledFor,
  reason: deletionJobs.reason,
  errorMessage: deletionJobs.errorMessage,
  completedAt: deletionJobs.completedAt,
  cancelledAt: deletionJobs.cancelledAt,
  createdAt: deletionJobs.createdAt,
  requesterName: users.displayName,
  requesterEmail: users.email,
  requesterAvatarUrl: users.avatarUrl,
} as const;

export interface ExportJobRow {
  id: string;
  organizationId: string;
  requestedByUserId: string | null;
  scope: 'organization' | 'project' | 'conversation' | 'user';
  scopeId: string | null;
  format: 'json' | 'zip';
  status: 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  sizeBytes: number | null;
  downloadExpiresAt: Date | null;
  errorMessage: string | null;
  completedAt: Date | null;
  createdAt: Date;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterAvatarUrl: string | null;
}

export interface DeletionJobRow {
  id: string;
  organizationId: string;
  requestedByUserId: string | null;
  targetType: 'organization' | 'project' | 'conversation' | 'user' | 'knowledge_item';
  targetId: string;
  status: 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  scheduledFor: Date;
  reason: string | null;
  errorMessage: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterAvatarUrl: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async list(
    filter: AuditFilter,
    limit: number,
    cursor: string | undefined,
  ): Promise<AuditRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const conditions: (SQL | undefined)[] = [
      eq(auditLogs.organizationId, filter.organizationId),
    ];

    if (filter.actorType !== undefined) {
      conditions.push(eq(auditLogs.actorType, filter.actorType));
    }

    if (filter.actorUserId !== undefined) {
      conditions.push(eq(auditLogs.actorId, filter.actorUserId));
    }

    if (filter.resourceType !== undefined) {
      conditions.push(eq(auditLogs.resourceType, filter.resourceType));
    }

    if (filter.resourceId !== undefined) {
      conditions.push(eq(auditLogs.resourceId, filter.resourceId));
    }

    if (filter.projectId !== undefined) {
      conditions.push(eq(auditLogs.projectId, filter.projectId));
    }

    if (filter.action !== undefined) {
      conditions.push(eq(auditLogs.action, filter.action));
    }

    if (filter.from !== undefined) {
      conditions.push(gte(auditLogs.createdAt, new Date(filter.from)));
    }

    if (filter.to !== undefined) {
      conditions.push(lte(auditLogs.createdAt, new Date(filter.to)));
    }

    if (after !== undefined) {
      const at = new Date(after.at);

      conditions.push(
        or(lt(auditLogs.createdAt, at), and(eq(auditLogs.createdAt, at), lt(auditLogs.id, after.id))),
      );
    }

    const rows = await this.db
      .select({
        id: auditLogs.id,
        organizationId: auditLogs.organizationId,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        projectId: auditLogs.projectId,
        ip: auditLogs.ip,
        userAgent: auditLogs.userAgent,
        requestId: auditLogs.requestId,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
        actorName: users.displayName,
        actorEmail: users.email,
        actorAvatarUrl: users.avatarUrl,
      })
      .from(auditLogs)
      // `leftJoin`: o ator pode ter sido excluído, e a linha de auditoria
      // precisa sobreviver a isso (`Docs/07`).
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    return rows;
  }

  // -------------------------------------------------------------------------
  // Eventos de segurança
  // -------------------------------------------------------------------------

  async listSecurityEvents(
    filter: SecurityEventFilter,
    limit: number,
    cursor: string | undefined,
  ): Promise<SecurityEventRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const conditions: (SQL | undefined)[] = [
      eq(securityEvents.organizationId, filter.organizationId),
    ];

    if (filter.type !== undefined) {
      conditions.push(eq(securityEvents.type, filter.type));
    }

    if (filter.severity !== undefined) {
      conditions.push(eq(securityEvents.severity, filter.severity));
    }

    if (filter.userId !== undefined) {
      conditions.push(eq(securityEvents.userId, filter.userId));
    }

    if (filter.from !== undefined) {
      conditions.push(gte(securityEvents.createdAt, new Date(filter.from)));
    }

    if (filter.to !== undefined) {
      conditions.push(lte(securityEvents.createdAt, new Date(filter.to)));
    }

    if (filter.unresolved === true) {
      conditions.push(isNull(securityEvents.resolvedAt));
    }

    if (after !== undefined) {
      const at = new Date(after.at);

      conditions.push(
        or(
          lt(securityEvents.createdAt, at),
          and(eq(securityEvents.createdAt, at), lt(securityEvents.id, after.id)),
        ),
      );
    }

    return this.db
      .select()
      .from(securityEvents)
      .where(and(...conditions))
      .orderBy(desc(securityEvents.createdAt), desc(securityEvents.id))
      .limit(limit + 1);
  }

  // -------------------------------------------------------------------------
  // Exportação
  // -------------------------------------------------------------------------

  async createExportJob(input: {
    organizationId: string;
    requestedByUserId: string;
    scope: 'organization' | 'project' | 'conversation' | 'user';
    scopeId: string | null;
    format: 'json' | 'zip';
  }): Promise<string> {
    const id = newId();

    await this.db.insert(dataExportJobs).values({
      id,
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      scope: input.scope,
      scopeId: input.scopeId,
      format: input.format,
      status: 'pending',
    });

    return id;
  }

  async listExportJobs(
    organizationId: string,
    status: string | undefined,
    limit: number,
    cursor: string | undefined,
  ): Promise<ExportJobRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const conditions: (SQL | undefined)[] = [eq(dataExportJobs.organizationId, organizationId)];

    if (status !== undefined) {
      conditions.push(
        eq(dataExportJobs.status, status as typeof dataExportJobs.$inferSelect.status),
      );
    }

    if (after !== undefined) {
      const at = new Date(after.at);

      conditions.push(
        or(
          lt(dataExportJobs.createdAt, at),
          and(eq(dataExportJobs.createdAt, at), lt(dataExportJobs.id, after.id)),
        ),
      );
    }

    return this.db
      .select(exportColumns)
      .from(dataExportJobs)
      .leftJoin(users, eq(users.id, dataExportJobs.requestedByUserId))
      .where(and(...conditions))
      .orderBy(desc(dataExportJobs.createdAt), desc(dataExportJobs.id))
      .limit(limit + 1);
  }

  async findExportJob(
    organizationId: string,
    exportJobId: string,
  ): Promise<ExportJobRow | undefined> {
    const [row] = await this.db
      .select(exportColumns)
      .from(dataExportJobs)
      .leftJoin(users, eq(users.id, dataExportJobs.requestedByUserId))
      .where(
        and(
          eq(dataExportJobs.id, exportJobId),
          eq(dataExportJobs.organizationId, organizationId),
        ),
      )
      .limit(1);

    return row;
  }

  // -------------------------------------------------------------------------
  // Exclusão
  // -------------------------------------------------------------------------

  async createDeletionJob(input: {
    organizationId: string;
    requestedByUserId: string;
    targetType: 'organization' | 'project' | 'conversation' | 'user' | 'knowledge_item';
    targetId: string;
    scheduledFor: Date;
    reason: string | null;
  }): Promise<string> {
    const id = newId();

    await this.db.insert(deletionJobs).values({
      id,
      organizationId: input.organizationId,
      requestedByUserId: input.requestedByUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      status: 'scheduled',
      scheduledFor: input.scheduledFor,
      reason: input.reason,
    });

    return id;
  }

  async listDeletionJobs(
    organizationId: string,
    status: string | undefined,
    limit: number,
    cursor: string | undefined,
  ): Promise<DeletionJobRow[]> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const conditions: (SQL | undefined)[] = [eq(deletionJobs.organizationId, organizationId)];

    if (status !== undefined) {
      conditions.push(eq(deletionJobs.status, status as typeof deletionJobs.$inferSelect.status));
    }

    if (after !== undefined) {
      const at = new Date(after.at);

      conditions.push(
        or(
          lt(deletionJobs.createdAt, at),
          and(eq(deletionJobs.createdAt, at), lt(deletionJobs.id, after.id)),
        ),
      );
    }

    return this.db
      .select(deletionColumns)
      .from(deletionJobs)
      .leftJoin(users, eq(users.id, deletionJobs.requestedByUserId))
      .where(and(...conditions))
      .orderBy(desc(deletionJobs.createdAt), desc(deletionJobs.id))
      .limit(limit + 1);
  }

  async findDeletionJob(
    organizationId: string,
    deletionJobId: string,
  ): Promise<DeletionJobRow | undefined> {
    const [row] = await this.db
      .select(deletionColumns)
      .from(deletionJobs)
      .leftJoin(users, eq(users.id, deletionJobs.requestedByUserId))
      .where(
        and(eq(deletionJobs.id, deletionJobId), eq(deletionJobs.organizationId, organizationId)),
      )
      .limit(1);

    return row;
  }
}
