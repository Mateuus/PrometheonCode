/**
 * Autenticação e autorização na borda.
 *
 * Duas decorações:
 *
 * - `app.authenticate` — resolve a credencial (access token JWT ou credencial
 *   de dispositivo) e popula `request.auth`.
 * - `app.requirePermission(permission)` — autentica, descobre a organização da
 *   rota, carrega o papel do usuário e chama `authorize()` de
 *   `@prometheon/permissions`. **Rota sem uma destas duas é bug** (`Docs/09`
 *   pede teste de autorização por rota).
 *
 * A tabela de permissões não é reimplementada aqui: quem decide é o pacote, que
 * aplica a precedência organização → projeto → usuário → modo do chat → agente
 * e para na primeira negação.
 */

import { authorize, isRole, type Permission, type Role } from '@prometheon/permissions';
import { child } from '@prometheon/logger';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { RATE_LIMITS } from '../config/index.js';
import { AuthRepository } from '../modules/auth/repository.js';
import { isSessionDenied } from '../modules/auth/token-store.js';
import { DEVICE_TOKEN_PREFIX, verifyAccessToken } from '../modules/auth/tokens.js';
import { recordAudit, requestOrigin } from '../shared/audit.js';
import { hashToken } from '../shared/crypto.js';
import { forbidden, unauthenticated } from '../shared/errors.js';
import type { AuthContext, RequirePermissionOptions } from '../shared/fastify.js';
import { enforceRateLimit } from './rate-limit.js';

const logger = child('authz');

function readBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;

  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
    return undefined;
  }

  const value = header.slice(7).trim();

  return value === '' ? undefined : value;
}

export function registerAuth(app: FastifyInstance): void {
  const repository = new AuthRepository(app.db);

  async function resolveDeviceCredential(token: string): Promise<AuthContext> {
    const credential = await repository.findDeviceCredential(hashToken(token));

    if (credential === undefined) {
      throw unauthenticated('The device credential is not valid.', 'TOKEN_INVALID');
    }

    if (credential.revokedAt !== null || credential.deviceStatus === 'revoked') {
      throw unauthenticated('This device credential has been revoked.', 'DEVICE_REVOKED');
    }

    if (credential.expiresAt.getTime() <= Date.now()) {
      throw unauthenticated('The device credential has expired.', 'TOKEN_EXPIRED');
    }

    if (credential.userId === null) {
      throw unauthenticated('The device credential is not valid.', 'TOKEN_INVALID');
    }

    const user = await repository.findUserById(credential.userId);

    if (user === undefined || user.status === 'suspended' || user.status === 'disabled') {
      throw unauthenticated('The device credential is not valid.', 'TOKEN_INVALID');
    }

    await repository.touchDeviceCredential(credential.id, credential.deviceId);

    return {
      kind: 'device',
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerifiedAt !== null,
      sessionId: null,
      deviceId: credential.deviceId,
      // O escopo guarda a organização escolhida na autorização do dispositivo.
      organizationId: credential.scope,
      // Credencial de dispositivo nunca administra a plataforma: ela vive 90
      // dias num arquivo de máquina, e não é onde se decide o plano de ninguém.
      isPlatformAdmin: false,
    };
  }

  async function resolveAccessToken(token: string): Promise<AuthContext> {
    const claims = await verifyAccessToken(app.appConfig, token);

    // Revogação de sessão precisa alcançar um JWT que ainda não expirou. A
    // denylist no Redis é a checagem barata; se o Redis estiver fora, a
    // consulta ao banco assume — mais lenta, nunca menos correta.
    let denied: boolean;

    try {
      denied = await isSessionDenied(app.redis, claims.sessionId);
    } catch (error) {
      logger.warn({ err: error }, 'session denylist unavailable; falling back to the database');

      const session = await repository.findSession(claims.sessionId);

      denied = session?.revokedAt !== null;
    }

    if (denied) {
      throw unauthenticated('This session has been revoked. Sign in again.', 'SESSION_REVOKED');
    }

    const user = await repository.findUserById(claims.userId);

    if (user === undefined || user.status === 'suspended' || user.status === 'disabled') {
      throw unauthenticated('This session is no longer valid.', 'SESSION_REVOKED');
    }

    return {
      kind: 'user',
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerifiedAt !== null,
      sessionId: claims.sessionId,
      deviceId: null,
      organizationId: claims.organizationId,
      isPlatformAdmin: user.isPlatformAdmin,
    };
  }

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (request.auth !== undefined) {
      return;
    }

    const token = readBearer(request);

    if (token === undefined) {
      throw unauthenticated();
    }

    const auth = token.startsWith(DEVICE_TOKEN_PREFIX)
      ? await resolveDeviceCredential(token)
      : await resolveAccessToken(token);

    // Limite por usuário: complementa o limite por IP, que não distingue quem
    // está atrás de um NAT corporativo.
    await enforceRateLimit(
      app.redis,
      `user:${auth.userId}`,
      RATE_LIMITS.perUser,
      'Too many requests for this account.',
    );

    request.auth = auth;
  });

  /**
   * Portaria das rotas `/admin`.
   *
   * Autentica, exige a marca da conta e registra a negativa. A auditoria aqui
   * não tem organização: a tentativa é contra a plataforma, e prendê-la a um
   * tenant qualquer contaria a história errada.
   */
  app.decorate('requirePlatformAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);

    const auth = request.auth;

    if (auth === undefined) {
      throw unauthenticated();
    }

    if (!auth.isPlatformAdmin) {
      logger.warn({ userId: auth.userId, url: request.url }, 'platform administration denied');

      throw forbidden('This endpoint is restricted to platform administrators.', 'PERMISSION_DENIED');
    }
  });

  app.decorate(
    'requirePermission',
    (permission: Permission, options: RequirePermissionOptions = {}) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        await app.authenticate(request, reply);

        const auth = request.auth;

        if (auth === undefined) {
          throw unauthenticated();
        }

        const organizationId = await resolveOrganizationId(request, options);

        if (organizationId === null) {
          throw forbidden(
            'This request must target an organization.',
            'ORGANIZATION_ACCESS_DENIED',
          );
        }

        // Limite por organização: contém um tenant barulhento sem punir os
        // outros que compartilham o mesmo IP de saída.
        await enforceRateLimit(
          app.redis,
          `org:${organizationId}`,
          RATE_LIMITS.perOrganization,
          'Too many requests for this organization.',
        );

        const membership = await repository.findMembership(organizationId, auth.userId);
        const origin = requestOrigin(request);

        const deny = async (reason: string, code: 'ORGANIZATION_ACCESS_DENIED' | 'PERMISSION_DENIED' | 'EMAIL_NOT_VERIFIED'): Promise<never> => {
          await recordAudit(app.db, {
            organizationId,
            actorType: auth.kind === 'device' ? 'device' : 'user',
            actorId: auth.userId,
            actorLabel: auth.email,
            action: `authz.${permission}`,
            resourceType: options.resourceType ?? 'organization',
            resourceId: organizationId,
            result: 'denied',
            reason,
            requestId: request.id,
            ip: origin.ip,
            userAgent: origin.userAgent,
          });

          throw forbidden(reason, code);
        };

        if (membership?.status !== 'active') {
          await deny(
            'You do not have access to this organization.',
            'ORGANIZATION_ACCESS_DENIED',
          );
        }

        // Conta sem e-mail confirmado entra e olha o próprio perfil, mas não
        // age dentro de uma organização — é o que impede alguém de usar o
        // endereço de outra pessoa para entrar num tenant alheio.
        if (!auth.emailVerified) {
          await deny('Confirm your email address before continuing.', 'EMAIL_NOT_VERIFIED');
        }

        const roleSlug = membership?.roleSlug;

        if (!isRole(roleSlug)) {
          await deny('Your role in this organization is not recognized.', 'PERMISSION_DENIED');
        }

        const decision = authorize({
          permission,
          role: roleSlug as Role,
          ...toPolicyLayer(membership?.policy ?? null),
        });

        if (!decision.allowed) {
          logger.warn(
            { permission, layer: decision.layer, organizationId, userId: auth.userId },
            'authorization denied',
          );

          await deny(decision.reason, 'PERMISSION_DENIED');
        }

        request.access = {
          organizationId,
          role: roleSlug as Role,
          permission,
        };
      },
  );
}

