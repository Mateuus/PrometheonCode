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
import { forbidden, isApiError, unauthenticated } from '../../shared/errors.js';
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
  providerCallbackQuerySchema,
  providerErrorResponses,
  providerExchangeRequestSchema,
  providerStartQuerySchema,
  refreshEnvelope,
  refreshRequestSchema,
  registerEnvelope,
  registerRequestSchema,
  switchOrganizationEnvelope,
  switchOrganizationRequestSchema,
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

  /**
   * Troca a organização ativa.
   *
   * Fica sob `/auth` porque o que ela devolve é credencial, não organização: a
   * sessão anterior é encerrada e outra é aberta com o escopo pedido. O cliente
   * precisa substituir o par inteiro — inclusive o cookie de refresh, que é
   * reescrito aqui.
   *
   * O raciocínio completo (por que sessão nova, e por que a denylist do Redis
   * participa) está em `AuthService.switchOrganization()`.
   */
  app.post(
    '/auth/switch-organization',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      preHandler: app.authenticate,
      config: routeRateLimit(RATE_LIMITS.switchOrganization),
      schema: {
        tags: ['auth', 'organizations'],
        summary: 'Switch the active organization of the session',
        description:
          'Issues a new session scoped to the requested organization and revokes the current one. ' +
          'Only organizations where the account has an active membership are accepted.',
        security: [{ bearerAuth: [] }],
        body: switchOrganizationRequestSchema,
        response: { 200: switchOrganizationEnvelope, ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = request.auth;

      if (auth === undefined) {
        throw unauthenticated();
      }

      // Credencial de dispositivo não tem sessão para trocar: o escopo dela foi
      // fixado no device flow, quando o usuário escolheu a organização no
      // navegador. Reemitir aqui contornaria aquela decisão sem passar por ela.
      if (auth.kind === 'device') {
        throw forbidden(
          'Device credentials are scoped at authorization time and cannot switch organization.',
          'ORGANIZATION_ACCESS_DENIED',
        );
      }

      // Mesma exigência das demais ações dentro de uma organização
      // (`plugins/auth.ts`): endereço confirmado.
      if (!auth.emailVerified) {
        throw forbidden(
          'Confirm your email address before continuing.',
          'EMAIL_NOT_VERIFIED',
        );
      }

      const result = await service.switchOrganization({
        userId: auth.userId,
        currentSessionId: auth.sessionId,
        organizationId: request.body.organizationId,
        origin: requestOrigin(request),
      });

      const useCookie = isBrowserClient(request.headers.origin);

      if (useCookie) {
        setRefreshCookie(reply, result.session);
      }

      const origin = requestOrigin(request);

      await recordAudit(app.db, {
        organizationId: request.body.organizationId,
        actorType: 'user',
        actorId: auth.userId,
        actorLabel: auth.email,
        action: 'auth.organization.switched',
        resourceType: 'session',
        resourceId: result.session.sessionId,
        requestId: request.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        metadata: { previousSessionId: auth.sessionId },
      });

      return ok(request, {
        user: result.user,
        tokens: tokenPair(result.session, useCookie),
        sessionId: result.session.sessionId,
        activeOrganizationId: request.body.organizationId,
      });
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
  // Login com GitHub
  // -------------------------------------------------------------------------
  //
  // O fluxo tem três passos e cada um existe por um motivo:
  //
  // 1. `GET /auth/oauth/github` guarda um `state` e manda o navegador ao GitHub.
  //    Sem o `state`, qualquer site conseguiria disparar o callback e ligar a
  //    conta do GitHub de um atacante à conta de quem estivesse logado aqui.
  // 2. `GET /auth/oauth/github/callback` confere o `state`, conversa com o
  //    GitHub e devolve o navegador ao Hub Web com um código de handoff.
  // 3. `POST /auth/oauth/exchange` troca esse código pela sessão.
  //
  // O terceiro passo existe porque o Hub Web roda em outro host: cookie posto
  // pela API não chega lá. Mandar o token na URL resolveria e seria péssimo — ele
  // ficaria no histórico do navegador e no `Referer` de tudo que viesse depois.

  app.get(
    '/auth/oauth/github',
    {
      config: routeRateLimit(RATE_LIMITS.loginPerIp),
      schema: {
        tags: ['auth'],
        summary: 'Start signing in with GitHub',
        description:
          'Redirects to GitHub. The scopes asked for are identity only; reading repositories is a separate consent.',
        querystring: providerStartQuerySchema,
        response: { 302: z.null(), ...providerErrorResponses },
      },
    },
    async (request, reply) => {
      const url = await service.startProviderSignIn({
        provider: 'github',
        redirectTo: request.query.redirectTo,
        // Vinculação a partir de uma conta já autenticada ainda não é oferecida
        // por esta rota; quando for, o `userId` sai daqui.
        userId: null,
      });

      return reply.redirect(url, 302);
    },
  );

  app.get(
    '/auth/oauth/github/callback',
    {
      config: routeRateLimit(RATE_LIMITS.loginPerIp),
      schema: {
        tags: ['auth'],
        summary: 'Finish signing in with GitHub',
        description:
          'Consumes the state, exchanges the code with GitHub and sends the browser back to the web app with a short-lived handoff code.',
        querystring: providerCallbackQuerySchema,
        response: { 302: z.null(), ...providerErrorResponses },
      },
    },
    async (request, reply) => {
      const webUrl = app.appConfig.http.webUrl;

      // Quem clicou em "cancelar" no GitHub volta com `error` e sem `code`. Não
      // é falha: é uma decisão, e merece a tela de login de volta, não um erro.
      if (request.query.error !== undefined || request.query.code === undefined) {
        return reply.redirect(`${webUrl}/login?provider=cancelled`, 302);
      }

      if (request.query.state === undefined) {
        return reply.redirect(`${webUrl}/login?provider=invalid`, 302);
      }

      try {
        const result = await service.completeProviderSignIn(
          { provider: 'github', code: request.query.code, state: request.query.state },
          requestOrigin(request),
        );

        const target = new URL('/auth/callback', webUrl);

        target.searchParams.set('code', result.handoffCode);
        target.searchParams.set('next', result.redirectTo);

        // `await` dentro do `try`: sem ele, uma rejeição escaparia do `catch` e
        // a pessoa veria uma página de erro crua no meio do redirecionamento.
        return await reply.redirect(target.toString(), 302);
      } catch (error) {
        // A pessoa está num navegador, no meio de um redirecionamento: devolver
        // JSON aqui deixaria uma página de erro crua na tela. O código vai como
        // parâmetro para o Hub Web dizer o que fazer, na língua dela.
        const code = isApiError(error) ? error.code : 'PROVIDER_UNAVAILABLE';

        request.log.warn({ err: error, provider: 'github' }, 'provider sign-in failed');

        return reply.redirect(`${webUrl}/login?provider=${encodeURIComponent(code)}`, 302);
      }
    },
  );

  app.post(
    '/auth/oauth/exchange',
    {
      bodyLimit: PAYLOAD_LIMITS.auth,
      config: routeRateLimit(RATE_LIMITS.loginPerIp),
      schema: {
        tags: ['auth'],
        summary: 'Exchange a provider handoff code for a session',
        description:
          'The code is single-use and lives for thirty seconds. The session is created here, so no ready-made token ever waits in storage.',
        body: providerExchangeRequestSchema,
        response: { 200: loginEnvelope, ...providerErrorResponses },
      },
    },
    async (request, reply) => {
      const result = await service.exchangeProviderHandoff(
        request.body.code,
        requestOrigin(request),
      );
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
          metadata: { provider: 'github' },
        });
      }

      return ok(request, {
        user: result.user,
        tokens: tokenPair(result.session, useCookie),
        sessionId: result.session.sessionId,
      });
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
