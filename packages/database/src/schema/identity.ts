// Identidade: quem é o usuário, como ele prova isso e de quais máquinas.
//
// Nada aqui guarda segredo em texto puro. Senha é hash Argon2id, refresh token
// é hash SHA-256 e credencial de dispositivo idem — o valor original só existe
// no cliente, uma única vez, no momento da emissão.

import { index, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

import {
  auditColumns,
  deletedAt,
  primaryId,
  timestamps,
  ulidColumn,
  utcDatetime,
  version,
} from './columns.js';

/** Situação da conta dentro do Hub. */
export const userStatus = ['pending', 'active', 'suspended', 'disabled'] as const;

export const users = mysqlTable(
  'users',
  {
    id: primaryId(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerifiedAt: utcDatetime('email_verified_at'),
    // Argon2id (`Docs/09`). Nulo enquanto a conta só existe por convite ou
    // quando o acesso vem exclusivamente de um provedor externo.
    passwordHash: varchar('password_hash', { length: 255 }),
    passwordUpdatedAt: utcDatetime('password_updated_at'),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    avatarUrl: varchar('avatar_url', { length: 1024 }),
    locale: varchar('locale', { length: 16 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    status: mysqlEnum('status', userStatus).notNull().default('pending'),
    lastLoginAt: utcDatetime('last_login_at'),
    ...timestamps(),
    version: version(),
    // Exclusão de conta tem janela de recuperação (`deletion_jobs`).
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('uq_users_email').on(table.email),
    index('idx_users_status_created_at').on(table.status, table.createdAt),
  ],
);

/** Provedores de identidade aceitos. `password` é a credencial local. */
export const identityProvider = ['password', 'github', 'google', 'gitlab', 'oidc'] as const;

export const userIdentities = mysqlTable(
  'user_identities',
  {
    id: primaryId(),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: mysqlEnum('provider', identityProvider).notNull(),
    // Identificador da conta no provedor. Nunca guardamos o token do provedor
    // aqui: integrações com credencial vivem em `git_connections`, cifradas.
    providerAccountId: varchar('provider_account_id', { length: 191 }).notNull(),
    email: varchar('email', { length: 320 }),
    displayName: varchar('display_name', { length: 160 }),
    lastAuthenticatedAt: utcDatetime('last_authenticated_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_user_identities_provider_account').on(table.provider, table.providerAccountId),
    index('idx_user_identities_user').on(table.userId, table.provider),
  ],
);

/** Plataforma declarada pelo dispositivo no registro. */
export const devicePlatform = ['windows', 'macos', 'linux', 'web', 'other'] as const;
/** Ciclo de vida do dispositivo no device authorization flow do `Docs/09`. */
export const deviceStatus = ['pending', 'active', 'revoked', 'expired'] as const;

export const devices = mysqlTable(
  'devices',
  {
    id: primaryId(),
    // Dispositivo pertence a uma pessoa, não a uma organização: o alcance vem
    // das associações ativas do usuário. Por isso não há `organization_id`.
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 160 }).notNull(),
    platform: mysqlEnum('platform', devicePlatform).notNull().default('other'),
    client: varchar('client', { length: 64 }).notNull().default('extension'),
    clientVersion: varchar('client_version', { length: 32 }),
    // Impressão estável enviada pelo cliente para reconhecer a mesma máquina.
    fingerprint: varchar('fingerprint', { length: 128 }),
    status: mysqlEnum('status', deviceStatus).notNull().default('pending'),
    approvedAt: utcDatetime('approved_at'),
    revokedAt: utcDatetime('revoked_at'),
    lastSeenAt: utcDatetime('last_seen_at'),
    lastIp: varchar('last_ip', { length: 45 }),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_devices_user_fingerprint').on(table.userId, table.fingerprint),
    index('idx_devices_user_status').on(table.userId, table.status, table.lastSeenAt),
  ],
);

/** Tipos de credencial emitidos para um dispositivo. */
export const deviceTokenType = ['device_code', 'device_credential'] as const;

export const deviceTokens = mysqlTable(
  'device_tokens',
  {
    id: primaryId(),
    deviceId: ulidColumn('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: ulidColumn('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', deviceTokenType).notNull(),
    // SEGREDO: apenas o SHA-256 hexadecimal do token. O valor puro é entregue
    // uma vez ao cliente e some daqui — comparar significa hashear de novo.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    // Código curto que a pessoa digita no navegador durante o device flow.
    userCode: varchar('user_code', { length: 16 }),
    scope: varchar('scope', { length: 512 }),
    expiresAt: utcDatetime('expires_at').notNull(),
    approvedAt: utcDatetime('approved_at'),
    consumedAt: utcDatetime('consumed_at'),
    revokedAt: utcDatetime('revoked_at'),
    revokedReason: varchar('revoked_reason', { length: 191 }),
    lastUsedAt: utcDatetime('last_used_at'),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    uniqueIndex('uq_device_tokens_hash').on(table.tokenHash),
    uniqueIndex('uq_device_tokens_user_code').on(table.userCode),
    index('idx_device_tokens_device_type').on(table.deviceId, table.type, table.expiresAt),
  ],
);

export const userSessions = mysqlTable(
  'user_sessions',
  {
    id: primaryId(),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: ulidColumn('device_id').references(() => devices.id, { onDelete: 'set null' }),
    // Organização ativa da sessão, quando houver. Sem chave estrangeira para
    // não criar dependência circular entre identidade e organização.
    organizationId: ulidColumn('organization_id'),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),
    expiresAt: utcDatetime('expires_at').notNull(),
    lastSeenAt: utcDatetime('last_seen_at'),
    revokedAt: utcDatetime('revoked_at'),
    revokedReason: varchar('revoked_reason', { length: 191 }),
    ...timestamps(),
    version: version(),
  },
  (table) => [
    index('idx_user_sessions_user_created_at').on(table.userId, table.createdAt),
    index('idx_user_sessions_expires_at').on(table.expiresAt),
  ],
);

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: primaryId(),
    sessionId: ulidColumn('session_id')
      .notNull()
      .references(() => userSessions.id, { onDelete: 'cascade' }),
    userId: ulidColumn('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SEGREDO: SHA-256 hexadecimal do refresh token, nunca o token.
    // O `Docs/09` exige rotação: cada uso emite um novo e marca o anterior
    // em `used_at`; reuso de um token já usado é incidente de segurança.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    previousTokenId: ulidColumn('previous_token_id'),
    // `created_at` é o instante de emissão; não há coluna separada para isso.
    expiresAt: utcDatetime('expires_at').notNull(),
    usedAt: utcDatetime('used_at'),
    revokedAt: utcDatetime('revoked_at'),
    revokedReason: varchar('revoked_reason', { length: 191 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex('uq_refresh_tokens_hash').on(table.tokenHash),
    index('idx_refresh_tokens_session').on(table.sessionId, table.createdAt),
    index('idx_refresh_tokens_user_created_at').on(table.userId, table.createdAt),
  ],
);
