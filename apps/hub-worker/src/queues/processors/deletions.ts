// Fila `deletions` — apagamento definitivo agendado (`Docs/09`).
//
// O modelo é o do schema: `deleted_at` marca o início da janela de recuperação
// e `deletion_jobs` guarda quando essa janela fecha. Este processador executa o
// fechamento, e nada mais: quem decide apagar é a API.
//
// Idempotência real, não só por `jobId`: a transição de estado é feita com
// `UPDATE ... WHERE status IN (...)` e o `affectedRows` diz se este worker
// ganhou a corrida. Rodar o mesmo job duas vezes não apaga duas vezes, porque a
// segunda não consegue reivindicar a linha — e se ela já estiver `completed`, o
// job termina como pulado.
//
// A exclusão em si é uma linha só: as chaves estrangeiras do schema estão com
// `on delete cascade` e levam os filhos junto. O que precisa sobreviver —
// auditoria, eventos de segurança — não tem chave estrangeira para o alvo, de
// propósito, e por isso permanece.

import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';

import {
  conversations,
  deletionJobs,
  knowledgeItems,
  organizations,
  projects,
  users,
  type Database,
} from '@prometheon/database';

import { PermanentJobError, TransientJobError } from '../../errors.js';
import { deletionJobSchema } from '../payloads.js';
import type { JobHandler } from '../runtime.js';

/**
 * Depois disto, uma linha presa em `running` é considerada órfã de um worker
 * que morreu e pode ser reivindicada de novo.
 */
const STALE_RUNNING_MS = 15 * 60_000;

export interface DeletionOutcome {
  readonly status: 'deleted' | 'already-completed' | 'cancelled' | 'lost-race';
  readonly targetType?: string;
  readonly targetId?: string;
  readonly rowsDeleted?: number;
}

/** Apaga o alvo. A cascata do schema cuida dos filhos. */
async function deleteTarget(
  db: Database,
  targetType: string,
  targetId: string,
  organizationId: string,
): Promise<number> {
  switch (targetType) {
    case 'organization': {
      const result = await db.delete(organizations).where(eq(organizations.id, targetId));
      return result[0].affectedRows;
    }
    case 'project': {
      const result = await db
        .delete(projects)
        .where(and(eq(projects.id, targetId), eq(projects.organizationId, organizationId)));
      return result[0].affectedRows;
    }
    case 'conversation': {
      const result = await db
        .delete(conversations)
        .where(
          and(eq(conversations.id, targetId), eq(conversations.organizationId, organizationId)),
        );
      return result[0].affectedRows;
    }
    case 'knowledge_item': {
      const result = await db
        .delete(knowledgeItems)
        .where(
          and(eq(knowledgeItems.id, targetId), eq(knowledgeItems.organizationId, organizationId)),
        );
      return result[0].affectedRows;
    }
    case 'user': {
      // A conta some; a auditoria do que ela fez permanece, porque
      // `audit_logs.actor_id` não tem chave estrangeira (`Docs/09`).
      const result = await db.delete(users).where(eq(users.id, targetId));
      return result[0].affectedRows;
    }
    default:
      throw new PermanentJobError(`Alvo de exclusão desconhecido: "${targetType}".`, {
        code: 'DELETION_TARGET_UNKNOWN',
        details: { targetType },
      });
  }
}

export interface RunDeletionInput {
  readonly db: Database;
  readonly deletionJobId: string;
  readonly organizationId: string;
  readonly now?: Date;
}

/** Executa a exclusão. Exportado à parte do handler para ser testável. */
export async function runDeletion(input: RunDeletionInput): Promise<DeletionOutcome> {
  const { db, deletionJobId, organizationId } = input;
  const now = input.now ?? new Date();

  const [row] = await db
    .select({
      id: deletionJobs.id,
      status: deletionJobs.status,
      targetType: deletionJobs.targetType,
      targetId: deletionJobs.targetId,
      scheduledFor: deletionJobs.scheduledFor,
    })
    .from(deletionJobs)
    .where(
      and(eq(deletionJobs.id, deletionJobId), eq(deletionJobs.organizationId, organizationId)),
    )
    .limit(1);

  if (row === undefined) {
    throw new PermanentJobError('Job de exclusão inexistente.', {
      code: 'DELETION_JOB_NOT_FOUND',
      details: { deletionJobId, organizationId },
    });
  }

  if (row.status === 'completed') {
    return { status: 'already-completed', targetType: row.targetType, targetId: row.targetId };
  }
  if (row.status === 'cancelled') {
    return { status: 'cancelled', targetType: row.targetType, targetId: row.targetId };
  }
  if (row.scheduledFor.getTime() > now.getTime()) {
    // A API enfileira com `delay`; chegar cedo aqui é desencontro de relógio ou
    // reenfileiramento manual. Transitório: a próxima tentativa pode caber.
    throw new TransientJobError('Exclusão ainda não venceu.', {
      code: 'DELETION_NOT_DUE',
      details: { scheduledFor: row.scheduledFor.toISOString() },
    });
  }

  // Reivindicação atômica. `running` antigo é de worker que morreu.
  const claim = await db
    .update(deletionJobs)
    .set({ status: 'running', startedAt: now, version: sql`${deletionJobs.version} + 1` })
    .where(
      and(
        eq(deletionJobs.id, deletionJobId),
        or(
          inArray(deletionJobs.status, ['pending', 'scheduled']),
          and(
            eq(deletionJobs.status, 'running'),
            lt(deletionJobs.updatedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
          ),
        ),
      ),
    );

  if (claim[0].affectedRows === 0) {
    return { status: 'lost-race', targetType: row.targetType, targetId: row.targetId };
  }

  try {
    const rowsDeleted = await deleteTarget(db, row.targetType, row.targetId, organizationId);
    await db
      .update(deletionJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        errorMessage: null,
        version: sql`${deletionJobs.version} + 1`,
      })
      .where(eq(deletionJobs.id, deletionJobId));
    return {
      status: 'deleted',
      targetType: row.targetType,
      targetId: row.targetId,
      rowsDeleted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof PermanentJobError;
    // Falha permanente encerra o job como `failed`; falha transitória o devolve
    // a `pending` para que a retentativa consiga reivindicá-lo de novo.
    await db
      .update(deletionJobs)
      .set({
        status: permanent ? 'failed' : 'pending',
        errorMessage: message.slice(0, 2_000),
        version: sql`${deletionJobs.version} + 1`,
      })
      .where(eq(deletionJobs.id, deletionJobId));
    throw error;
  }
}

export const deletionsHandler: JobHandler<typeof deletionJobSchema> = {
  queue: 'deletions',
  schema: deletionJobSchema,
  idempotencyKey: (data) => `deletion:${data.deletionJobId}`,
  async run({ data, deps, logger }) {
    const outcome = await runDeletion({
      db: deps.db,
      deletionJobId: data.deletionJobId,
      organizationId: data.organizationId,
    });

    logger.info(
      {
        deletionJobId: data.deletionJobId,
        outcome: outcome.status,
        targetType: outcome.targetType,
      },
      'exclusão processada',
    );

    if (outcome.status === 'deleted') {
      return { status: 'done', details: { ...outcome } };
    }
    return { status: 'skipped', details: { ...outcome } };
  },
};
