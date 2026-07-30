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

import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';

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
const userColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  locale: users.locale,
  timezone: users.timezone,
  status: users.status,
  emailVerifiedAt: users.emailVerifiedAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  deletedAt: users.deletedAt,
} as const;

/** Colunas seguras de `devices`: sem impressão digital nem IP bruto. */
const deviceColumns = {
  id: devices.id,
  userId: devices.userId,
  name: devices.name,
  platform: devices.platform,
  client: devices.client,
  clientVersion: devices.clientVersion,
  status: devices.status,
  approvedAt: devices.approvedAt,
  revokedAt: devices.revokedAt,
  lastSeenAt: devices.lastSeenAt,
  createdAt: devices.createdAt,
} as const;

async function collectOrganization(
  db: Database,
  organizationId: string,
): Promise<Record<string, unknown[]>> {
  const [organization] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      status: organizations.status,
      billingEmail: organizations.billingEmail,
      settings: organizations.settings,
      policy: organizations.policy,
      retentionDays: organizations.retentionDays,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (organization === undefined) {
    throw new PermanentJobError('Organização inexistente para exportação.', {
      code: 'EXPORT_ORGANIZATION_NOT_FOUND',
      details: { organizationId },
    });
  }

  const [members, projectRows, conversationRows, knowledgeRows, taskRows] = await Promise.all([
    db
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        roleId: organizationMembers.roleId,
        status: organizationMembers.status,
        createdAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId))
      .limit(MAX_ROWS),
    db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        visibility: projects.visibility,
        defaultBranch: projects.defaultBranch,
        createdAt: projects.createdAt,
        deletedAt: projects.deletedAt,
      })
      .from(projects)
      .where(eq(projects.organizationId, organizationId))
      .limit(MAX_ROWS),
    db
      .select({
        id: conversations.id,
        projectId: conversations.projectId,
        title: conversations.title,
        status: conversations.status,
        visibility: conversations.visibility,
        messageCount: conversations.messageCount,
        createdAt: conversations.createdAt,
        deletedAt: conversations.deletedAt,
      })
      .from(conversations)
      .where(eq(conversations.organizationId, organizationId))
      .limit(MAX_ROWS),
    db
      .select({
        id: knowledgeItems.id,
        projectId: knowledgeItems.projectId,
        slug: knowledgeItems.slug,
        title: knowledgeItems.title,
        category: knowledgeItems.category,
        status: knowledgeItems.status,
        confidence: knowledgeItems.confidence,
        tags: knowledgeItems.tags,
        createdAt: knowledgeItems.createdAt,
      })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.organizationId, organizationId))
      .limit(MAX_ROWS),
    db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(eq(tasks.organizationId, organizationId))
      .limit(MAX_ROWS),
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
  const [project] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      visibility: projects.visibility,
      defaultBranch: projects.defaultBranch,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .limit(1);

  if (project === undefined) {
    throw new PermanentJobError('Projeto inexistente para exportação.', {
      code: 'EXPORT_PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }

  const [settings, conversationRows, knowledgeRows, taskRows] = await Promise.all([
    db
      .select({
        defaultWorkMode: projectSettings.defaultWorkMode,
        defaultAutonomy: projectSettings.defaultAutonomy,
        contextBudgetTokens: projectSettings.contextBudgetTokens,
        requireReview: projectSettings.requireReview,
        knowledgePath: projectSettings.knowledgePath,
        retentionDays: projectSettings.retentionDays,
      })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .limit(1),
    db
      .select({
        id: conversations.id,
        title: conversations.title,
        status: conversations.status,
        messageCount: conversations.messageCount,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(eq(conversations.projectId, projectId))
      .limit(MAX_ROWS),
    db
      .select({
        id: knowledgeItems.id,
        slug: knowledgeItems.slug,
        title: knowledgeItems.title,
        category: knowledgeItems.category,
        status: knowledgeItems.status,
      })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.projectId, projectId))
      .limit(MAX_ROWS),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .limit(MAX_ROWS),
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
  const [conversation] = await db
    .select({
      id: conversations.id,
      projectId: conversations.projectId,
      title: conversations.title,
      status: conversations.status,
      visibility: conversations.visibility,
      messageCount: conversations.messageCount,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)),
    )
    .limit(1);

  if (conversation === undefined) {
    throw new PermanentJobError('Conversa inexistente para exportação.', {
      code: 'EXPORT_CONVERSATION_NOT_FOUND',
      details: { conversationId },
    });
  }

  const [participants, messageRows] = await Promise.all([
    db
      .select({
        participantType: conversationParticipants.participantType,
        participantId: conversationParticipants.participantId,
        role: conversationParticipants.role,
        joinedAt: conversationParticipants.joinedAt,
        leftAt: conversationParticipants.leftAt,
      })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId))
      .limit(MAX_ROWS),
    db
      .select({
        id: messages.id,
        sequence: messages.sequence,
        authorType: messages.authorType,
        authorUserId: messages.authorUserId,
        status: messages.status,
        createdAt: messages.createdAt,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.sequence)
      .limit(MAX_ROWS),
  ]);

  const messageIds = messageRows.map((row) => row.id);
  const parts =
    messageIds.length === 0
      ? []
      : await db
          .select({
            messageId: messageParts.messageId,
            sequence: messageParts.sequence,
            type: messageParts.type,
            content: messageParts.content,
            payload: messageParts.payload,
            toolName: messageParts.toolName,
          })
          .from(messageParts)
          .where(inArray(messageParts.messageId, messageIds))
          .limit(MAX_ROWS);

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
  const [user] = await db.select(userColumns).from(users).where(eq(users.id, userId)).limit(1);

  if (user === undefined) {
    throw new PermanentJobError('Usuário inexistente para exportação.', {
      code: 'EXPORT_USER_NOT_FOUND',
      details: { userId },
    });
  }

  const [identities, deviceRows, memberships] = await Promise.all([
    db
      .select({
        provider: userIdentities.provider,
        providerAccountId: userIdentities.providerAccountId,
        createdAt: userIdentities.createdAt,
      })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .limit(MAX_ROWS),
    db.select(deviceColumns).from(devices).where(eq(devices.userId, userId)).limit(MAX_ROWS),
    db
      .select({
        organizationId: organizationMembers.organizationId,
        roleId: organizationMembers.roleId,
        status: organizationMembers.status,
        createdAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.organizationId, organizationId),
        ),
      )
      .limit(MAX_ROWS),
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

  const [row] = await db
    .select({
      id: dataExportJobs.id,
      status: dataExportJobs.status,
      scope: dataExportJobs.scope,
      scopeId: dataExportJobs.scopeId,
      format: dataExportJobs.format,
    })
    .from(dataExportJobs)
    .where(
      and(
        eq(dataExportJobs.id, exportJobId),
        eq(dataExportJobs.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (row === undefined) {
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

  const claim = await db
    .update(dataExportJobs)
    .set({ status: 'running', startedAt: now, version: sql`${dataExportJobs.version} + 1` })
    .where(
      and(
        eq(dataExportJobs.id, exportJobId),
        or(
          inArray(dataExportJobs.status, ['pending', 'scheduled', 'failed']),
          and(
            eq(dataExportJobs.status, 'running'),
            lt(dataExportJobs.updatedAt, new Date(now.getTime() - STALE_RUNNING_MS)),
          ),
        ),
      ),
    );

  if (claim[0].affectedRows === 0) {
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
    await db
      .update(dataExportJobs)
      .set({
        status: 'completed',
        storageKey,
        sizeBytes: body.byteLength,
        downloadExpiresAt: new Date(completedAt.getTime() + input.downloadTtlMs),
        completedAt,
        errorMessage: null,
        version: sql`${dataExportJobs.version} + 1`,
      })
      .where(eq(dataExportJobs.id, exportJobId));

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
    await db
      .update(dataExportJobs)
      .set({
        status: permanent ? 'failed' : 'pending',
        errorMessage: message.slice(0, 2_000),
        version: sql`${dataExportJobs.version} + 1`,
      })
      .where(eq(dataExportJobs.id, exportJobId));
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
