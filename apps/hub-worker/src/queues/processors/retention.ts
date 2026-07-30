// Fila `retention` — limpeza por política (`Docs/08`, `Docs/09`).
//
// A política vem do banco, não de constante no código: cada organização usa o
// próprio `retention_days` e, quando ele é nulo, o do plano. É por isso que a
// varredura começa em `organizations INNER JOIN plans`.
//
// O que é apagado e por quê:
//
// - **`audit_logs` e `security_events`** são as tabelas de governança. Elas são
//   append-only e existem justamente para durar — então só saem depois da
//   janela contratada, e um evento de segurança grave ainda não resolvido nunca
//   sai, mesmo vencido: apagar o rastro de um incidente aberto seria o oposto
//   do que o `Docs/09` pede.
// - **`agent_run_events` e `webhook_deliveries`** são volume operacional: o que
//   já foi processado não precisa sobreviver à janela.
// - **`outbox_messages`** já publicadas são higiene do próprio worker — sem
//   isso o índice de varredura cresce para sempre.
// - **linhas com `deleted_at` vencido** (conversas, mensagens, itens de
//   conhecimento) viram exclusão definitiva: `deleted_at` é a janela de
//   recuperação, e passada a janela o dado precisa sumir de verdade.
// - **credenciais expiradas** saem numa passada global, com carência própria,
//   porque sessão e refresh token não pertencem a uma organização.
//
// A exclusão é sempre em lotes com `LIMIT`: um `DELETE` de milhões de linhas
// segura lock, enche o binlog e trava a replicação. Cada tabela tem teto por
// execução; o que sobrar fica para a próxima volta.

