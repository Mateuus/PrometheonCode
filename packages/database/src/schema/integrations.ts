// Integrações externas: Git, webhooks e servidores MCP.
//
// SEGREDOS — regra do `Docs/09`:
// Token de provedor Git nunca é gravado em texto puro. O que fica no banco é o
// resultado do envelope encryption: `*_ciphertext` (dados cifrados com a DEK),
// `*_iv`, `*_auth_tag` e `*_key_id` (qual versão da chave mestre embrulhou a
// DEK). A chave mestre vive fora do banco, em `SECRETS_MASTER_KEY`, e a
// rotação troca o `key_id` sem tocar no schema. Quem cifra e decifra é a
// aplicação; o MySQL só armazena bytes opacos.

import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varbinary,
  varchar,
} from 'drizzle-orm/mysql-core';

import { organizations } from './organization.js';
import {
  auditColumns,
  organizationId,
  primaryId,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
} from './columns.js';

export const gitProvider = ['github', 'gitlab', 'bitbucket', 'azure_devops'] as const;
/** Forma da credencial: instalação oficial do provedor é a preferida. */
export const gitConnectionKind = ['app_installation', 'oauth', 'personal_access_token'] as const;
export const gitConnectionStatus = ['active', 'revoked', 'error', 'expired'] as const;

export const gitConnections = mysqlTable(
  'git_connections',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    provider: mysqlEnum('provider', gitProvider).notNull(),
    kind: mysqlEnum('kind', gitConnectionKind).notNull().default('app_installation'),
    accountLogin: varchar('account_login', { length: 191 }).notNull(),
    externalAccountId: varchar('external_account_id', { length: 191 }).notNull(),
    installationId: varchar('installation_id', { length: 191 }),
    status: mysqlEnum('status', gitConnectionStatus).notNull().default('active'),
    scopes: json('scopes').$type<string[]>(),
    // --- envelope encryption (ver cabeçalho do arquivo) ---
    credentialCiphertext: varbinary('credential_ciphertext', { length: 4096 }),
    credentialIv: varbinary('credential_iv', { length: 16 }),
    credentialAuthTag: varbinary('credential_auth_tag', { length: 16 }),
    credentialKeyId: varchar('credential_key_id', { length: 64 }),
    credentialAlgorithm: varchar('credential_algorithm', { length: 32 }),
    credentialRotatedAt: utcDatetime('credential_rotated_at'),
    credentialExpiresAt: utcDatetime('credential_expires_at'),
    lastUsedAt: utcDatetime('last_used_at'),
    lastErrorMessage: varchar('last_error_message', { length: 512 }),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_git_connections_account').on(
      table.organizationId,
      table.provider,
      table.externalAccountId,
    ),
    index('idx_git_connections_org_created_at').on(table.organizationId, table.createdAt),
  ],
);

export const gitRepositories = mysqlTable(
  'git_repositories',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    gitConnectionId: ulidColumn('git_connection_id')
      .notNull()
      .references(() => gitConnections.id, { onDelete: 'cascade' }),
    provider: mysqlEnum('provider', gitProvider).notNull(),
    externalId: varchar('external_id', { length: 191 }).notNull(),
    owner: varchar('owner', { length: 191 }).notNull(),
    name: varchar('name', { length: 191 }).notNull(),
    fullName: varchar('full_name', { length: 383 }).notNull(),
    defaultBranch: varchar('default_branch', { length: 191 }).notNull().default('main'),
    isPrivate: boolean('is_private').notNull().default(true),
    cloneUrl: varchar('clone_url', { length: 1024 }),
    htmlUrl: varchar('html_url', { length: 1024 }),
    // Segredo do webhook, também por envelope encryption.
    webhookSecretCiphertext: varbinary('webhook_secret_ciphertext', { length: 1024 }),
    webhookSecretIv: varbinary('webhook_secret_iv', { length: 16 }),
    webhookSecretAuthTag: varbinary('webhook_secret_auth_tag', { length: 16 }),
    webhookSecretKeyId: varchar('webhook_secret_key_id', { length: 64 }),
    lastSyncedAt: utcDatetime('last_synced_at'),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_git_repositories_external').on(table.gitConnectionId, table.externalId),
    index('idx_git_repositories_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_git_repositories_full_name').on(table.fullName),
  ],
);

export const webhookDeliveryStatus = [
  'received',
  'processing',
  'processed',
  'failed',
  'skipped',
] as const;

export const webhookDeliveries = mysqlTable(
  'webhook_deliveries',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    gitConnectionId: ulidColumn('git_connection_id').references(() => gitConnections.id, {
      onDelete: 'set null',
    }),
    gitRepositoryId: ulidColumn('git_repository_id').references(() => gitRepositories.id, {
      onDelete: 'set null',
    }),
    provider: mysqlEnum('provider', gitProvider).notNull(),
    // ID da entrega no provedor: é a chave de deduplicação da fila `webhooks`.
    externalDeliveryId: varchar('external_delivery_id', { length: 191 }).notNull(),
    eventType: varchar('event_type', { length: 96 }).notNull(),
    signatureValid: boolean('signature_valid').notNull().default(false),
    status: mysqlEnum('status', webhookDeliveryStatus).notNull().default('received'),
    attempts: int('attempts').notNull().default(0),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    receivedAt: utcDatetime('received_at').notNull(),
    processedAt: utcDatetime('processed_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_webhook_deliveries_external').on(table.provider, table.externalDeliveryId),
    index('idx_webhook_deliveries_org_created_at').on(table.organizationId, table.createdAt),
    index('idx_webhook_deliveries_status_received').on(table.status, table.receivedAt),
  ],
);

export const mcpTransport = ['stdio', 'http', 'sse', 'websocket'] as const;
export const mcpEntryStatus = ['active', 'disabled'] as const;
/** Quanto o servidor MCP pode fazer sem aprovação explícita. */
export const mcpTrustLevel = ['trusted', 'restricted', 'blocked'] as const;

export const mcpRegistryEntries = mysqlTable(
  'mcp_registry_entries',
  {
    id: primaryId(),
    organizationId: organizationId().references(() => organizations.id, { onDelete: 'cascade' }),
    // Sem chave estrangeira para `projects` de propósito: `projects` referencia
    // `git_repositories` deste arquivo e a ida e volta criaria dependência
    // circular entre os módulos do schema. A integridade fica com a aplicação.
    projectId: ulidColumn('project_id'),
    slug: varchar('slug', { length: 96 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    description: varchar('description', { length: 512 }),
    transport: mysqlEnum('transport', mcpTransport).notNull().default('stdio'),
    command: varchar('command', { length: 512 }),
    url: varchar('url', { length: 1024 }),
    args: json('args').$type<string[]>(),
    // Apenas os NOMES das variáveis de ambiente exigidas. Valor de segredo
    // jamais entra aqui — quem resolve é o Core local, na máquina do usuário.
    envKeys: json('env_keys').$type<string[]>(),
    scopes: json('scopes').$type<string[]>(),
    trustLevel: mysqlEnum('trust_level', mcpTrustLevel).notNull().default('restricted'),
    status: mysqlEnum('status', mcpEntryStatus).notNull().default('active'),
    config: json('config').$type<Record<string, unknown>>(),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_mcp_registry_entries_slug').on(table.organizationId, table.slug),
    index('idx_mcp_registry_entries_project').on(table.projectId, table.status),
  ],
);
