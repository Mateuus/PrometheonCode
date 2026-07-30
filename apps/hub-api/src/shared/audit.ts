/**
 * Auditoria append-oriented (`Docs/09`).
 *
 * `audit_logs` não tem `updated_at` nem `version`: nada altera um registro
 * depois de escrito. Corrigir uma linha de auditoria é escrever outra.
 *
 * O que entra em `metadata` já vem redigido por quem chama — a redaction do
 * logger não alcança o que vai para o banco, e este é o lugar mais fácil do
 * sistema para um token vazar sem ninguém notar.
 */

import { auditLogs, newId, writable, type AuditLog, type Database } from '@prometheon/database';
import { child } from '@prometheon/logger';
import type { FastifyRequest } from 'fastify';

export interface AuditEntry {
  readonly organizationId: string;
  readonly actorType: 'user' | 'agent' | 'device' | 'system';
  readonly actorId: string | null;
  readonly actorLabel?: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly projectId?: string | null;
  readonly result?: 'success' | 'denied' | 'failure';
  readonly reason?: string | null;
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  try {
    await db.manager.insert(
      auditLogs,
      writable<AuditLog>({
        id: newId(),
        organizationId: entry.organizationId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        projectId: entry.projectId ?? null,
        result: entry.result ?? 'success',
        reason: entry.reason ?? null,
        requestId: entry.requestId ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        metadata: entry.metadata ?? null,
      }),
    );
  } catch (error) {
    // Falha ao auditar não pode derrubar a operação auditada — mas também não
    // pode passar em silêncio, porque é perda de rastro.
    child('audit').error({ err: error, action: entry.action }, 'failed to write audit log');
  }
}

/** Extrai IP e user agent da requisição, no formato que a auditoria espera. */
export function requestOrigin(request: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];

  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null,
  };
}