import { and, eq, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import {
  agentRunEvents,
  auditLogs,
  conversations,
  deviceTokens,
  knowledgeItems,
  messages,
  organizations,
  outboxMessages,
  plans,
  refreshTokens,
  securityEvents,
  userSessions,
  webhookDeliveries,
  type Database,
} from '@prometheon/database';

import type { JobHandler } from '../runtime.js';
import { retentionJobSchema, type RetentionJob } from '../payloads.js';

/** Carência das credenciais expiradas, independente da política do tenant. */
const AUTH_GRACE_DAYS = 30;

const DAY_MS = 86_400_000;

export interface RetentionTargetReport {
  readonly table: string;
  readonly deleted: number;
  /** `true` quando o teto por execução foi atingido e sobrou trabalho. */
  readonly truncated: boolean;
}

export interface RetentionReport {
  readonly dryRun: boolean;
  readonly organizations: number;
  readonly targets: readonly RetentionTargetReport[];
  readonly totalDeleted: number;
}

interface RetentionTarget {
  readonly table: string;
  /** Referência à tabela, interpolada com crase pelo Drizzle. */
  readonly relation: unknown;
  readonly where: SQL;
}

/** Política efetiva: a da organização vence a do plano. */
interface OrganizationRetention {
  readonly id: string;
  readonly retentionDays: number;
}

async function readOrganizationPolicies(
  db: Database,
  organizationId: string | undefined,
): Promise<OrganizationRetention[]> {
  const rows = await db
    .select({
      id: organizations.id,
      // O driver pode devolver `int` como número ou como string.
      retentionDays: sql<number | string>`coalesce(${organizations.retentionDays}, ${plans.retentionDays})`,
    })
    .from(organizations)
    .innerJoin(plans, eq(organizations.planId, plans.id))
    .where(organizationId === undefined ? undefined : eq(organizations.id, organizationId));

  return rows
    .map((row) => ({ id: row.id, retentionDays: Number(row.retentionDays) }))
    .filter((row) => Number.isFinite(row.retentionDays) && row.retentionDays > 0);
}

/** Alvos de uma organização, com o corte já resolvido. */
function organizationTargets(organizationId: string, cutoff: Date): RetentionTarget[] {
  return [
    {
      table: 'audit_logs',
      relation: auditLogs,
      where: and(
        eq(auditLogs.organizationId, organizationId),
        lt(auditLogs.createdAt, cutoff),
      )!,
    },
    {
      table: 'security_events',
      relation: securityEvents,
      // Incidente ainda aberto e grave permanece, mesmo vencido.
      where: and(
        eq(securityEvents.organizationId, organizationId),
        lt(securityEvents.createdAt, cutoff),
        or(
          isNotNull(securityEvents.resolvedAt),
          sql`${securityEvents.severity} in ('low', 'medium')`,
        ),
      )!,
    },
    {
      table: 'agent_run_events',
      relation: agentRunEvents,
      where: and(
        eq(agentRunEvents.organizationId, organizationId),
        lt(agentRunEvents.createdAt, cutoff),
      )!,
    },
    {
      table: 'webhook_deliveries',
      relation: webhookDeliveries,
      where: and(
        eq(webhookDeliveries.organizationId, organizationId),
        lt(webhookDeliveries.createdAt, cutoff),
        sql`${webhookDeliveries.status} in ('processed', 'skipped', 'failed')`,
      )!,
    },
    {
      table: 'outbox_messages',
      relation: outboxMessages,
      where: and(
        eq(outboxMessages.organizationId, organizationId),
        isNotNull(outboxMessages.publishedAt),
        lt(outboxMessages.publishedAt, cutoff),
      )!,
    },
    {
      table: 'messages',
      relation: messages,
      where: and(
        eq(messages.organizationId, organizationId),
        isNotNull(messages.deletedAt),
        lt(messages.deletedAt, cutoff),
      )!,
    },
    {
      table: 'conversations',
      relation: conversations,
      where: and(
        eq(conversations.organizationId, organizationId),
        isNotNull(conversations.deletedAt),
        lt(conversations.deletedAt, cutoff),
      )!,
    },
    {
      table: 'knowledge_items',
      relation: knowledgeItems,
      where: and(
        eq(knowledgeItems.organizationId, organizationId),
        isNotNull(knowledgeItems.deletedAt),
        lt(knowledgeItems.deletedAt, cutoff),
      )!,
    },
  ];
}

/**
 * Alvos que não pertencem a uma organização: credenciais vencidas. Só rodam na
 * execução global, com carência própria.
 */
function globalTargets(cutoff: Date): RetentionTarget[] {
  return [
    {
      table: 'refresh_tokens',
      relation: refreshTokens,
      where: lt(refreshTokens.expiresAt, cutoff),
    },
    {
      table: 'user_sessions',
      relation: userSessions,
      where: lt(userSessions.expiresAt, cutoff),
    },
    {
      table: 'device_tokens',
      relation: deviceTokens,
      where: and(
        lt(deviceTokens.expiresAt, cutoff),
        // Credencial de dispositivo ainda em uso não vence junto com o código.
        or(isNull(deviceTokens.consumedAt), isNotNull(deviceTokens.revokedAt)),
      )!,
    },
  ];
}

interface DeleteResultHeader {
  readonly affectedRows?: number;
}

/** `DELETE ... LIMIT n` em laço, até o teto ou até não sobrar linha. */
async function deleteInBatches(
  db: Database,
  target: RetentionTarget,
  batchSize: number,
  maxRows: number,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;
  for (;;) {
    const remaining = maxRows - deleted;
    if (remaining <= 0) {
      return { deleted, truncated: true };
    }
    const limit = Math.min(batchSize, remaining);
    const result = await db.execute(
      sql`delete from ${target.relation} where ${target.where} limit ${sql.raw(String(limit))}`,
    );
    const header = (result as unknown as [DeleteResultHeader | undefined])[0];
    const affected = header?.affectedRows ?? 0;
    deleted += affected;
    if (affected < limit) {
      return { deleted, truncated: false };
    }
  }
}

/** Conta o que seria apagado, sem apagar. */
async function countMatching(db: Database, target: RetentionTarget): Promise<number> {
  const rows = await db.execute(
    sql`select count(*) as total from ${target.relation} where ${target.where}`,
  );
  const first = (rows as unknown as [{ total?: unknown }[] | undefined])[0]?.[0];
  return Number(first?.total ?? 0);
}

export interface RunRetentionInput {
  readonly db: Database;
  readonly job: RetentionJob;
  readonly now?: Date;
}

/**
 * Aplica a política. Exportado à parte do handler para ser testável sem BullMQ.
 */
export async function runRetention(input: RunRetentionInput): Promise<RetentionReport> {
  const { db, job } = input;
  const now = input.now ?? new Date();
  const policies = await readOrganizationPolicies(db, job.organizationId);

  const totals = new Map<string, { deleted: number; truncated: boolean }>();
  const accumulate = (table: string, result: { deleted: number; truncated: boolean }): void => {
    const previous = totals.get(table) ?? { deleted: 0, truncated: false };
    totals.set(table, {
      deleted: previous.deleted + result.deleted,
      truncated: previous.truncated || result.truncated,
    });
  };

  for (const policy of policies) {
    const cutoff = new Date(now.getTime() - policy.retentionDays * DAY_MS);
    for (const target of organizationTargets(policy.id, cutoff)) {
      if (job.dryRun) {
        accumulate(target.table, { deleted: await countMatching(db, target), truncated: false });
        continue;
      }
      accumulate(
        target.table,
        await deleteInBatches(db, target, job.batchSize, job.maxRowsPerTable),
      );
    }
  }

  // Credenciais expiradas só na execução global — elas não são de um tenant.
  if (job.organizationId === undefined) {
    const authCutoff = new Date(now.getTime() - AUTH_GRACE_DAYS * DAY_MS);
    for (const target of globalTargets(authCutoff)) {
      if (job.dryRun) {
        accumulate(target.table, { deleted: await countMatching(db, target), truncated: false });
        continue;
      }
      accumulate(
        target.table,
        await deleteInBatches(db, target, job.batchSize, job.maxRowsPerTable),
      );
    }
  }

  const targets = [...totals.entries()]
    .map(([table, value]) => ({ table, deleted: value.deleted, truncated: value.truncated }))
    .filter((entry) => entry.deleted > 0 || entry.truncated);

  return {
    dryRun: job.dryRun,
    organizations: policies.length,
    targets,
    totalDeleted: targets.reduce((sum, entry) => sum + entry.deleted, 0),
  };
}

export const retentionHandler: JobHandler<typeof retentionJobSchema> = {
  queue: 'retention',
  schema: retentionJobSchema,
  async run({ data, deps, logger }) {
    const report = await runRetention({ db: deps.db, job: data });
    logger.info(
      {
        dryRun: report.dryRun,
        organizations: report.organizations,
        totalDeleted: report.totalDeleted,
        targets: report.targets,
      },
      'retenção aplicada',
    );
    return {
      status: 'done',
      details: {
        organizations: report.organizations,
        totalDeleted: report.totalDeleted,
        tables: report.targets.length,
      },
    };
  },
};
