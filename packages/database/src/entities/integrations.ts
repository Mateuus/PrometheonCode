// Integrações externas: Git, webhooks e servidores MCP.
//
// SEGREDOS — regra do `Docs/09`:
// Token de provedor Git nunca é gravado em texto puro. O que fica no banco é o
// resultado do envelope encryption: `*_ciphertext` (dados cifrados com a DEK),
// `*_iv`, `*_auth_tag` e `*_key_id` (qual versão da chave mestre embrulhou a
// DEK). A chave mestre vive fora do banco, em `SECRETS_MASTER_KEY`, e a
// rotação troca o `key_id` sem tocar no schema. Quem cifra e decifra é a
// aplicação; o MySQL só armazena bytes opacos.

import { EntitySchema } from 'typeorm';

import {
  auditColumns,
  enumColumn,
  jsonColumn,
  organizationId,
  primaryId,
  requiredText,
  requiredUlidColumn,
  requiredUtcDatetime,
  text,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
  type AuditFields,
  type TimestampFields,
} from './columns.js';

export const gitProvider = ['github', 'gitlab', 'bitbucket', 'azure_devops'] as const;
export type GitProvider = (typeof gitProvider)[number];
/** Forma da credencial: instalação oficial do provedor é a preferida. */
export const gitConnectionKind = ['app_installation', 'oauth', 'personal_access_token'] as const;
export type GitConnectionKind = (typeof gitConnectionKind)[number];
export const gitConnectionStatus = ['active', 'revoked', 'error', 'expired'] as const;
export type GitConnectionStatus = (typeof gitConnectionStatus)[number];

/** Bytes opacos do envelope encryption. O driver devolve `Buffer`. */
function encryptedBytes(name: string, length: number) {
  return { type: 'varbinary' as const, name, length, nullable: true };
}

export interface GitConnection extends AuditFields {
  id: string;
  organizationId: string;
  provider: GitProvider;
  kind: GitConnectionKind;
  accountLogin: string;
  externalAccountId: string;
  installationId: string | null;
  status: GitConnectionStatus;
  scopes: string[] | null;
  credentialCiphertext: Buffer | null;
  credentialIv: Buffer | null;
  credentialAuthTag: Buffer | null;
  credentialKeyId: string | null;
  credentialAlgorithm: string | null;
  credentialRotatedAt: Date | null;
  credentialExpiresAt: Date | null;
  lastUsedAt: Date | null;
  lastErrorMessage: string | null;
}

export const gitConnections = new EntitySchema<GitConnection>({
  name: 'git_connections',
  tableName: 'git_connections',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    provider: enumColumn('provider', gitProvider),
    kind: enumColumn('kind', gitConnectionKind, { default: 'app_installation' }),
    accountLogin: requiredText('account_login', 191),
    externalAccountId: requiredText('external_account_id', 191),
    installationId: text('installation_id', 191),
    status: enumColumn('status', gitConnectionStatus, { default: 'active' }),
    scopes: jsonColumn('scopes'),
    // --- envelope encryption (ver cabeçalho do arquivo) ---
    credentialCiphertext: encryptedBytes('credential_ciphertext', 4096),
    credentialIv: encryptedBytes('credential_iv', 16),
    credentialAuthTag: encryptedBytes('credential_auth_tag', 16),
    credentialKeyId: text('credential_key_id', 64),
    credentialAlgorithm: text('credential_algorithm', 32),
    credentialRotatedAt: utcDatetime('credential_rotated_at'),
    credentialExpiresAt: utcDatetime('credential_expires_at'),
    lastUsedAt: utcDatetime('last_used_at'),
    lastErrorMessage: text('last_error_message', 512),
    ...auditColumns(),
  },
  uniques: [
    {
      name: 'uq_git_connections_account',
      columns: ['organizationId', 'provider', 'externalAccountId'],
    },
  ],
  indices: [
    { name: 'idx_git_connections_org_created_at', columns: ['organizationId', 'createdAt'] },
  ],
});

export interface GitRepository extends AuditFields {
  id: string;
  organizationId: string;
  gitConnectionId: string;
  provider: GitProvider;
  externalId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  cloneUrl: string | null;
  htmlUrl: string | null;
  webhookSecretCiphertext: Buffer | null;
  webhookSecretIv: Buffer | null;
  webhookSecretAuthTag: Buffer | null;
  webhookSecretKeyId: string | null;
  lastSyncedAt: Date | null;
}

export const gitRepositories = new EntitySchema<GitRepository>({
  name: 'git_repositories',
  tableName: 'git_repositories',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    gitConnectionId: requiredUlidColumn('git_connection_id'),
    provider: enumColumn('provider', gitProvider),
    externalId: requiredText('external_id', 191),
    owner: requiredText('owner', 191),
    name: requiredText('name', 191),
    fullName: requiredText('full_name', 383),
    defaultBranch: requiredText('default_branch', 191, { default: 'main' }),
    isPrivate: { type: 'boolean', name: 'is_private', nullable: false, default: true },
    cloneUrl: text('clone_url', 1024),
    htmlUrl: text('html_url', 1024),
    // Segredo do webhook, também por envelope encryption.
    webhookSecretCiphertext: encryptedBytes('webhook_secret_ciphertext', 1024),
    webhookSecretIv: encryptedBytes('webhook_secret_iv', 16),
    webhookSecretAuthTag: encryptedBytes('webhook_secret_auth_tag', 16),
    webhookSecretKeyId: text('webhook_secret_key_id', 64),
    lastSyncedAt: utcDatetime('last_synced_at'),
    ...auditColumns(),
  },
  uniques: [
    { name: 'uq_git_repositories_external', columns: ['gitConnectionId', 'externalId'] },
  ],
  indices: [
    { name: 'idx_git_repositories_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_git_repositories_full_name', columns: ['fullName'] },
  ],
});

