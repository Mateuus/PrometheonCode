// Fila `exports` — materializa um `data_export_jobs` (`Docs/09`).
//
// O pacote é montado a partir do banco e gravado como JSON. Duas regras
// mandam no que entra nele:
//
// - **nenhum segredo sai daqui**: as colunas são listadas uma a uma, e as que
//   guardam hash de senha, hash de token ou credencial cifrada simplesmente não
//   aparecem na lista. Um `select *` distraído seria vazamento;
// - **o pacote é limitado**: cada coleção tem teto de linhas, porque exportação
//   é operação de fundo e não pode virar leitura da base inteira em memória.
//
// PENDENTE DA API/infra: o destino final é object storage com link assinado e
// expiração. Enquanto isso o worker grava no diretório configurado
// (`WORKER_EXPORT_DIR`) e guarda o caminho relativo em `storage_key`, que é
// exatamente o que a API precisa trocar por uma URL depois. O formato `zip`
// ainda não tem empacotador: por ora ele sai como JSON comprimido em gzip, e o
// `storage_key` reflete isso na extensão.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import {
  conversationParticipants,
  conversations,
  dataExportJobs,
  devices,
  knowledgeItems,
  messageParts,
  messages,
  organizationMembers,
  organizations,
  projectSettings,
  projects,
  tasks,
  userIdentities,
  users,
  type Database,
} from '@prometheon/database';

import { PermanentJobError } from '../../errors.js';
import { exportJobSchema } from '../payloads.js';
import type { JobHandler } from '../runtime.js';

const gzipAsync = promisify(gzip);

/** Teto por coleção. Exportação grande vira várias, não uma leitura infinita. */
const MAX_ROWS = 20_000;

/** Linha presa em `running` além disto é de worker que morreu. */
const STALE_RUNNING_MS = 30 * 60_000;

export interface ExportBundle {
  readonly format: 'json' | 'zip';
  readonly scope: string;
  readonly scopeId: string | null;
  readonly generatedAt: string;
  readonly collections: Record<string, unknown[]>;
}

export interface ExportOutcome {
  readonly status: 'exported' | 'already-completed' | 'cancelled' | 'lost-race';
  readonly storageKey?: string;
  readonly sizeBytes?: number;
  readonly collections?: Record<string, number>;
}

/** Colunas seguras de `users`: sem `password_hash`. */
const USER_COLUMNS = [
  'user.id',
  'user.email',
  'user.displayName',
  'user.avatarUrl',
  'user.locale',
  'user.timezone',
  'user.status',
  'user.emailVerifiedAt',
  'user.lastLoginAt',
  'user.createdAt',
  'user.deletedAt',
] as const;

/** Colunas seguras de `devices`: sem impressão digital nem IP bruto. */
const DEVICE_COLUMNS = [
  'device.id',
  'device.userId',
  'device.name',
  'device.platform',
  'device.client',
  'device.clientVersion',
  'device.status',
  'device.approvedAt',
  'device.revokedAt',
  'device.lastSeenAt',
  'device.createdAt',
] as const;

