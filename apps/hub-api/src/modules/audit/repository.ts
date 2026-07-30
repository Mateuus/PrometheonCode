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
  type DataExportJob as DataExportJobEntity,
  type DeletionJob as DeletionJobEntity,
  type SecurityEvent as SecurityEventEntity,
} from '@prometheon/database';
import type { SelectQueryBuilder } from 'typeorm';

import { decodeCursor } from '../../shared/cursor.js';
import { applyKeyset } from '../../shared/query.js';

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

export type SecurityEventRow = SecurityEventEntity;

export interface SecurityEventFilter {
  readonly organizationId: string;
  readonly type?: string | undefined;
  readonly severity?: 'low' | 'medium' | 'high' | 'critical' | undefined;
  readonly userId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly unresolved?: boolean | undefined;
}

/** Colunas da auditoria, com o alias que o contrato espera. */
const AUDIT_COLUMNS: readonly (readonly [string, string])[] = [
  ['log.id', 'id'],
  ['log.organizationId', 'organizationId'],
  ['log.actorType', 'actorType'],
  ['log.actorId', 'actorId'],
  ['log.action', 'action'],
  ['log.resourceType', 'resourceType'],
  ['log.resourceId', 'resourceId'],
  ['log.projectId', 'projectId'],
  ['log.ip', 'ip'],
  ['log.userAgent', 'userAgent'],
  ['log.requestId', 'requestId'],
  ['log.metadata', 'metadata'],
  ['log.createdAt', 'createdAt'],
  ['actor.displayName', 'actorName'],
  ['actor.email', 'actorEmail'],
  ['actor.avatarUrl', 'actorAvatarUrl'],
];

/**
 * Colunas dos pedidos de exportação.
 *
 * `storage_key` não sai daqui: ele é o caminho do pacote no armazenamento, e
 * devolvê-lo transformaria a listagem em um mapa do disco do servidor. O link
 * de download é assinado à parte, quando existir.
 */
const EXPORT_COLUMNS: readonly (readonly [string, string])[] = [
  ['job.id', 'id'],
  ['job.organizationId', 'organizationId'],
  ['job.requestedByUserId', 'requestedByUserId'],
  ['job.scope', 'scope'],
  ['job.scopeId', 'scopeId'],
  ['job.format', 'format'],
  ['job.status', 'status'],
  ['job.sizeBytes', 'sizeBytes'],
  ['job.downloadExpiresAt', 'downloadExpiresAt'],
  ['job.errorMessage', 'errorMessage'],
  ['job.completedAt', 'completedAt'],
  ['job.createdAt', 'createdAt'],
  ['requester.displayName', 'requesterName'],
  ['requester.email', 'requesterEmail'],
  ['requester.avatarUrl', 'requesterAvatarUrl'],
];

const DELETION_COLUMNS: readonly (readonly [string, string])[] = [
  ['job.id', 'id'],
  ['job.organizationId', 'organizationId'],
  ['job.requestedByUserId', 'requestedByUserId'],
  ['job.targetType', 'targetType'],
  ['job.targetId', 'targetId'],
  ['job.status', 'status'],
  ['job.scheduledFor', 'scheduledFor'],
  ['job.reason', 'reason'],
  ['job.errorMessage', 'errorMessage'],
  ['job.completedAt', 'completedAt'],
  ['job.cancelledAt', 'cancelledAt'],
  ['job.createdAt', 'createdAt'],
  ['requester.displayName', 'requesterName'],
  ['requester.email', 'requesterEmail'],
  ['requester.avatarUrl', 'requesterAvatarUrl'],
];

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

/**
 * A linha de exportação como o driver a entrega.
 *
 * `size_bytes` é `bigint`, e a leitura é crua — colunas de duas tabelas. Consulta
 * crua não passa pelo conversor declarado na coluna, que é quem garante número
 * em vez de texto, então o tipo admite os dois até a normalização.
 */
