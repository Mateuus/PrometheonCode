// Identidade: quem é o usuário, como ele prova isso e de quais máquinas.
//
// Nada aqui guarda segredo em texto puro. Senha é hash Argon2id, refresh token
// é hash SHA-256 e credencial de dispositivo idem — o valor original só existe
// no cliente, uma única vez, no momento da emissão.

import { EntitySchema } from 'typeorm';

import {
  auditColumns,
  deletedAt,
  enumColumn,
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

/** Situação da conta dentro do Hub. */
export const userStatus = ['pending', 'active', 'suspended', 'disabled'] as const;
export type UserStatus = (typeof userStatus)[number];

export interface User extends TimestampFields {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  passwordUpdatedAt: Date | null;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  timezone: string;
  status: UserStatus;
  lastLoginAt: Date | null;
  version: number;
  deletedAt: Date | null;
}

export const users = new EntitySchema<User>({
  name: 'users',
  tableName: 'users',
  columns: {
    id: primaryId(),
    email: requiredText('email', 320),
    emailVerifiedAt: utcDatetime('email_verified_at'),
    // Argon2id (`Docs/09`). Nulo enquanto a conta só existe por convite ou
    // quando o acesso vem exclusivamente de um provedor externo.
    passwordHash: text('password_hash', 255),
    passwordUpdatedAt: utcDatetime('password_updated_at'),
    displayName: requiredText('display_name', 160),
    avatarUrl: text('avatar_url', 1024),
    locale: requiredText('locale', 16, { default: 'en' }),
    timezone: requiredText('timezone', 64, { default: 'UTC' }),
    status: enumColumn('status', userStatus, { default: 'pending' }),
    lastLoginAt: utcDatetime('last_login_at'),
    ...timestamps(),
    version: version(),
    // Exclusão de conta tem janela de recuperação (`deletion_jobs`).
    deletedAt: deletedAt(),
  },
  uniques: [{ name: 'uq_users_email', columns: ['email'] }],
  indices: [{ name: 'idx_users_status_created_at', columns: ['status', 'createdAt'] }],
});

/** Provedores de identidade aceitos. `password` é a credencial local. */
export const identityProvider = ['password', 'github', 'google', 'gitlab', 'oidc'] as const;
export type IdentityProvider = (typeof identityProvider)[number];

export interface UserIdentity extends TimestampFields {
  id: string;
  userId: string;
  provider: IdentityProvider;
  providerAccountId: string;
  email: string | null;
  displayName: string | null;
  lastAuthenticatedAt: Date | null;
  version: number;
}

export const userIdentities = new EntitySchema<UserIdentity>({
  name: 'user_identities',
  tableName: 'user_identities',
  columns: {
    id: primaryId(),
    userId: requiredUlidColumn('user_id'),
    provider: enumColumn('provider', identityProvider),
    // Identificador da conta no provedor. Nunca guardamos o token do provedor
    // aqui: integrações com credencial vivem em `git_connections`, cifradas.
    providerAccountId: requiredText('provider_account_id', 191),
    email: text('email', 320),
    displayName: text('display_name', 160),
    lastAuthenticatedAt: utcDatetime('last_authenticated_at'),
    ...timestamps(),
    version: version(),
  },
  uniques: [
    { name: 'uq_user_identities_provider_account', columns: ['provider', 'providerAccountId'] },
  ],
  indices: [{ name: 'idx_user_identities_user', columns: ['userId', 'provider'] }],
});

/** Plataforma declarada pelo dispositivo no registro. */
export const devicePlatform = ['windows', 'macos', 'linux', 'web', 'other'] as const;
export type DevicePlatform = (typeof devicePlatform)[number];
/** Ciclo de vida do dispositivo no device authorization flow do `Docs/09`. */
export const deviceStatus = ['pending', 'active', 'revoked', 'expired'] as const;
export type DeviceStatus = (typeof deviceStatus)[number];

export interface Device extends TimestampFields {
  id: string;
  userId: string;
  name: string;
  platform: DevicePlatform;
  client: string;
  clientVersion: string | null;
  fingerprint: string | null;
  status: DeviceStatus;
  approvedAt: Date | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  lastIp: string | null;
  version: number;
}

export const devices = new EntitySchema<Device>({
  name: 'devices',
  tableName: 'devices',
  columns: {
    id: primaryId(),
    // Dispositivo pertence a uma pessoa, não a uma organização: o alcance vem
    // das associações ativas do usuário. Por isso não há `organization_id`.
    userId: requiredUlidColumn('user_id'),
    name: requiredText('name', 160),
    platform: enumColumn('platform', devicePlatform, { default: 'other' }),
    client: requiredText('client', 64, { default: 'extension' }),
    clientVersion: text('client_version', 32),
    // Impressão estável enviada pelo cliente para reconhecer a mesma máquina.
    fingerprint: text('fingerprint', 128),
    status: enumColumn('status', deviceStatus, { default: 'pending' }),
    approvedAt: utcDatetime('approved_at'),
    revokedAt: utcDatetime('revoked_at'),
    lastSeenAt: utcDatetime('last_seen_at'),
    lastIp: text('last_ip', 45),
    ...timestamps(),
    version: version(),
  },
  uniques: [{ name: 'uq_devices_user_fingerprint', columns: ['userId', 'fingerprint'] }],
  indices: [{ name: 'idx_devices_user_status', columns: ['userId', 'status', 'lastSeenAt'] }],
});

/** Tipos de credencial emitidos para um dispositivo. */
export const deviceTokenType = ['device_code', 'device_credential'] as const;
export type DeviceTokenType = (typeof deviceTokenType)[number];

export interface DeviceToken extends TimestampFields {
  id: string;
  deviceId: string;
  userId: string | null;
  type: DeviceTokenType;
  tokenHash: string;
  userCode: string | null;
  scope: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
  version: number;
}

export const deviceTokens = new EntitySchema<DeviceToken>({
  name: 'device_tokens',
  tableName: 'device_tokens',
  columns: {
    id: primaryId(),
    deviceId: requiredUlidColumn('device_id'),
    userId: ulidColumn('user_id'),
    type: enumColumn('type', deviceTokenType),
    // SEGREDO: apenas o SHA-256 hexadecimal do token. O valor puro é entregue
    // uma vez ao cliente e some daqui — comparar significa hashear de novo.
    tokenHash: requiredText('token_hash', 64),
    // Código curto que a pessoa digita no navegador durante o device flow.
    userCode: text('user_code', 16),
    scope: text('scope', 512),
    expiresAt: requiredUtcDatetime('expires_at'),
    approvedAt: utcDatetime('approved_at'),
    consumedAt: utcDatetime('consumed_at'),
    revokedAt: utcDatetime('revoked_at'),
    revokedReason: text('revoked_reason', 191),
    lastUsedAt: utcDatetime('last_used_at'),
    ...timestamps(),
    version: version(),
  },
  uniques: [
    { name: 'uq_device_tokens_hash', columns: ['tokenHash'] },
    { name: 'uq_device_tokens_user_code', columns: ['userCode'] },
  ],
  indices: [
    { name: 'idx_device_tokens_device_type', columns: ['deviceId', 'type', 'expiresAt'] },
  ],
});

export interface UserSession extends TimestampFields {
  id: string;
  userId: string;
  deviceId: string | null;
  organizationId: string | null;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  version: number;
}

export const userSessions = new EntitySchema<UserSession>({
  name: 'user_sessions',
  tableName: 'user_sessions',
  columns: {
    id: primaryId(),
    userId: requiredUlidColumn('user_id'),
    deviceId: ulidColumn('device_id'),
    // Organização ativa da sessão, quando houver. Sem chave estrangeira para
    // não criar dependência circular entre identidade e organização.
    organizationId: ulidColumn('organization_id'),
    ip: text('ip', 45),
    userAgent: text('user_agent', 512),
    expiresAt: requiredUtcDatetime('expires_at'),
    lastSeenAt: utcDatetime('last_seen_at'),
    revokedAt: utcDatetime('revoked_at'),
    revokedReason: text('revoked_reason', 191),
    ...timestamps(),
    version: version(),
  },
  indices: [
    { name: 'idx_user_sessions_user_created_at', columns: ['userId', 'createdAt'] },
    { name: 'idx_user_sessions_expires_at', columns: ['expiresAt'] },
  ],
});

export interface RefreshToken extends AuditFields {
  id: string;
  sessionId: string;
  userId: string;
  tokenHash: string;
  previousTokenId: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  ip: string | null;
  userAgent: string | null;
}

export const refreshTokens = new EntitySchema<RefreshToken>({
  name: 'refresh_tokens',
  tableName: 'refresh_tokens',
  columns: {
    id: primaryId(),
    sessionId: requiredUlidColumn('session_id'),
    userId: requiredUlidColumn('user_id'),
    // SEGREDO: SHA-256 hexadecimal do refresh token, nunca o token.
    // O `Docs/09` exige rotação: cada uso emite um novo e marca o anterior
    // em `used_at`; reuso de um token já usado é incidente de segurança.
    tokenHash: requiredText('token_hash', 64),
    previousTokenId: ulidColumn('previous_token_id'),
    // `created_at` é o instante de emissão; não há coluna separada para isso.
    expiresAt: requiredUtcDatetime('expires_at'),
    usedAt: utcDatetime('used_at'),
    revokedAt: utcDatetime('revoked_at'),
    revokedReason: text('revoked_reason', 191),
    ip: text('ip', 45),
    userAgent: text('user_agent', 512),
    ...auditColumns(),
  },
  uniques: [{ name: 'uq_refresh_tokens_hash', columns: ['tokenHash'] }],
  indices: [
    { name: 'idx_refresh_tokens_session', columns: ['sessionId', 'createdAt'] },
    { name: 'idx_refresh_tokens_user_created_at', columns: ['userId', 'createdAt'] },
  ],
});