export const webhookDeliveryStatus = [
  'received',
  'processing',
  'processed',
  'failed',
  'skipped',
] as const;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatus)[number];

export interface WebhookDelivery extends TimestampFields {
  id: string;
  organizationId: string;
  gitConnectionId: string | null;
  gitRepositoryId: string | null;
  provider: GitProvider;
  externalDeliveryId: string;
  eventType: string;
  signatureValid: boolean;
  status: WebhookDeliveryStatus;
  attempts: number;
  payloadHash: string;
  payload: Record<string, unknown> | null;
  errorMessage: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  version: number;
}

export const webhookDeliveries = new EntitySchema<WebhookDelivery>({
  name: 'webhook_deliveries',
  tableName: 'webhook_deliveries',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    gitConnectionId: ulidColumn('git_connection_id'),
    gitRepositoryId: ulidColumn('git_repository_id'),
    provider: enumColumn('provider', gitProvider),
    // ID da entrega no provedor: é a chave de deduplicação da fila `webhooks`.
    externalDeliveryId: requiredText('external_delivery_id', 191),
    eventType: requiredText('event_type', 96),
    signatureValid: { type: 'boolean', name: 'signature_valid', nullable: false, default: false },
    status: enumColumn('status', webhookDeliveryStatus, { default: 'received' }),
    attempts: { type: 'int', name: 'attempts', nullable: false, default: 0 },
    payloadHash: requiredText('payload_hash', 64),
    payload: jsonColumn('payload'),
    errorMessage: { type: 'text', name: 'error_message', nullable: true },
    receivedAt: requiredUtcDatetime('received_at'),
    processedAt: utcDatetime('processed_at'),
    ...timestamps(),
    version: version(),
  },
  uniques: [
    { name: 'uq_webhook_deliveries_external', columns: ['provider', 'externalDeliveryId'] },
  ],
  indices: [
    { name: 'idx_webhook_deliveries_org_created_at', columns: ['organizationId', 'createdAt'] },
    { name: 'idx_webhook_deliveries_status_received', columns: ['status', 'receivedAt'] },
  ],
});

export const mcpTransport = ['stdio', 'http', 'sse', 'websocket'] as const;
export type McpTransport = (typeof mcpTransport)[number];
export const mcpEntryStatus = ['active', 'disabled'] as const;
export type McpEntryStatus = (typeof mcpEntryStatus)[number];
/** Quanto o servidor MCP pode fazer sem aprovação explícita. */
export const mcpTrustLevel = ['trusted', 'restricted', 'blocked'] as const;
export type McpTrustLevel = (typeof mcpTrustLevel)[number];

export interface McpRegistryEntry extends AuditFields {
  id: string;
  organizationId: string;
  projectId: string | null;
  slug: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  url: string | null;
  args: string[] | null;
  envKeys: string[] | null;
  scopes: string[] | null;
  trustLevel: McpTrustLevel;
  status: McpEntryStatus;
  config: Record<string, unknown> | null;
}

export const mcpRegistryEntries = new EntitySchema<McpRegistryEntry>({
  name: 'mcp_registry_entries',
  tableName: 'mcp_registry_entries',
  columns: {
    id: primaryId(),
    organizationId: organizationId(),
    // Sem chave estrangeira para `projects` de propósito: `projects` referencia
    // `git_repositories` deste arquivo e a ida e volta criaria dependência
    // circular entre os módulos do schema. A integridade fica com a aplicação.
    projectId: ulidColumn('project_id'),
    slug: requiredText('slug', 96),
    name: requiredText('name', 160),
    description: text('description', 512),
    transport: enumColumn('transport', mcpTransport, { default: 'stdio' }),
    command: text('command', 512),
    url: text('url', 1024),
    args: jsonColumn('args'),
    // Apenas os NOMES das variáveis de ambiente exigidas. Valor de segredo
    // jamais entra aqui — quem resolve é o Core local, na máquina do usuário.
    envKeys: jsonColumn('env_keys'),
    scopes: jsonColumn('scopes'),
    trustLevel: enumColumn('trust_level', mcpTrustLevel, { default: 'restricted' }),
    status: enumColumn('status', mcpEntryStatus, { default: 'active' }),
    config: jsonColumn('config'),
    ...auditColumns(),
  },
  uniques: [{ name: 'uq_mcp_registry_entries_slug', columns: ['organizationId', 'slug'] }],
  indices: [{ name: 'idx_mcp_registry_entries_project', columns: ['projectId', 'status'] }],
});
