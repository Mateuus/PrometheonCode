/**
 * Rotas de autenticação.
 *
 * Duas coisas que valem para o arquivo inteiro:
 *
 * - **Onde o refresh token viaja.** Se a chamada vem de um navegador (tem
 *   `Origin` e essa origem está na lista do CORS), o refresh sai só no cookie
 *   `HttpOnly` e é omitido do corpo — script na página não deve conseguir lê-lo.
 *   Chamadas sem `Origin` (extensão, CLI, `curl`) recebem o valor no corpo,
 *   porque não têm cookie jar nem precisam de um.
 * - **Status uniforme nos fluxos que aceitam e-mail.** Registro, reenvio de
 *   verificação e pedido de recuperação respondem `202` sempre.
 */

import type { FastifyReply } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { cookieProfile, PAYLOAD_LIMITS, RATE_LIMITS } from '../../config/index.js';
import { emailScopedKey, enforceRateLimit, routeRateLimit } from '../../plugins/rate-limit.js';
import { recordAudit, requestOrigin } from '../../shared/audit.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import {
  authErrorResponses,
  deviceAuthorizationEnvelope,
  deviceAuthorizationRequestSchema,
  deviceCredentialEnvelope,
  deviceDecisionEnvelope,
  deviceDecisionRequestSchema,
  deviceTokenRequestSchema,
  deviceVerificationEnvelope,
  emptyEnvelope,
  errorResponses,
  loginEnvelope,
  loginRequestSchema,
  logoutRequestSchema,
  meEnvelope,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshEnvelope,
  refreshRequestSchema,
  registerEnvelope,
  registerRequestSchema,
  verifyEmailEnvelope,
  verifyEmailRequestSchema,
} from './schemas.js';
import { type AuthService, toCurrentUser } from './service.js';
import { AuthRepository } from './repository.js';
import type { IssuedSession } from './types.js';

export interface AuthRoutesOptions {
  readonly service: AuthService;
}