type RawExportJobRow = Omit<ExportJobRow, 'sizeBytes'> & { sizeBytes: number | string | null };

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
    const query = this.db.manager
      .createQueryBuilder(auditLogs, 'log')
      .select([])
      // `leftJoin`: o ator pode ter sido excluído, e a linha de auditoria
      // precisa sobreviver a isso (`Docs/07`).
      .leftJoin(users.options.name, 'actor', 'actor.id = log.actorId')
      .where('log.organizationId = :organizationId', { organizationId: filter.organizationId });

    if (filter.actorType !== undefined) {
      query.andWhere('log.actorType = :actorType', { actorType: filter.actorType });
    }

    if (filter.actorUserId !== undefined) {
      query.andWhere('log.actorId = :actorUserId', { actorUserId: filter.actorUserId });
    }

    if (filter.resourceType !== undefined) {
      query.andWhere('log.resourceType = :resourceType', { resourceType: filter.resourceType });
    }

    if (filter.resourceId !== undefined) {
      query.andWhere('log.resourceId = :resourceId', { resourceId: filter.resourceId });
    }

    if (filter.projectId !== undefined) {
      query.andWhere('log.projectId = :projectId', { projectId: filter.projectId });
    }

    if (filter.action !== undefined) {
      query.andWhere('log.action = :action', { action: filter.action });
    }

    if (filter.from !== undefined) {
      query.andWhere('log.createdAt >= :from', { from: new Date(filter.from) });
    }

    if (filter.to !== undefined) {
      query.andWhere('log.createdAt <= :to', { to: new Date(filter.to) });
    }

    applyKeyset(query, 'log', { createdAt: 'createdAt', id: 'id' }, after);

    for (const [column, alias] of AUDIT_COLUMNS) {
      query.addSelect(column, alias);
    }

    return query
      .orderBy('log.createdAt', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<AuditRow>();
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
    const query = this.db.manager
      .createQueryBuilder(securityEvents, 'event')
      .where('event.organizationId = :organizationId', {
        organizationId: filter.organizationId,
      });

    if (filter.type !== undefined) {
      query.andWhere('event.type = :type', { type: filter.type });
    }

    if (filter.severity !== undefined) {
      query.andWhere('event.severity = :severity', { severity: filter.severity });
    }

    if (filter.userId !== undefined) {
      query.andWhere('event.userId = :userId', { userId: filter.userId });
    }

    if (filter.from !== undefined) {
      query.andWhere('event.createdAt >= :from', { from: new Date(filter.from) });
    }

    if (filter.to !== undefined) {
      query.andWhere('event.createdAt <= :to', { to: new Date(filter.to) });
    }

    if (filter.unresolved === true) {
      query.andWhere('event.resolvedAt IS NULL');
    }

    applyKeyset(query, 'event', { createdAt: 'createdAt', id: 'id' }, after);

    return query
      .orderBy('event.createdAt', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .limit(limit + 1)
      .getMany();
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

    await this.db.manager.insert(dataExportJobs, {
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
    const query = this.exportQuery().where('job.organizationId = :organizationId', {
      organizationId,
    });

    if (status !== undefined) {
      query.andWhere('job.status = :status', { status });
    }

    applyKeyset(query, 'job', { createdAt: 'createdAt', id: 'id' }, after);

    const rows = await query
      .orderBy('job.createdAt', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<RawExportJobRow>();

    return rows.map(normalizeExportRow);
  }

  async findExportJob(
    organizationId: string,
    exportJobId: string,
  ): Promise<ExportJobRow | undefined> {
    const rows = await this.exportQuery()
      .where('job.id = :exportJobId', { exportJobId })
      .andWhere('job.organizationId = :organizationId', { organizationId })
      .limit(1)
      .getRawMany<RawExportJobRow>();

    const row = rows[0];

    return row === undefined ? undefined : normalizeExportRow(row);
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

    await this.db.manager.insert(deletionJobs, {
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
    const query = this.deletionQuery().where('job.organizationId = :organizationId', {
      organizationId,
    });

    if (status !== undefined) {
      query.andWhere('job.status = :status', { status });
    }

    applyKeyset(query, 'job', { createdAt: 'createdAt', id: 'id' }, after);

    return query
      .orderBy('job.createdAt', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .limit(limit + 1)
      .getRawMany<DeletionJobRow>();
  }

  async findDeletionJob(
    organizationId: string,
    deletionJobId: string,
  ): Promise<DeletionJobRow | undefined> {
    const rows = await this.deletionQuery()
      .where('job.id = :deletionJobId', { deletionJobId })
      .andWhere('job.organizationId = :organizationId', { organizationId })
      .limit(1)
      .getRawMany<DeletionJobRow>();

    return rows[0];
  }

  /** Base das leituras de exportação: pedido + quem pediu. */
  private exportQuery(): SelectQueryBuilder<DataExportJobEntity> {
    return withColumns(
      this.db.manager
        .createQueryBuilder(dataExportJobs, 'job')
        .select([])
        .leftJoin(users.options.name, 'requester', 'requester.id = job.requestedByUserId'),
      EXPORT_COLUMNS,
    );
  }

  /** Base das leituras de exclusão: pedido + quem pediu. */
  private deletionQuery(): SelectQueryBuilder<DeletionJobEntity> {
    return withColumns(
      this.db.manager
        .createQueryBuilder(deletionJobs, 'job')
        .select([])
        .leftJoin(users.options.name, 'requester', 'requester.id = job.requestedByUserId'),
      DELETION_COLUMNS,
    );
  }
}

/** Acrescenta a lista de colunas com os alias que o contrato espera. */
function withColumns<T extends object>(
  query: SelectQueryBuilder<T>,
  columns: readonly (readonly [string, string])[],
): SelectQueryBuilder<T> {
  for (const [column, alias] of columns) {
    query.addSelect(column, alias);
  }

  return query;
}

/** Converte `size_bytes` para número, que é o que o contrato promete. */
function normalizeExportRow(row: RawExportJobRow): ExportJobRow {
  return {
    ...row,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  };
}
