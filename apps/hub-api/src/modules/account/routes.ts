/**
 * Rotas da própria conta.
 *
 * | Rota                          | Quem passa                          |
 * | ----------------------------- | ----------------------------------- |
 * | `GET /me/sessions`            | qualquer credencial autenticada     |
 * | `DELETE /sessions/:sessionId` | o dono da sessão, e só ele          |
 * | `GET /me/devices`             | qualquer credencial autenticada     |
 * | `DELETE /devices/:deviceId`   | o dono do dispositivo, e só ele     |
 * | `POST /me/password`           | quem souber a senha atual           |
 * | `PATCH /me`                   | qualquer credencial autenticada     |
 *
 * Todas usam `app.authenticate` e **nenhuma** usa `requirePermission`: o recurso
 * aqui é a própria conta, não uma organização. Exigir associação ativa
 * impediria alguém sem organização — ou com o e-mail ainda não confirmado — de
 * trocar a própria senha, que é justamente o que essa pessoa pode precisar
 * fazer com urgência. O escopo é garantido de outro jeito: o `userId` da
 * credencial entra em toda consulta.
 *
 * `PATCH /me` mora aqui e `GET /me` mora em `modules/auth/routes.ts`. São
 * assuntos diferentes no mesmo caminho — ler a sessão é autenticação, editar o
 * perfil é conta — e o Fastify roteia por método sem ambiguidade.
 */

import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { cookieProfile, PAYLOAD_LIMITS, RATE_LIMITS } from '../../config/index.js';
import { enforceRateLimit } from '../../plugins/rate-limit.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import {
  accountErrorResponses,
  changePasswordEnvelope,
  changePasswordRequestSchema,
  deviceListEnvelope,
  deviceParamsSchema,
  profileEnvelope,
  revokeDeviceEnvelope,
  revokeSessionEnvelope,
  sessionListQuerySchema,
  sessionPageEnvelope,
  sessionParamsSchema,
  updateProfileRequestSchema,
} from './schemas.js';
import type { AccountService } from './service.js';

export interface AccountRoutesOptions {
  readonly service: AccountService;
}