async function collectOrganization(
  db: Database,
  organizationId: string,
): Promise<Record<string, unknown[]>> {
  const organization = await db.manager
    .createQueryBuilder(organizations, 'organization')
    .select([
      'organization.id',
      'organization.slug',
      'organization.name',
      'organization.status',
      'organization.billingEmail',
      'organization.settings',
      'organization.policy',
      'organization.retentionDays',
      'organization.createdAt',
    ])
    .where('organization.id = :organizationId', { organizationId })
    .limit(1)
    .getOne();

  if (organization === null) {
    throw new PermanentJobError('Organização inexistente para exportação.', {
      code: 'EXPORT_ORGANIZATION_NOT_FOUND',
      details: { organizationId },
    });
  }

  const [members, projectRows, conversationRows, knowledgeRows, taskRows] = await Promise.all([
    db.manager
      .createQueryBuilder(organizationMembers, 'member')
      .select([
        'member.id',
        'member.userId',
        'member.roleId',
        'member.status',
        'member.createdAt',
      ])
      .where('member.organizationId = :organizationId', { organizationId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(projects, 'project')
      .select([
        'project.id',
        'project.slug',
        'project.name',
        'project.description',
        'project.status',
        'project.visibility',
        'project.defaultBranch',
        'project.createdAt',
        'project.deletedAt',
      ])
      .where('project.organizationId = :organizationId', { organizationId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(conversations, 'conversation')
      .select([
        'conversation.id',
        'conversation.projectId',
        'conversation.title',
        'conversation.status',
        'conversation.visibility',
        'conversation.messageCount',
        'conversation.createdAt',
        'conversation.deletedAt',
      ])
      .where('conversation.organizationId = :organizationId', { organizationId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(knowledgeItems, 'item')
      .select([
        'item.id',
        'item.projectId',
        'item.slug',
        'item.title',
        'item.category',
        'item.status',
        'item.confidence',
        'item.tags',
        'item.createdAt',
      ])
      .where('item.organizationId = :organizationId', { organizationId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(tasks, 'task')
      .select([
        'task.id',
        'task.projectId',
        'task.title',
        'task.status',
        'task.priority',
        'task.createdAt',
      ])
      .where('task.organizationId = :organizationId', { organizationId })
      .limit(MAX_ROWS)
      .getMany(),
  ]);

  return {
    organizations: [organization],
    organizationMembers: members,
    projects: projectRows,
    conversations: conversationRows,
    knowledgeItems: knowledgeRows,
    tasks: taskRows,
  };
}

async function collectProject(
  db: Database,
  organizationId: string,
  projectId: string,
): Promise<Record<string, unknown[]>> {
  const project = await db.manager
    .createQueryBuilder(projects, 'project')
    .select([
      'project.id',
      'project.slug',
      'project.name',
      'project.description',
      'project.status',
      'project.visibility',
      'project.defaultBranch',
      'project.createdAt',
    ])
    .where('project.id = :projectId', { projectId })
    .andWhere('project.organizationId = :organizationId', { organizationId })
    .limit(1)
    .getOne();

  if (project === null) {
    throw new PermanentJobError('Projeto inexistente para exportação.', {
      code: 'EXPORT_PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }

  const [settings, conversationRows, knowledgeRows, taskRows] = await Promise.all([
    db.manager
      .createQueryBuilder(projectSettings, 'settings')
      .select([
        'settings.defaultWorkMode',
        'settings.defaultAutonomy',
        'settings.contextBudgetTokens',
        'settings.requireReview',
        'settings.knowledgePath',
        'settings.retentionDays',
      ])
      .where('settings.projectId = :projectId', { projectId })
      .limit(1)
      .getMany(),
    db.manager
      .createQueryBuilder(conversations, 'conversation')
      .select([
        'conversation.id',
        'conversation.title',
        'conversation.status',
        'conversation.messageCount',
        'conversation.createdAt',
      ])
      .where('conversation.projectId = :projectId', { projectId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(knowledgeItems, 'item')
      .select([
        'item.id',
        'item.slug',
        'item.title',
        'item.category',
        'item.status',
      ])
      .where('item.projectId = :projectId', { projectId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(tasks, 'task')
      .select([
        'task.id',
        'task.title',
        'task.status',
        'task.priority',
        'task.createdAt',
      ])
      .where('task.projectId = :projectId', { projectId })
      .limit(MAX_ROWS)
      .getMany(),
  ]);

  return {
    projects: [project],
    projectSettings: settings,
    conversations: conversationRows,
    knowledgeItems: knowledgeRows,
    tasks: taskRows,
  };
}

async function collectConversation(
  db: Database,
  organizationId: string,
  conversationId: string,
): Promise<Record<string, unknown[]>> {
  const conversation = await db.manager
    .createQueryBuilder(conversations, 'conversation')
    .select([
      'conversation.id',
      'conversation.projectId',
      'conversation.title',
      'conversation.status',
      'conversation.visibility',
      'conversation.messageCount',
      'conversation.createdAt',
    ])
    .where('conversation.id = :conversationId', { conversationId })
    .andWhere('conversation.organizationId = :organizationId', { organizationId })
    .limit(1)
    .getOne();

  if (conversation === null) {
    throw new PermanentJobError('Conversa inexistente para exportação.', {
      code: 'EXPORT_CONVERSATION_NOT_FOUND',
      details: { conversationId },
    });
  }

  const [participants, messageRows] = await Promise.all([
    db.manager
      .createQueryBuilder(conversationParticipants, 'participant')
      .select([
        'participant.participantType',
        'participant.participantId',
        'participant.role',
        'participant.joinedAt',
        'participant.leftAt',
      ])
      .where('participant.conversationId = :conversationId', { conversationId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(messages, 'message')
      .select([
        'message.id',
        'message.sequence',
        'message.authorType',
        'message.authorUserId',
        'message.status',
        'message.createdAt',
        'message.deletedAt',
      ])
      .where('message.conversationId = :conversationId', { conversationId })
      .orderBy('message.sequence', 'ASC')
      .limit(MAX_ROWS)
      .getMany(),
  ]);

  const messageIds = messageRows.map((row) => row.id);
  const parts =
    messageIds.length === 0
      ? []
      : await db.manager
          .createQueryBuilder(messageParts, 'part')
          .select([
            'part.messageId',
            'part.sequence',
            'part.type',
            'part.content',
            'part.payload',
            'part.toolName',
          ])
          .where('part.messageId IN (:...messageIds)', { messageIds })
          .limit(MAX_ROWS)
          .getMany();

  return {
    conversations: [conversation],
    conversationParticipants: participants,
    messages: messageRows,
    messageParts: parts,
  };
}

async function collectUser(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<Record<string, unknown[]>> {
  const user = await db.manager
    .createQueryBuilder(users, 'user')
    .select([...USER_COLUMNS])
    .where('user.id = :userId', { userId })
    .limit(1)
    .getOne();

  if (user === null) {
    throw new PermanentJobError('Usuário inexistente para exportação.', {
      code: 'EXPORT_USER_NOT_FOUND',
      details: { userId },
    });
  }

  const [identities, deviceRows, memberships] = await Promise.all([
    db.manager
      .createQueryBuilder(userIdentities, 'identity')
      .select(['identity.provider', 'identity.providerAccountId', 'identity.createdAt'])
      .where('identity.userId = :userId', { userId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(devices, 'device')
      .select([...DEVICE_COLUMNS])
      .where('device.userId = :userId', { userId })
      .limit(MAX_ROWS)
      .getMany(),
    db.manager
      .createQueryBuilder(organizationMembers, 'member')
      .select([
        'member.organizationId',
        'member.roleId',
        'member.status',
        'member.createdAt',
      ])
      .where('member.userId = :userId', { userId })
      .andWhere('member.organizationId = :organizationId', { organizationId })
      .limit(MAX_ROWS)
      .getMany(),
  ]);

  return {
    users: [user],
    userIdentities: identities,
    devices: deviceRows,
    organizationMembers: memberships,
  };
}

export interface RunExportInput {
  readonly db: Database;
  readonly exportJobId: string;
  readonly organizationId: string;
  readonly exportsDir: string;
  readonly downloadTtlMs: number;
  readonly now?: Date;
}

/** Executa a exportação. Exportado à parte do handler para ser testável. */
export async function runExport(input: RunExportInput): Promise<ExportOutcome> {
  const { db, exportJobId, organizationId } = input;
  const now = input.now ?? new Date();

  const row = await db.manager
    .createQueryBuilder(dataExportJobs, 'job')
    .select(['job.id', 'job.status', 'job.scope', 'job.scopeId', 'job.format'])
    .where('job.id = :exportJobId', { exportJobId })
    .andWhere('job.organizationId = :organizationId', { organizationId })
    .limit(1)
    .getOne();

  if (row === null) {
    throw new PermanentJobError('Job de exportação inexistente.', {
      code: 'EXPORT_JOB_NOT_FOUND',
      details: { exportJobId, organizationId },
    });
  }
  if (row.status === 'completed') {
    return { status: 'already-completed' };
  }
  if (row.status === 'cancelled') {
    return { status: 'cancelled' };
  }

  // Mesma reivindicação condicional da fila `deletions`: quem não afeta linha
  // alguma perdeu a corrida para outro worker.
  const claim = await db.manager
    .createQueryBuilder()
    .update(dataExportJobs)
    .set({ status: 'running', startedAt: now, version: () => 'version + 1' })
    .where('id = :exportJobId', { exportJobId })
    .andWhere(
      "(status IN (:...claimable) OR (status = 'running' AND updated_at < :staleBefore))",
      {
        claimable: ['pending', 'scheduled', 'failed'],
        staleBefore: new Date(now.getTime() - STALE_RUNNING_MS),
      },
    )
    .execute();

  if ((claim.affected ?? 0) === 0) {
    return { status: 'lost-race' };
  }

  try {
    const collections = await collect(db, row.scope, row.scopeId, organizationId);
    const bundle: ExportBundle = {
      format: row.format,
      scope: row.scope,
      scopeId: row.scopeId,
      generatedAt: now.toISOString(),
      collections,
    };

    const json = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    const compress = row.format === 'zip';
    const body = compress ? await gzipAsync(json) : json;
    const extension = compress ? 'json.gz' : 'json';
    const storageKey = join(organizationId, `${exportJobId}.${extension}`).replace(/\\/g, '/');
    const absolutePath = join(input.exportsDir, storageKey);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body);

    const completedAt = new Date();
    await db.manager
      .createQueryBuilder()
      .update(dataExportJobs)
      .set({
        status: 'completed',
        storageKey,
        sizeBytes: body.byteLength,
        downloadExpiresAt: new Date(completedAt.getTime() + input.downloadTtlMs),
        completedAt,
        errorMessage: null,
        version: () => 'version + 1',
      })
      .where('id = :exportJobId', { exportJobId })
      .execute();

    return {
      status: 'exported',
      storageKey,
      sizeBytes: body.byteLength,
      collections: Object.fromEntries(
        Object.entries(collections).map(([name, rows]) => [name, rows.length]),
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof PermanentJobError;
    await db.manager
      .createQueryBuilder()
      .update(dataExportJobs)
      .set({
        status: permanent ? 'failed' : 'pending',
        errorMessage: message.slice(0, 2_000),
        version: () => 'version + 1',
      })
      .where('id = :exportJobId', { exportJobId })
      .execute();
    throw error;
  }
}

function collect(
  db: Database,
  scope: string,
  scopeId: string | null,
  organizationId: string,
): Promise<Record<string, unknown[]>> {
  switch (scope) {
    case 'organization':
      return collectOrganization(db, scopeId ?? organizationId);
    case 'project':
      return collectProject(db, organizationId, requireScopeId(scope, scopeId));
    case 'conversation':
      return collectConversation(db, organizationId, requireScopeId(scope, scopeId));
    case 'user':
      return collectUser(db, organizationId, requireScopeId(scope, scopeId));
    default:
      throw new PermanentJobError(`Escopo de exportação desconhecido: "${scope}".`, {
        code: 'EXPORT_SCOPE_UNKNOWN',
        details: { scope },
      });
  }
}

function requireScopeId(scope: string, scopeId: string | null): string {
  if (scopeId === null) {
    throw new PermanentJobError(`Escopo "${scope}" exige \`scope_id\`.`, {
      code: 'EXPORT_SCOPE_ID_MISSING',
      details: { scope },
    });
  }
  return scopeId;
}

/** Impressão do pacote, útil para o log sem revelar conteúdo. */
export function bundleDigest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export const exportsHandler: JobHandler<typeof exportJobSchema> = {
  queue: 'exports',
  schema: exportJobSchema,
  idempotencyKey: (data) => `export:${data.exportJobId}`,
  async run({ data, deps, logger }) {
    const outcome = await runExport({
      db: deps.db,
      exportJobId: data.exportJobId,
      organizationId: data.organizationId,
      exportsDir: deps.settings.storage.exportsDir,
      downloadTtlMs: deps.settings.storage.downloadTtlMs,
    });

    logger.info(
      {
        exportJobId: data.exportJobId,
        outcome: outcome.status,
        sizeBytes: outcome.sizeBytes,
      },
      'exportação processada',
    );

    if (outcome.status === 'exported') {
      return { status: 'done', details: { ...outcome } };
    }
    return { status: 'skipped', details: { ...outcome } };
  },
};