/**
 * Descobre a organização alvo.
 *
 * A ordem importa: o `:orgId` da rota vence a organização ativa da credencial,
 * porque a rota é o que o usuário pediu explicitamente. Sem nenhum dos dois, a
 * autorização falha em vez de escolher uma organização por conta própria.
 */
async function resolveOrganizationId(
  request: FastifyRequest,
  options: RequirePermissionOptions,
): Promise<string | null> {
  if (options.resolveOrganizationId !== undefined) {
    return options.resolveOrganizationId(request);
  }

  const params = request.params as Record<string, string | undefined> | undefined;
  const fromRoute = params?.['orgId'];

  if (typeof fromRoute === 'string' && fromRoute !== '') {
    return fromRoute;
  }

  return request.auth?.organizationId ?? null;
}

/**
 * Converte `organizations.policy` no formato que `authorize()` espera.
 *
 * A coluna é JSON livre; só as chaves reconhecidas passam, e qualquer coisa
 * fora do formato é ignorada — política malformada não pode virar permissão
 * concedida por acidente.
 */
function toPolicyLayer(policy: Record<string, unknown> | null): {
  organizationPolicy?: { deny?: Permission[]; allow?: Permission[] };
} {
  if (policy === null || typeof policy !== 'object') {
    return {};
  }

  const deny = Array.isArray(policy['deny'])
    ? (policy['deny'] as unknown[]).filter((item): item is Permission => typeof item === 'string')
    : undefined;
  const allow = Array.isArray(policy['allow'])
    ? (policy['allow'] as unknown[]).filter((item): item is Permission => typeof item === 'string')
    : undefined;

  if (deny === undefined && allow === undefined) {
    return {};
  }

  return {
    organizationPolicy: {
      ...(deny === undefined ? {} : { deny }),
      ...(allow === undefined ? {} : { allow }),
    },
  };
}
