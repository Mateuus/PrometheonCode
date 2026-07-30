/**
 * Leitura do log de auditoria.
 *
 * Só `SELECT`: `audit_logs` é append-oriented (`Docs/09`) e a API não oferece
 * caminho para editar nem apagar uma linha.
 */

import { auditLogs, users, type Database } from '@prometheon/database';
import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm';

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
}
