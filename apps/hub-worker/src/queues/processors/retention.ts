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
//
// É por causa desse `LIMIT` que os alvos são SQL cru: o `DeleteQueryBuilder` do
// TypeORM não tem `limit()`, e `manager.delete()` apaga tudo que casa com o
// filtro de uma vez — exatamente o `DELETE` gigante que este arquivo evita.
// Cada alvo declara a tabela física, a condição com placeholders `?` e os
// parâmetros; nada aqui é interpolado a partir de entrada de usuário.

import {
  organizations,
  plans,
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
  /** Condição do `WHERE`, com placeholders `?` na ordem de `params`. */
  readonly where: string;
  readonly params: readonly unknown[];
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
  const query = db.manager
    .createQueryBuilder(organizations, 'organization')
    .select('organization.id', 'id')
    // Colunas de duas tabelas na mesma linha: leitura crua com aliases, não
    // hidratação de entidade.
    .addSelect(
      'coalesce(organization.retentionDays, plan.retentionDays)',
      'retentionDays',
    )
    .innerJoin(plans.options.name, 'plan', 'plan.id = organization.planId');

  if (organizationId !== undefined) {
    query.where('organization.id = :organizationId', { organizationId });
  }

  // O driver pode devolver `int` como número ou como string.
  const rows = await query.getRawMany<{ id: string; retentionDays: number | string }>();

  return rows
    .map((row) => ({ id: row.id, retentionDays: Number(row.retentionDays) }))
    .filter((row) => Number.isFinite(row.retentionDays) && row.retentionDays > 0);
}

/** Alvos de uma organização, com o corte já resolvido. */
function organizationTargets(organizationId: string, cutoff: Date): RetentionTarget[] {
  return [
    {
      table: 'audit_logs',
      where: 'organization_id = ? and created_at < ?',
      params: [organizationId, cutoff],
    },
    {
      table: 'security_events',
      // Incidente ainda aberto e grave permanece, mesmo vencido.
      where:
        'organization_id = ? and created_at < ? ' +
        "and (resolved_at is not null or severity in ('low', 'medium'))",
      params: [organizationId, cutoff],
    },
    {
      table: 'agent_run_events',
      where: 'organization_id = ? and created_at < ?',
      params: [organizationId, cutoff],
    },
    {
      table: 'webhook_deliveries',
      where:
        'organization_id = ? and created_at < ? ' +
        "and status in ('processed', 'skipped', 'failed')",
      params: [organizationId, cutoff],
    },
    {
      table: 'outbox_messages',
      where: 'organization_id = ? and published_at is not null and published_at < ?',
      params: [organizationId, cutoff],
    },
    {
      table: 'messages',
      where: 'organization_id = ? and deleted_at is not null and deleted_at < ?',
      params: [organizationId, cutoff],
    },
    {
      table: 'conversations',
      where: 'organization_id = ? and deleted_at is not null and deleted_at < ?',
      params: [organizationId, cutoff],
    },
    {
      table: 'knowledge_items',
      where: 'organization_id = ? and deleted_at is not null and deleted_at < ?',
      params: [organizationId, cutoff],
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
      where: 'expires_at < ?',
      params: [cutoff],
    },
    {
      table: 'user_sessions',
      where: 'expires_at < ?',
      params: [cutoff],
    },
    {
      table: 'device_tokens',
      // Credencial de dispositivo ainda em uso não vence junto com o código.
      where: 'expires_at < ? and (consumed_at is null or revoked_at is not null)',
      params: [cutoff],
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
    // O `LIMIT` entra por interpolação porque o MySQL não aceita placeholder
    // nele em statement preparado; o valor é um inteiro calculado aqui, nunca
    // texto vindo de fora.
    const header: DeleteResultHeader | undefined = await db.query(
      `delete from \`${target.table}\` where ${target.where} limit ${String(limit)}`,
      [...target.params],
    );
    const affected = header?.affectedRows ?? 0;
    deleted += affected;
    if (affected < limit) {
      return { deleted, truncated: false };
    }
  }
}

/** Conta o que seria apagado, sem apagar. */
async function countMatching(db: Database, target: RetentionTarget): Promise<number> {
  const rows: { total?: unknown }[] = await db.query(
    `select count(*) as total from \`${target.table}\` where ${target.where}`,
    [...target.params],
  );
  return Number(rows[0]?.total ?? 0);
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