// Plugin síncrono: registrar rota não espera nada. `FastifyPluginCallbackZod`
// é a forma que o Fastify oferece para isso — `async` sem `await` só
// esconderia que não há trabalho assíncrono aqui.
export const authRoutes: FastifyPluginCallbackZod<AuthRoutesOptions> = (app, options, done) => {
  const { service } = options;
  const cookies = cookieProfile(app.appConfig);
  const repository = new AuthRepository(app.db);
  const allowedOrigins = new Set(app.appConfig.http.corsOrigins);

  /** Verdadeiro quando a chamada veio de uma página do Hub Web. */
  function isBrowserClient(origin: string | undefined): boolean {
    return typeof origin === 'string' && origin !== '' && allowedOrigins.has(origin);
  }

  function setRefreshCookie(reply: FastifyReply, session: IssuedSession): void {
    void reply.setCookie(cookies.refreshName, session.refreshToken, {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: cookies.sameSite,
      path: cookies.path,
      maxAge: session.refreshExpiresIn,
    });
  }

  function clearRefreshCookie(reply: FastifyReply): void {
    void reply.clearCookie(cookies.refreshName, {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: cookies.sameSite,
      path: cookies.path,
    });
  }

  /** Monta o par de tokens, omitindo o refresh quando ele foi para o cookie. */
  function tokenPair(session: IssuedSession, useCookie: boolean) {
    return {
      tokenType: 'Bearer' as const,
      accessToken: session.accessToken,
      expiresIn: session.accessExpiresIn,
      ...(useCookie
        ? {}
        : {
            refreshToken: session.refreshToken,
            refreshExpiresIn: session.refreshExpiresIn,
          }),
    };
  }

  // -------------------------------------------------------------------------
  // Registro e verificação
  // -------------------------------------------------------------------------

  app.post(
    '/auth/register',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.register),
      schema: {
        tags: ['auth'],
        summary: 'Create an account',
        description:
          'Always answers 202 with the same body, whether or not the address is already registered.',
        body: registerRequestSchema,
        response: { 202: registerEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await service.register(request.body, requestOrigin(request));

      return reply.code(202).send(ok(request, result));
    },
  );

  app.post(
    '/auth/verify-email',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.emailVerification),
      schema: {
        tags: ['auth'],
        summary: 'Confirm an email address',
        body: verifyEmailRequestSchema,
        response: { 200: verifyEmailEnvelope, ...authErrorResponses },
      },
    },
    async (request) => {
      const { userId } = await service.verifyEmail(request.body.token);
      const user = await repository.findUserById(userId);

      if (user === undefined) {
        throw unauthenticated('The account no longer exists.', 'TOKEN_INVALID');
      }

      return ok(request, { user: toCurrentUser(user) });
    },
  );

  app.post(
    '/auth/resend-verification',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.emailVerification),
      schema: {
        tags: ['auth'],
        summary: 'Send the verification email again',
        body: z.object({ email: registerRequestSchema.shape.email }),
        response: { 202: emptyEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      await enforceRateLimit(
        app.redis,
        emailScopedKey(request, 'resend', request.body.email),
        RATE_LIMITS.passwordResetPerEmail,
        'Too many verification emails were requested for this address.',
      );
      await service.resendVerification(request.body.email);

      return reply.code(202).send(ok(request, {}));
    },
  );

  // -------------------------------------------------------------------------
  // Login, refresh, logout
  // -------------------------------------------------------------------------

  app.post(
    '/auth/login',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.loginPerIp),
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        body: loginRequestSchema,
        response: { 200: loginEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      // Teto por conta, além do teto por IP que o plugin já aplicou.
      await enforceRateLimit(
        app.redis,
        emailScopedKey(request, 'login', request.body.email),
        RATE_LIMITS.loginPerEmail,
        'Too many sign-in attempts for this account.',
      );

      const result = await service.login(request.body, requestOrigin(request));
      const useCookie = isBrowserClient(request.headers.origin);

      if (useCookie) {
        setRefreshCookie(reply, result.session);
      }

      if (result.session.organizationId !== null) {
        const origin = requestOrigin(request);

        await recordAudit(app.db, {
          organizationId: result.session.organizationId,
          actorType: 'user',
          actorId: result.user.id,
          actorLabel: result.user.email,
          action: 'auth.login',
          resourceType: 'session',
          resourceId: result.session.sessionId,
          requestId: request.id,
          ip: origin.ip,
          userAgent: origin.userAgent,
        });
      }

      return ok(request, {
        user: result.user,
        tokens: tokenPair(result.session, useCookie),
        sessionId: result.session.sessionId,
      });
    },
  );

  app.post(
    '/auth/refresh',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.refresh),
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh token',
        description:
          'Reusing a refresh token revokes the whole family: every token of that session stops working.',
        body: refreshRequestSchema,
        response: { 200: refreshEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const fromCookie = request.cookies[cookies.refreshName];
      const token = request.body.refreshToken ?? fromCookie;

      if (token === undefined || token === '') {
        throw unauthenticated('No refresh token was provided.', 'TOKEN_INVALID');
      }

      const { session } = await service.refresh(token, requestOrigin(request));
      const useCookie = fromCookie !== undefined || isBrowserClient(request.headers.origin);

      if (useCookie) {
        setRefreshCookie(reply, session);
      }

      return ok(request, { tokens: tokenPair(session, useCookie) });
    },
  );

  app.post(
    '/auth/logout',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session',
        security: [{ bearerAuth: [] }],
        body: logoutRequestSchema,
        response: { 200: emptyEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      await service.logout({
        refreshToken: request.body.refreshToken ?? request.cookies[cookies.refreshName],
        sessionId: auth.sessionId,
        userId: auth.userId,
        allSessions: request.body.allSessions,
      });

      clearRefreshCookie(reply);

      return ok(request, {});
    },
  );

  // -------------------------------------------------------------------------
  // Recuperação de senha
  // -------------------------------------------------------------------------

  app.post(
    '/auth/password-reset',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.passwordResetPerIp),
      schema: {
        tags: ['auth'],
        summary: 'Request a password reset link',
        description: 'Always answers 202, whether or not the address exists.',
        body: passwordResetRequestSchema,
        response: { 202: emptyEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      await enforceRateLimit(
        app.redis,
        emailScopedKey(request, 'reset', request.body.email),
        RATE_LIMITS.passwordResetPerEmail,
        'Too many password reset requests for this address.',
      );
      await service.requestPasswordReset(request.body.email, requestOrigin(request));

      return reply.code(202).send(ok(request, {}));
    },
  );

  app.post(
    '/auth/password-reset/confirm',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.passwordResetPerIp),
      schema: {
        tags: ['auth'],
        summary: 'Set a new password with a reset token',
        description: 'Revokes every session of the account.',
        body: passwordResetConfirmSchema,
        response: { 200: emptyEnvelope, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      await service.confirmPasswordReset(request.body.token, request.body.password);
      clearRefreshCookie(reply);

      return ok(request, {});
    },
  );

  // -------------------------------------------------------------------------
  // Perfil
  // -------------------------------------------------------------------------

  app.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'The signed-in user and their organizations',
        security: [{ bearerAuth: [] }],
        response: { 200: meEnvelope, ...authErrorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      return ok(request, await service.me(auth.userId, auth.organizationId));
    },
  );

  // -------------------------------------------------------------------------
  // Device flow (`Docs/09`)
  // -------------------------------------------------------------------------

  app.post(
    '/auth/device/authorize',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.deviceAuthorization),
      schema: {
        tags: ['auth', 'devices'],
        summary: 'Step 1 — ask for a device code',
        body: deviceAuthorizationRequestSchema,
        response: { 200: deviceAuthorizationEnvelope, ...authErrorResponses },
      },
    },
    async (request) => {
      return ok(request, await service.startDeviceAuthorization(request.body));
    },
  );

  app.get(
    '/auth/device/verification',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['auth', 'devices'],
        summary: 'Step 3 — show what is being authorized',
        security: [{ bearerAuth: [] }],
        querystring: z.object({ userCode: z.string().min(6).max(16) }),
        response: { 200: deviceVerificationEnvelope, ...errorResponses },
      },
    },
    async (request) => {
      return ok(request, await service.describeDeviceAuthorization(request.query.userCode));
    },
  );

  app.post(
    '/auth/device/decision',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      schema: {
        tags: ['auth', 'devices'],
        summary: 'Step 3 — approve or deny the device',
        security: [{ bearerAuth: [] }],
        body: deviceDecisionRequestSchema,
        response: { 200: deviceDecisionEnvelope, ...errorResponses },
      },
    },
    async (request) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      // Autorizar um dispositivo para uma organização exige ser membro ativo
      // dela: sem esta checagem, qualquer usuário aprovaria um dispositivo com
      // escopo de um tenant que não é o seu.
      const membership = await repository.findMembership(
        request.body.organizationId,
        auth.userId,
      );

      if (membership?.status !== 'active') {
        throw unauthenticated(
          'You do not have access to this organization.',
          'ORGANIZATION_ACCESS_DENIED',
        );
      }

      const state = await service.decideDeviceAuthorization({
        userCode: request.body.userCode,
        decision: request.body.decision,
        userId: auth.userId,
        organizationId: request.body.organizationId,
      });

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.body.organizationId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: `auth.device.${request.body.decision}`,
        resourceType: 'device',
        // Sem `resourceId`: o dispositivo só passa a existir quando a extensão
        // recolhe a credencial, e o código do usuário não entra em auditoria.
        resourceId: null,
        result: request.body.decision === 'approve' ? 'success' : 'denied',
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { deviceName: state.deviceName, deviceKind: state.deviceKind },
      });

      return ok(request, {
        status: state.status === 'approved' ? ('approved' as const) : ('denied' as const),
      });
    },
  );

  app.post(
    '/auth/device/token',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      // A chave do limite é o próprio device code: um cliente insistente não
      // consome a cota dos outros que estão atrás do mesmo IP.
      config: routeRateLimit(RATE_LIMITS.devicePolling, (request) => {
        const body = request.body as { deviceCode?: string } | undefined;

        return body?.deviceCode ?? request.ip;
      }),
      schema: {
        tags: ['auth', 'devices'],
        summary: 'Steps 4 and 5 — poll for the device credential',
        description:
          'Answers DEVICE_AUTHORIZATION_PENDING until the user decides, and SLOW_DOWN when polled faster than the advertised interval.',
        body: deviceTokenRequestSchema,
        response: { 200: deviceCredentialEnvelope, ...errorResponses },
      },
    },
    async (request) => {
      const credential = await service.pollDeviceToken(
        request.body.deviceCode,
        requestOrigin(request),
      );

      return ok(request, credential);
    },
  );

  done();
};
