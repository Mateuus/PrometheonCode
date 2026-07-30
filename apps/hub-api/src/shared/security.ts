/**
 * Eventos de segurança (`Docs/09`).
 *
 * Diferente da auditoria, que registra o que foi feito, `security_events`
 * registra o que **alguém tentou** e não pôde: permissão negada, credencial
 * recusada, revisão contornada. As duas tabelas são append-oriented — nada aqui
 * atualiza nem apaga linha.
 *
 * `details` já chega redigido de quem chama: este é, junto da auditoria, o
 * lugar mais fácil do sistema para um segredo vazar sem ninguém notar.
 */

import { newId, securityEvents, type Database } from '@prometheon/database';
import { child } from '@prometheon/logger';
import type { FastifyRequest } from 'fastify';

export interface SecurityEventEntry {
  /** Nulo em evento anterior à identificação do tenant. */
  readonly organizationId: string | null;
  readonly userId: string | null;
  /** `permission_denied`, `login_failed`, `refresh_token_reuse`… */
  readonly type: string;
  readonly severity?: 'low' | 'medium' | 'high' | 'critical';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly details?: Record<string, unknown>;
}

export async function recordSecurityEvent(
  db: Database,
  entry: SecurityEventEntry,
): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      id: newId(),
      organizationId: entry.organizationId,
      userId: entry.userId,
      type: entry.type,
      severity: entry.severity ?? 'low',
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      details: entry.details ?? null,
      occurredAt: new Date(),
    });
  } catch (error) {
    // Falhar ao registrar não pode derrubar a operação que gerou o evento — mas
    // também não pode passar em silêncio, porque é perda de rastro.
    child('security').error({ err: error, type: entry.type }, 'failed to write security event');
  }
}

/** Origem da requisição no formato que o registro espera. */
export function securityOrigin(request: FastifyRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];

  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null,
  };
}
