/** Tipos internos do módulo de autenticação. */

import type { Role } from '@prometheon/permissions';

/** Dados do cliente que acompanham a emissão de sessão e a auditoria. */
export interface RequestOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresIn: number;
  readonly organizationId: string | null;
}

export interface SessionOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: Role;
}

export interface PublicUserView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly avatarUrl: string | null;
}

export interface CurrentUserView extends PublicUserView {
  readonly emailVerified: boolean;
  readonly locale: string;
  readonly timeZone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Administra a plataforma; é o que faz a área `/admin` aparecer. */
  readonly isPlatformAdmin: boolean;
}

/** Estado do device flow, guardado no Redis enquanto o usuário decide. */
export interface DeviceFlowState {
  readonly deviceName: string;
  readonly deviceKind: 'vscode' | 'cli' | 'ci' | 'other';
  readonly platform: string | null;
  readonly clientVersion: string | null;
  readonly userCode: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly status: 'pending' | 'approved' | 'denied';
  /** Preenchidos quando o usuário aprova. */
  readonly userId?: string;
  readonly organizationId?: string;
}
