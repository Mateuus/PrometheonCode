/**
 * Auditoria e governança: consulta e pedidos de exportação e exclusão.
 *
 * A auditoria só é lida. Exportação e exclusão são pedidos que a API grava e o
 * worker executa — a API nunca apaga dados de organização dentro de uma
 * requisição HTTP: isso é trabalho longo, precisa de janela de arrependimento e
 * de registro do que foi feito.
 */

import type {
  DataExportJob,
  DeletionJob,
  SecurityEvent,
} from '@prometheon/contracts';
import type { Database } from '@prometheon/database';

import { buildPage, type CursorPage } from '../../shared/cursor.js';
import { badRequest, internalError } from '../../shared/errors.js';
import { toIso, toIsoOrNull } from '../../shared/time.js';
import type { GovernanceQueues } from './queue.js';
import {
  AuditRepository,
  type DeletionJobRow,
  type ExportJobRow,
  type SecurityEventFilter,
  type SecurityEventRow,
} from './repository.js';

/** Janela de arrependimento padrão antes do apagamento definitivo. */
export const DEFAULT_DELETION_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

function requester(row: {
  requestedByUserId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterAvatarUrl: string | null;
}): DataExportJob['requestedBy'] {
  if (row.requestedByUserId === null || row.requesterName === null || row.requesterEmail === null) {
    return null;
  }

  return {
    id: row.requestedByUserId,
    name: row.requesterName,
    email: row.requesterEmail,
    avatarUrl: row.requesterAvatarUrl,
  };
}

export function toSecurityEventView(row: SecurityEventRow): SecurityEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    type: row.type,
    severity: row.severity,
    ipAddress: row.ip,
    userAgent: row.userAgent,
    details: row.details,
    occurredAt: toIso(row.occurredAt),
    resolvedAt: toIsoOrNull(row.resolvedAt),
  };
}

export function toExportJobView(row: ExportJobRow): DataExportJob {
  return {
    id: row.id,
    organizationId: row.organizationId,
    scope: row.scope,
    scopeId: row.scopeId,
    format: row.format,
    status: row.status,
    requestedBy: requester(row),
    requestedAt: toIso(row.createdAt),
    completedAt: toIsoOrNull(row.completedAt),
    sizeBytes: row.sizeBytes,
    downloadExpiresAt: toIsoOrNull(row.downloadExpiresAt),
    errorMessage: row.errorMessage === null ? null : row.errorMessage.slice(0, 2_000),
  };
}

export function toDeletionJobView(row: DeletionJobRow): DeletionJob {
  return {
    id: row.id,
    organizationId: row.organizationId,
    targetType: row.targetType,
    targetId: row.targetId,
    status: row.status,
    scheduledFor: toIso(row.scheduledFor),
    reason: row.reason,
    requestedBy: requester(row),
    requestedAt: toIso(row.createdAt),
    completedAt: toIsoOrNull(row.completedAt),
    cancelledAt: toIsoOrNull(row.cancelledAt),
    errorMessage: row.errorMessage === null ? null : row.errorMessage.slice(0, 2_000),
  };
}

export interface RequestExportInput {
  readonly organizationId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly scope: 'organization' | 'project' | 'conversation' | 'user';
  readonly scopeId: string | undefined;
  readonly format: 'json' | 'zip';
}

export interface RequestDeletionInput {
  readonly organizationId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly targetType: 'organization' | 'project' | 'conversation' | 'user' | 'knowledge_item';
  readonly targetId: string;
  readonly reason: string | undefined;
  readonly graceDays: number | undefined;
}

export class AuditService {
  private readonly repository: AuditRepository;

  constructor(
    db: Database,
    private readonly queues: GovernanceQueues,
  ) {
    this.repository = new AuditRepository(db);
  }

  async listSecurityEvents(
    filter: SecurityEventFilter,
    limit: number,
    cursor: string | undefined,
  ): Promise<CursorPage<SecurityEvent>> {
    const rows = await this.repository.listSecurityEvents(filter, limit, cursor);
    const page = buildPage(rows, limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return { items: page.items.map(toSecurityEventView), pageInfo: page.pageInfo };
  }

  /**
   * Registra o pedido de exportação e chama o processador do worker.
   *
   * O pacote gerado não contém hash de senha, token nem credencial: o
   * processador lista as colunas uma a uma justamente para que um `select *`
   * distraído não vire vazamento (`Docs/09`).
   */
  async requestExport(input: RequestExportInput): Promise<DataExportJob> {
    if (input.scope !== 'organization' && input.scopeId === undefined) {
      throw badRequest(
        'VALIDATION_FAILED',
        `An export scoped to a ${input.scope} needs the scopeId of that ${input.scope}.`,
        { fields: [{ path: 'scopeId', message: 'is required for this scope' }] },
      );
    }

    const exportJobId = await this.repository.createExportJob({
      organizationId: input.organizationId,
      requestedByUserId: input.actorId,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      format: input.format,
    });

    await this.queues.enqueueExport({
      organizationId: input.organizationId,
      exportJobId,
      correlationId: input.correlationId,
      requestedBy: input.actorId,
    });

    const row = await this.repository.findExportJob(input.organizationId, exportJobId);

    if (row === undefined) {
      throw internalError('The export request could not be read back.');
    }

    return toExportJobView(row);
  }

  async listExports(
    organizationId: string,
    status: string | undefined,
    limit: number,
    cursor: string | undefined,
  ): Promise<CursorPage<DataExportJob>> {
    const rows = await this.repository.listExportJobs(organizationId, status, limit, cursor);
    const page = buildPage(rows, limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return { items: page.items.map(toExportJobView), pageInfo: page.pageInfo };
  }

  /**
   * Registra o pedido de exclusão com janela de arrependimento.
   *
   * O job entra na fila com atraso igual à janela: até lá, o pedido pode ser
   * cancelado no banco, e é isso que dá sentido ao `deleted_at` das tabelas que
   * o têm (`Docs/07`).
   */
  async requestDeletion(input: RequestDeletionInput): Promise<DeletionJob> {
    const graceDays = input.graceDays ?? DEFAULT_DELETION_GRACE_DAYS;
    const scheduledFor = new Date(Date.now() + graceDays * DAY_MS);

    const deletionJobId = await this.repository.createDeletionJob({
      organizationId: input.organizationId,
      requestedByUserId: input.actorId,
      targetType: input.targetType,
      targetId: input.targetId,
      scheduledFor,
      reason: input.reason ?? null,
    });

    await this.queues.enqueueDeletion({
      organizationId: input.organizationId,
      deletionJobId,
      correlationId: input.correlationId,
      requestedBy: input.actorId,
      scheduledFor,
    });

    const row = await this.repository.findDeletionJob(input.organizationId, deletionJobId);

    if (row === undefined) {
      throw internalError('The deletion request could not be read back.');
    }

    return toDeletionJobView(row);
  }

  async listDeletions(
    organizationId: string,
    status: string | undefined,
    limit: number,
    cursor: string | undefined,
  ): Promise<CursorPage<DeletionJob>> {
    const rows = await this.repository.listDeletionJobs(organizationId, status, limit, cursor);
    const page = buildPage(rows, limit, (row) => ({
      at: row.createdAt.getTime(),
      id: row.id,
    }));

    return { items: page.items.map(toDeletionJobView), pageInfo: page.pageInfo };
  }
}