export const accountRoutes: FastifyPluginCallbackZod<AccountRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { service } = options;
  const cookies = cookieProfile(app.appConfig);

  app.get(
    '/me/sessions',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'List the live sessions of this account',
        description:
          'One entry per session that can still be used. The entry that made this call is flagged with `current`. The client label is derived and the IP address is truncated to the network.',
        security: [{ bearerAuth: [] }],
        querystring: sessionListQuerySchema,
        response: { 200: sessionPageEnvelope, ...accountErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      return ok(
        request,
        await service.listSessions({
          userId: auth.userId,
          currentSessionId: auth.sessionId,
          cursor: request.query.cursor,
          limit: request.query.limit,
        }),
      );
    },
  );

  app.delete(
    '/sessions/:sessionId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Revoke one session of this account',
        description:
          'The refresh token of that session stops working immediately, and so does any access token it issued. A session that belongs to somebody else answers 404, the same as one that does not exist.',
        security: [{ bearerAuth: [] }],
        params: sessionParamsSchema,
        response: { 200: revokeSessionEnvelope, ...accountErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const origin = requestOrigin(request);
      const result = await service.revokeSession({
        userId: auth.userId,
        sessionId: request.params.sessionId,
        currentSessionId: auth.sessionId,
        origin,
      });

      // A pessoa acabou de derrubar a própria sessão: o cookie de refresh que
      // sobrou no navegador não vale mais nada e só produziria um 401 confuso na
      // próxima navegação.
      if (result.current) {
        void reply.clearCookie(cookies.refreshName, {
          httpOnly: true,
          secure: cookies.secure,
          sameSite: cookies.sameSite,
          path: cookies.path,
        });
      }

      if (auth.organizationId !== null) {
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          actorType: auth.kind === 'device' ? 'device' : 'user',
          actorId: auth.userId,
          actorLabel: auth.email,
          action: 'account.session.revoked',
          resourceType: 'session',
          resourceId: request.params.sessionId,
          requestId: request.id,
          ip: origin.ip,
          userAgent: origin.userAgent,
          metadata: { current: result.current },
        });
      }

      return ok(request, result);
    },
  );

  app.get(
    '/me/devices',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'List the devices connected to this account',
        description:
          'One entry per device whose credential can still be used. Shown next to the sessions because both answer the same question: where am I signed in?',
        security: [{ bearerAuth: [] }],
        response: { 200: deviceListEnvelope, ...accountErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      return ok(request, { items: await service.listDevices(auth.userId) });
    },
  );

  app.delete(
    '/devices/:deviceId',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Disconnect one device from this account',
        description:
          'Takes effect on the next request the device makes: its credential is checked against the database every time, so nothing keeps working until it expires. A device that belongs to somebody else answers 404, the same as one that does not exist.',
        security: [{ bearerAuth: [] }],
        params: deviceParamsSchema,
        response: { 200: revokeDeviceEnvelope, ...accountErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const origin = requestOrigin(request);

      await service.revokeDevice({
        userId: auth.userId,
        deviceId: request.params.deviceId,
        origin,
      });

      if (auth.organizationId !== null) {
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          actorType: auth.kind === 'device' ? 'device' : 'user',
          actorId: auth.userId,
          actorLabel: auth.email,
          action: 'account.device.revoked',
          resourceType: 'device',
          resourceId: request.params.deviceId,
          requestId: request.id,
          ip: origin.ip,
          userAgent: origin.userAgent,
        });
      }

      return ok(request, { revoked: true });
    },
  );

  app.post(
    '/me/password',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Change the password from inside the session',
        description:
          'Requires the current password. Every other session of the account is revoked and every device is disconnected; the session making the call survives.',
        security: [{ bearerAuth: [] }],
        body: changePasswordRequestSchema,
        response: { 200: changePasswordEnvelope, ...accountErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      // Teto por conta, e não por IP: quem tem o token roubado não precisa
      // manter o mesmo endereço para tentar senhas.
      await enforceRateLimit(
        app.redis,
        `password-change:${auth.userId}`,
        RATE_LIMITS.passwordChange,
        'Too many password change attempts for this account.',
      );

      const origin = requestOrigin(request);
      const result = await service.changePassword({
        userId: auth.userId,
        currentSessionId: auth.sessionId,
        currentPassword: request.body.currentPassword,
        newPassword: request.body.newPassword,
        origin,
      });

      if (auth.organizationId !== null) {
        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          actorType: auth.kind === 'device' ? 'device' : 'user',
          actorId: auth.userId,
          actorLabel: auth.email,
          action: 'account.password.changed',
          resourceType: 'user',
          resourceId: auth.userId,
          requestId: request.id,
          ip: origin.ip,
          userAgent: origin.userAgent,
          // Nem a senha nova nem a antiga, obviamente; o que interessa auditar é
          // o efeito colateral, que é quanta gente foi desconectada.
          metadata: { revokedSessions: result.revokedSessions },
        });
      }

      return ok(request, result);
    },
  );

  app.patch(
    '/me',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Edit your own profile',
        description:
          'Partial update: absent fields keep their value. The email address is not editable here — changing it requires verifying the new address first.',
        security: [{ bearerAuth: [] }],
        body: updateProfileRequestSchema,
        response: { 200: profileEnvelope, ...accountErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      const result = await service.updateProfile(auth.userId, request.body);

      if (auth.organizationId !== null) {
        const origin = requestOrigin(request);

        await recordAudit(app.db, {
          organizationId: auth.organizationId,
          actorType: auth.kind === 'device' ? 'device' : 'user',
          actorId: auth.userId,
          actorLabel: auth.email,
          action: 'account.profile.updated',
          resourceType: 'user',
          resourceId: auth.userId,
          requestId: request.id,
          ip: origin.ip,
          userAgent: origin.userAgent,
          // Os nomes dos campos, não os valores: auditoria não é um histórico
          // de dados pessoais.
          metadata: { fields: Object.keys(request.body).sort() },
        });
      }

      return ok(request, result);
    },
  );

  done();
};
