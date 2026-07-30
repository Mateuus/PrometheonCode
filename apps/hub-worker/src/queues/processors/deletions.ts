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
      const result = await db.manager.delete(organizations, { id: targetId });
      return result.affected ?? 0;
    }
    case 'project': {
      const result = await db.manager.delete(projects, { id: targetId, organizationId });
      return result.affected ?? 0;
    }
    case 'conversation': {
      const result = await db.manager.delete(conversations, { id: targetId, organizationId });
      return result.affected ?? 0;
    }
    case 'knowledge_item': {
      const result = await db.manager.delete(knowledgeItems, { id: targetId, organizationId });
      return result.affected ?? 0;
    }
    case 'user': {
      // A conta some; a auditoria do que ela fez permanece, porque
      // `audit_logs.actor_id` não tem chave estrangeira (`Docs/09`).
      const result = await db.manager.delete(users, { id: targetId });
      return result.affected ?? 0;
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

  const row = await db.manager
    .createQueryBuilder(deletionJobs, 'job')
    .select([
      'job.id',
      'job.status',
      'job.targetType',
      'job.targetId',
      'job.scheduledFor',
    ])
    .where('job.id = :deletionJobId', { deletionJobId })
    .andWhere('job.organizationId = :organizationId', { organizationId })
    .limit(1)
    .getOne();

  if (row === null) {
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

  // Reivindicação atômica. `running` antigo é de worker que morreu. O `UPDATE`
  // condicional é a idempotência real: quem não afeta linha alguma perdeu a
  // corrida, e ler antes de escrever reabriria a janela entre as duas.
  const claim = await db.manager
    .createQueryBuilder()
    .update(deletionJobs)
    .set({ status: 'running', startedAt: now, version: () => 'version + 1' })
    .where('id = :deletionJobId', { deletionJobId })
    .andWhere(
      "(status IN (:...claimable) OR (status = 'running' AND updated_at < :staleBefore))",
      {
        claimable: ['pending', 'scheduled'],
        staleBefore: new Date(now.getTime() - STALE_RUNNING_MS),
      },
    )
    .execute();

  if ((claim.affected ?? 0) === 0) {
    return { status: 'lost-race', targetType: row.targetType, targetId: row.targetId };
  }

  try {
    const rowsDeleted = await deleteTarget(db, row.targetType, row.targetId, organizationId);
    await db.manager
      .createQueryBuilder()
      .update(deletionJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        errorMessage: null,
        version: () => 'version + 1',
      })
      .where('id = :deletionJobId', { deletionJobId })
      .execute();
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
    await db.manager
      .createQueryBuilder()
      .update(deletionJobs)
      .set({
        status: permanent ? 'failed' : 'pending',
        errorMessage: message.slice(0, 2_000),
        version: () => 'version + 1',
      })
      .where('id = :deletionJobId', { deletionJobId })
      .execute();
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
