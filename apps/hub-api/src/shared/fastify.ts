/**
 * Tipos que a aplicação acrescenta ao Fastify.
 *
 * Toda decoração de `FastifyInstance` e de `FastifyRequest` é declarada aqui, em
 * um lugar só: assim o compilador reprova quem usar `app.db` antes de o plugin
 * do banco ter sido registrado, em vez de descobrir isso em runtime.
 */

import type { Database } from '@prometheon/database';
import type { Permission, Role } from '@prometheon/permissions';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'mysql2/promise';

import type { AppConfig } from '../config/index.js';
import type { MailService } from '../mail/types.js';
import type { RedisClient } from '../plugins/redis.js';

/** Origem da credencial apresentada na requisição. */
export type PrincipalKind = 'user' | 'device';

/**
 * Quem está chamando.
 *
 * `sessionId` é nulo quando a credencial é de dispositivo: o device flow emite
 * um token de longa duração ligado ao dispositivo, não a uma sessão de
 * navegador. `deviceId` é o espelho disso.
 */
export interface AuthContext {
  readonly kind: PrincipalKind;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  /** Ações que mudam estado exigem endereço confirmado. */
  readonly emailVerified: boolean;
  readonly sessionId: string | null;
  readonly deviceId: string | null;
  /** Organização ativa da credencial, quando houver. */
  readonly organizationId: string | null;
}

/** Resultado da autorização, anexado à requisição por `requirePermission`. */
export interface AccessContext {
  readonly organizationId: string;
  readonly role: Role;
  readonly permission: Permission;
}

export type PermissionGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export interface RequirePermissionOptions {
  /**
   * Como descobrir a organização da rota. O padrão lê `:orgId` dos parâmetros e,
   * na falta dele, usa a organização ativa da credencial.
   */
  readonly resolveOrganizationId?: (request: FastifyRequest) => Promise<string | null> | string | null;
  /** Recurso registrado na auditoria quando a autorização é negada. */
  readonly resourceType?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly appConfig: AppConfig;
    readonly db: Database;
    readonly pool: Pool;
    readonly redis: RedisClient;
    readonly mailer: MailService;
    /** Exige uma credencial válida; popula `request.auth`. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Autentica e resolve a autorização com `authorize()` de `@prometheon/permissions`. */
    requirePermission: (
      permission: Permission,
      options?: RequirePermissionOptions,
    ) => PermissionGuard;
  }

  interface FastifyRequest {
    /** Preenchido por `authenticate`. */
    auth?: AuthContext;
    /** Preenchido por `requirePermission`. */
    access?: AccessContext;
  }
}
