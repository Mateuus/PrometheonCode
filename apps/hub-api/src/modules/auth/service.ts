/**
 * Regras de autenticação.
 *
 * Três ideias governam este arquivo:
 *
 * 1. **Resposta uniforme.** Registro, login e recuperação de senha respondem
 *    igual exista ou não a conta — mesmo corpo, mesmo status e, o que costuma
 *    passar batido, mesmo tempo. Cada caminho gasta um Argon2id, inclusive o
 *    que não tem senha para verificar (ver `password.ts`), e o envio do e-mail
 *    não é esperado pela requisição.
 * 2. **Segredo em texto puro existe uma vez.** Refresh token, credencial de
 *    dispositivo e token de e-mail são gerados, entregues e esquecidos; o que
 *    fica guardado é o SHA-256.
 * 3. **Rotação com detecção de reuso.** Cada refresh emite um novo token e
 *    marca o anterior como usado. Um token usado que reaparece derruba a
 *    família inteira — é o sinal de que o valor vazou.
 */

import type { Role } from '@prometheon/permissions';
import { child } from '@prometheon/logger';
import { newId, type Database, type IdentityProvider } from '@prometheon/database';

import { AUTH_SETTINGS, type AppConfig } from '../../config/index.js';
import {
  invitationEmail,
  passwordResetEmail,
  registrationAttemptEmail,
  verificationEmail,
  type MailMessage,
  type MailService,
} from '../../mail/index.js';
import type { RedisClient } from '../../plugins/redis.js';
import { hashToken, normalizeUserCode, randomToken } from '../../shared/crypto.js';
import { ApiError, internalError } from '../../shared/errors.js';
import { addSeconds, toIso } from '../../shared/time.js';
import {
  deviceAuthorizationDenied,
  deviceAuthorizationPending,
  deviceCodeExpired,
  deviceCodeInvalid,
  invalidCredentials,
  invitationExpired,
  invitationInvalid,
  identityLinkRequired,
  oauthStateInvalid,
  organizationAccessDenied,
  providerEmailRequired,
  providerNotConfigured,
  refreshTokenInvalid,
  resetTokenInvalid,
  sessionRevoked,
  verificationTokenInvalid,
} from './errors.js';
import {
  decideDeviceFlow,
  finishDeviceFlow,
  readByDeviceCode,
  readByUserCode,
  registerPoll,
  startDeviceFlow,
} from './device-flow.js';
import { authorizationUrl, createGitHubClient, type GitHubClient } from './github.js';
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from './password.js';
import { AuthRepository, type MembershipRow } from './repository.js';
import {
  consumeOAuthHandoff,
  consumeOAuthState,
  consumeSingleUseToken,
  denySession,
  issueOAuthHandoff,
  issueOAuthState,
  issueSingleUseToken,
} from './token-store.js';
import { DEVICE_TOKEN_PREFIX, issueAccessToken } from './tokens.js';
import type {
  CurrentUserView,
  DeviceFlowState,
  IssuedSession,
  RequestOrigin,
  SessionOrganization,
} from './types.js';

const logger = child('auth');

/** Plataformas aceitas na coluna `devices.platform`. */
const DEVICE_PLATFORMS = ['windows', 'macos', 'linux', 'web', 'other'] as const;

type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

function toDevicePlatform(value: string | undefined): DevicePlatform {
  const normalized = value?.toLowerCase() ?? '';

  return (DEVICE_PLATFORMS as readonly string[]).includes(normalized)
    ? (normalized as DevicePlatform)
    : 'other';
}

export interface AuthServiceDeps {
  readonly db: Database;
  readonly redis: RedisClient;
  readonly mailer: MailService;
  readonly config: AppConfig;
  /**
   * Cliente do GitHub. Ausente em produção — é construído a partir da
   * configuração. O teste injeta o dele para não depender da rede: um teste que
   * chama o GitHub de verdade falha quando a internet cai, quando o rate limit
   * estoura e quando alguém revoga o app, e nenhuma dessas falhas diz nada sobre
   * o código.
   */
  readonly githubClient?: GitHubClient;
}

/**
 * Destino seguro para depois do login.
 *
 * Só caminho interno, começando com uma barra e sem uma segunda barra logo em
 * seguida — `//evil.com` é uma URL absoluta protocol-relative, e o navegador
 * obedece. Sem esta poda, o Hub viraria um redirecionador aberto: um link do
 * domínio legítimo levando a pessoa a um site de phishing.
 */
function safeRedirect(value: string | undefined): string {
  if (value === undefined || !value.startsWith('/') || value.startsWith('//')) {
    return '/app';
  }

  return value;
}

export class AuthService {
  private readonly repository: AuthRepository;
  /**
   * Entregas de e-mail em andamento.
   *
   * O envio é disparado sem `await` de propósito: prender a resposta ao SMTP
   * faria o tempo de "e-mail existe" diferir do de "não existe", que é
   * exatamente o vazamento que se está tentando fechar. O conjunto existe para
   * que o desligamento e os testes consigam esperar as entregas pendentes.
   */
  private readonly pendingMail = new Set<Promise<unknown>>();

  private readonly githubClient: GitHubClient | undefined;

  constructor(private readonly deps: AuthServiceDeps) {
    this.repository = new AuthRepository(deps.db);
    this.githubClient = deps.githubClient;
  }

  /** Espera as entregas em voo. Usado no shutdown e nos testes. */
  async flushPendingMail(): Promise<void> {
    await Promise.allSettled([...this.pendingMail]);
  }

  private dispatch(message: MailMessage): void {
    const delivery = this.deps.mailer.send(message).catch((error: unknown) => {
      logger.error({ err: error, mailKind: message.kind }, 'email delivery failed');
    });

    this.pendingMail.add(delivery);
    void delivery.finally(() => this.pendingMail.delete(delivery));
  }

  // -------------------------------------------------------------------------
  // Registro e verificação de e-mail
  // -------------------------------------------------------------------------

  /**
   * Registro.
   *
   * A resposta é a mesma nos três desfechos possíveis — conta criada, e-mail já
   * cadastrado, convite inválido — e o custo computacional também. Quem tenta
   * descobrir se `alguem@empresa.com` tem conta aqui não consegue distinguir
   * nada nem pelo corpo, nem pelo status, nem pelo relógio.
   */
  async register(
    input: {
      name: string;
      email: string;
      password: string;
      organizationName?: string | undefined;
      invitationToken?: string | undefined;
    },
    origin: RequestOrigin,
  ): Promise<{ email: string; verificationEmailSent: boolean }> {
    const existing = await this.repository.findUserByEmail(input.email);

    if (existing !== undefined) {
      // Mesmo custo de um registro real: um Argon2id completo.
      await verifyDummyPassword(input.password);

      // O dono do endereço tem direito de saber que alguém tentou; quem tentou
      // não tem direito de saber que a conta existe.
      this.dispatch({
        ...registrationAttemptEmail({
          name: existing.displayName,
          signInUrl: `${this.deps.config.http.webUrl}/sign-in`,
          passwordResetUrl: `${this.deps.config.http.webUrl}/forgot-password`,
        }),
        to: existing.email,
      });

      await this.repository.recordSecurityEvent({
        type: 'register_existing_email',
        severity: 'low',
        userId: existing.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });

      return { email: input.email, verificationEmailSent: true };
    }

    const passwordHash = await hashPassword(input.password);

    // Sem convite e sem nome de organização, a conta nasce com uma organização
    // própria: um usuário sem tenant não consegue fazer nada no Hub.
    const organizationName =
      input.invitationToken === undefined
        ? (input.organizationName ?? `${input.name}'s workspace`)
        : undefined;

    const created = await this.repository.createUser({
      email: input.email,
      displayName: input.name,
      passwordHash,
      organizationName,
    });

    if (input.invitationToken !== undefined) {
      await this.consumeInvitation(input.invitationToken, created.userId);
    }

    const { token, expiresInSeconds } = await issueSingleUseToken(
      this.deps.redis,
      'email-verification',
      created.userId,
    );

    this.dispatch({
      ...verificationEmail({
        name: input.name,
        verificationUrl: this.verificationUrl(token),
        expiresInSeconds,
      }),
      to: input.email,
    });

    logger.info({ userId: created.userId }, 'account registered');

    return { email: input.email, verificationEmailSent: true };
  }

  /** Aceita um convite pendente, ligando o novo usuário à organização. */
  private async consumeInvitation(token: string, userId: string): Promise<void> {
    const invitation = await this.repository.findInvitationByHash(hashToken(token));

    if (invitation?.status !== 'pending') {
      throw invitationInvalid();
    }

    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw invitationExpired();
    }

    await this.repository.acceptInvitation({
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      roleId: invitation.roleId,
      userId,
    });
  }

  async verifyEmail(token: string): Promise<{ userId: string }> {
    const userId = await consumeSingleUseToken(
      this.deps.redis,
      'email-verification',
      token,
    );

    if (userId === null) {
      throw verificationTokenInvalid();
    }

    await this.repository.markEmailVerified(userId);
    logger.info({ userId }, 'email verified');

    return { userId };
  }

  /** Reenvia a verificação. Responde igual exista ou não a conta. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.repository.findUserByEmail(email);

    if (user?.emailVerifiedAt !== null) {
      return;
    }

    const { token, expiresInSeconds } = await issueSingleUseToken(
      this.deps.redis,
      'email-verification',
      user.id,
    );

    this.dispatch({
      ...verificationEmail({
        name: user.displayName,
        verificationUrl: this.verificationUrl(token),
        expiresInSeconds,
      }),
      to: user.email,
    });
  }

  // -------------------------------------------------------------------------
  // Login, refresh e logout
  // -------------------------------------------------------------------------

  async login(
    input: { email: string; password: string; clientName?: string | undefined },
    origin: RequestOrigin,
  ): Promise<{ user: CurrentUserView; session: IssuedSession }> {
    const user = await this.repository.findUserByEmail(input.email);

    // `?? null` para que conta inexistente e conta sem senha caiam no mesmo
    // caminho — e no mesmo tempo de resposta.
    const passwordHash = user?.passwordHash ?? null;

    if (user === undefined || passwordHash === null) {
      // Gasta o mesmo tempo de uma verificação real antes de recusar.
      await verifyDummyPassword(input.password);
      await this.repository.recordSecurityEvent({
        type: 'login_failed',
        severity: 'low',
        ip: origin.ip,
        userAgent: origin.userAgent,
        // O e-mail tentado **não** é registrado: transformaria a tabela de
        // eventos numa lista de endereços testados.
        details: { reason: 'unknown_account_or_no_password' },
      });

      throw invalidCredentials();
    }

    const matches = await verifyPassword(passwordHash, input.password);

    if (!matches) {
      await this.repository.recordSecurityEvent({
        type: 'login_failed',
        severity: 'low',
        userId: user.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        details: { reason: 'wrong_password' },
      });

      throw invalidCredentials();
    }

    if (user.status === 'suspended' || user.status === 'disabled') {
      await this.repository.recordSecurityEvent({
        type: 'login_blocked',
        severity: 'medium',
        userId: user.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        details: { status: user.status },
      });

      throw invalidCredentials();
    }

    // Custo do Argon2id subiu desde o último login: regrava o hash sem pedir
    // nada ao usuário.
    if (needsRehash(passwordHash)) {
      await this.repository.updatePassword(user.id, await hashPassword(input.password));
    }

    const memberships = await this.repository.listMemberships(user.id);
    const activeOrganizationId = memberships[0]?.organizationId ?? null;

    const session = await this.issueSession({
      userId: user.id,
      organizationId: activeOrganizationId,
      deviceId: null,
      origin,
    });

    await this.repository.touchLogin(user.id);

    logger.info({ userId: user.id, sessionId: session.sessionId }, 'login succeeded');

    return { user: toCurrentUser(user), session };
  }

  // -------------------------------------------------------------------------
  // Login por provedor externo
  // -------------------------------------------------------------------------

  /**
   * Começa o fluxo: guarda o `state` e devolve para onde mandar o navegador.
   *
   * `redirectTo` é conferido aqui, e não lá na volta: um destino externo aceito
   * agora viraria um redirecionador aberto — um link do próprio Hub que leva a
   * pessoa a um site de phishing, com a credibilidade do domínio junto.
   */
  async startProviderSignIn(input: {
    provider: IdentityProvider;
    redirectTo: string | undefined;
    userId: string | null;
  }): Promise<string> {
    const github = this.deps.config.github;

    if (input.provider !== 'github' || !github.enabled) {
      throw providerNotConfigured();
    }

    const state = await issueOAuthState(this.deps.redis, {
      redirectTo: safeRedirect(input.redirectTo),
      userId: input.userId,
    });

    return authorizationUrl({
      clientId: github.clientId ?? '',
      callbackUrl: github.callbackUrl ?? '',
      scopes: github.scopes,
      state,
    });
  }

  /**
   * Recebe a volta do provedor e devolve o código de handoff.
   *
   * O `state` é consumido antes de qualquer outra coisa: se ele não valer, nem
   * chega a existir uma conversa com o GitHub, e um callback forjado morre sem
   * custo nenhum.
   */
  async completeProviderSignIn(
    input: { provider: IdentityProvider; code: string; state: string },
    origin: RequestOrigin,
  ): Promise<{ handoffCode: string; redirectTo: string }> {
    const github = this.deps.config.github;

    if (input.provider !== 'github' || !github.enabled) {
      throw providerNotConfigured();
    }

    const stored = await consumeOAuthState(this.deps.redis, input.state);

    if (stored === null) {
      throw oauthStateInvalid();
    }

    const client =
      this.githubClient ??
      createGitHubClient({
        clientId: github.clientId ?? '',
        clientSecret: github.clientSecret ?? '',
        callbackUrl: github.callbackUrl ?? '',
      });

    const providerToken = await client.exchangeCode(input.code);
    const identity = await client.fetchIdentity(providerToken);

    const { userId } = await this.signInWithProvider(
      {
        provider: 'github',
        providerAccountId: identity.providerAccountId,
        email: identity.email,
        // O GitHub deixa o nome vazio; o `login` sempre existe e é reconhecível.
        displayName: identity.displayName ?? identity.username,
        avatarUrl: identity.avatarUrl,
      },
      origin,
    );

    return {
      handoffCode: await issueOAuthHandoff(this.deps.redis, userId),
      redirectTo: stored.redirectTo,
    };
  }

  /** Troca o código de handoff por uma sessão de verdade. */
  async exchangeProviderHandoff(
    code: string,
    origin: RequestOrigin,
  ): Promise<{ user: CurrentUserView; session: IssuedSession }> {
    const userId = await consumeOAuthHandoff(this.deps.redis, code);

    if (userId === null) {
      throw oauthStateInvalid();
    }

    const user = await this.repository.findUserById(userId);

    if (user === undefined || user.status === 'suspended' || user.status === 'disabled') {
      throw invalidCredentials();
    }

    return { user: toCurrentUser(user), session: await this.startSessionFor(user.id, origin) };
  }

  /**
   * Entra (ou cadastra) com uma identidade confirmada por um provedor.
   *
   * A ordem das três perguntas é o coração do desenho, e a terceira é onde mora
   * o risco:
   *
   * 1. **Esta conta do provedor já está vinculada?** É o caminho comum: a pessoa
   *    já entrou aqui com o GitHub antes. Entra direto.
   *
   * 2. **Não está vinculada e o e-mail é novo?** Cria a conta. Nasce verificada
   *    porque o provedor confirmou o endereço.
   *
   * 3. **Não está vinculada, mas o e-mail já pertence a alguém aqui?** É a
   *    pergunta perigosa. Vincular automaticamente entregaria a conta a quem
   *    cadastrasse o endereço de outra pessoa e nunca o confirmasse: bastaria
   *    registrar `voce@exemplo.com` com senha, esperar, e a sua entrada pelo
   *    GitHub cairia dentro da conta do atacante. Por isso a vinculação
   *    automática exige **as duas pontas verificadas** — o provedor confirmou o
   *    endereço, e a conta local também já o tinha confirmado. Fora disso, a
   *    resposta é `IDENTITY_LINK_REQUIRED`: entre com a senha e ligue o provedor
   *    de dentro da conta, onde a posse já está provada.
   *
   * Identidade sem e-mail (a pessoa não tem endereço verificado no provedor) não
   * cria conta: sem endereço não há recuperação, não há convite, não há aviso de
   * segurança — seria uma conta que ninguém consegue reaver.
   */
  async signInWithProvider(
    input: {
      provider: IdentityProvider;
      providerAccountId: string;
      email: string | null;
      displayName: string;
      avatarUrl: string | null;
    },
    origin: RequestOrigin,
  ): Promise<{ userId: string }> {
    const linked = await this.repository.findIdentity(input.provider, input.providerAccountId);

    if (linked !== undefined) {
      const user = await this.repository.findUserById(linked.userId);

      if (user === undefined || user.status === 'suspended' || user.status === 'disabled') {
        await this.repository.recordSecurityEvent({
          type: 'login_blocked',
          severity: 'medium',
          userId: linked.userId,
          ip: origin.ip,
          userAgent: origin.userAgent,
          details: { provider: input.provider, status: user?.status ?? 'missing' },
        });

        throw invalidCredentials();
      }

      await this.repository.touchIdentity(linked.id);

      return { userId: user.id };
    }

    if (input.email === null) {
      await this.repository.recordSecurityEvent({
        type: 'provider_login_without_email',
        severity: 'low',
        ip: origin.ip,
        userAgent: origin.userAgent,
        details: { provider: input.provider },
      });

      throw providerEmailRequired();
    }

    const existing = await this.repository.findUserByEmail(input.email);

    if (existing === undefined) {
      const created = await this.repository.createUserFromProvider({
        email: input.email,
        displayName: input.displayName,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        avatarUrl: input.avatarUrl,
      });

      const user = await this.repository.findUserById(created.userId);

      if (user === undefined) {
        throw internalError('The account was created but could not be read back.');
      }

      logger.info({ userId: user.id, provider: input.provider }, 'account created from provider');

      return { userId: user.id };
    }

    // A conta local existe. Só vincula sozinho com as duas pontas verificadas.
    if (existing.emailVerifiedAt === null) {
      await this.repository.recordSecurityEvent({
        type: 'provider_link_refused',
        severity: 'medium',
        userId: existing.id,
        ip: origin.ip,
        userAgent: origin.userAgent,
        details: { provider: input.provider, reason: 'local_email_unverified' },
      });

      throw identityLinkRequired();
    }

    if (existing.status === 'suspended' || existing.status === 'disabled') {
      throw invalidCredentials();
    }

    await this.repository.linkIdentity({
      userId: existing.id,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      email: input.email,
      displayName: input.displayName,
    });

    await this.repository.recordSecurityEvent({
      type: 'provider_linked',
      severity: 'low',
      userId: existing.id,
      ip: origin.ip,
      userAgent: origin.userAgent,
      details: { provider: input.provider, reason: 'verified_email_match' },
    });

    logger.info({ userId: existing.id, provider: input.provider }, 'provider linked to account');

    return { userId: existing.id };
  }

  /**
   * Abre a sessão na primeira organização da pessoa, como o login faz.
   *
   * Usada pela troca do código de handoff no login por provedor: a sessão nasce
   * ali, e não no callback, para que nenhum token pronto precise ficar guardado
   * esperando o cliente vir buscar.
   */
  async startSessionFor(userId: string, origin: RequestOrigin): Promise<IssuedSession> {
    const memberships = await this.repository.listMemberships(userId);

    const session = await this.issueSession({
      userId,
      organizationId: memberships[0]?.organizationId ?? null,
      deviceId: null,
      origin,
    });

    await this.repository.touchLogin(userId);

    return session;
  }

  /**
   * Rotaciona o refresh token.
   *
   * O token apresentado é consumido (`used_at`) e um novo é emitido apontando
   * para ele em `previous_token_id`. Se o token já estivesse usado ou revogado,
   * a família inteira cai: não há como saber se quem apresentou é o dono ou
   * quem roubou, então nenhum dos dois continua.
   */
  async refresh(
    refreshToken: string,
    origin: RequestOrigin,
  ): Promise<{ session: IssuedSession }> {
    const record = await this.repository.findRefreshTokenByHash(hashToken(refreshToken));

    if (record === undefined) {
      throw refreshTokenInvalid();
    }

    if (record.revokedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      throw refreshTokenInvalid();
    }

    // Reuso: o token já tinha sido rotacionado.
    if (record.usedAt !== null) {
      await this.handleRefreshReuse(record.sessionId, record.userId, origin);

      throw refreshTokenInvalid();
    }

    // A corrida entre dois refreshes simultâneos é resolvida no banco: só um
    // `UPDATE ... WHERE used_at IS NULL` afeta linha.
    const consumed = await this.repository.consumeRefreshToken(record.id);

    if (!consumed) {
      await this.handleRefreshReuse(record.sessionId, record.userId, origin);

      throw refreshTokenInvalid();
    }

    const session = await this.repository.findSession(record.sessionId);

    if (session === undefined) {
      throw sessionRevoked();
    }

    if (session.revokedAt !== null) {
      throw sessionRevoked();
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw refreshTokenInvalid();
    }

    await this.repository.touchSession(session.id);

    return {
      session: await this.rotate({
        sessionId: session.id,
        userId: record.userId,
        organizationId: session.organizationId,
        previousTokenId: record.id,
        origin,
      }),
    };
  }

  private async handleRefreshReuse(
    sessionId: string,
    userId: string,
    origin: RequestOrigin,
  ): Promise<void> {
    await this.repository.revokeTokenFamily(sessionId, 'refresh_token_reuse');
    await denySession(this.deps.redis, sessionId);
    await this.repository.recordSecurityEvent({
      type: 'refresh_token_reuse',
      severity: 'high',
      userId,
      ip: origin.ip,
      userAgent: origin.userAgent,
      details: { sessionId },
    });

    logger.warn({ userId, sessionId }, 'refresh token reuse detected; family revoked');
  }

  async logout(
    input: { refreshToken?: string | undefined; sessionId?: string | null; userId: string; allSessions: boolean },
  ): Promise<void> {
    if (input.allSessions) {
      const revoked = await this.repository.revokeAllSessions(input.userId, 'logout_all');

      await Promise.all(revoked.map((id) => denySession(this.deps.redis, id)));
      logger.info({ userId: input.userId, sessions: revoked.length }, 'all sessions revoked');

      return;
    }

    let sessionId = input.sessionId ?? null;

    if (sessionId === null && input.refreshToken !== undefined) {
      const record = await this.repository.findRefreshTokenByHash(hashToken(input.refreshToken));

      sessionId = record?.sessionId ?? null;
    }

    if (sessionId === null) {
      return;
    }

    await this.repository.revokeTokenFamily(sessionId, 'logout');
    await denySession(this.deps.redis, sessionId);
    logger.info({ userId: input.userId, sessionId }, 'session revoked');
  }

  /**
   * Troca a organização ativa.
   *
   * DECISÃO DE PROJETO — por que uma sessão nova, e não um `UPDATE` na atual:
   *
   * O claim `org` mora dentro de um JWT assinado. Reescrevê-lo é impossível;
   * emitir outro é fácil. Sobra decidir o que fazer com o token antigo, e as
   * duas saídas não se equivalem:
   *
   * - **Mudar `user_sessions.organization_id` e emitir um access token novo**
   *   deixaria a mesma sessão com dois tokens vivos apontando para organizações
   *   diferentes por até quinze minutos. Quem trocou de A para B continuaria
   *   agindo em A com a credencial anterior — e a auditoria de A registraria uma
   *   sessão que o usuário acredita ter deixado.
   * - **Abrir uma sessão nova e revogar a anterior** encerra o escopo antigo no
   *   mesmo instante: `revokeTokenFamily()` mata o refresh, e `denySession()`
   *   põe a sessão na denylist do Redis, que é o que alcança um access token
   *   ainda dentro da validade (ver `plugins/auth.ts`). O token antigo não vale
   *   para a organização nova porque carrega `org: A`, e não vale mais nem para
   *   a antiga porque a sessão dele morreu.
   *
   * É por isso que a denylist participa: sem ela, "não vale mais" só começaria a
   * valer quando o JWT expirasse sozinho.
   *
   * A rotação continua funcionando porque a sessão nova nasce pelo mesmo caminho
   * do login — `issueSession()` grava a linha em `user_sessions` e emite o
   * primeiro refresh da família. Não há estado especial de "sessão trocada".
   *
   * A ordem importa: emitir primeiro, revogar depois. Se a revogação falhar, o
   * usuário fica com duas sessões válidas — incômodo e auditável. Na ordem
   * inversa, uma falha na emissão o deixaria sem nenhuma.
   */
  async switchOrganization(input: {
    userId: string;
    /** Sessão em uso. Nulo quando quem chama é uma credencial de dispositivo. */
    currentSessionId: string | null;
    organizationId: string;
    origin: RequestOrigin;
  }): Promise<{ user: CurrentUserView; session: IssuedSession }> {
    // A associação é verificada aqui, no servidor, contra o banco. O corpo da
    // requisição só diz para onde o usuário quer ir; ele nunca diz que pode.
    const membership = await this.repository.findMembership(
      input.organizationId,
      input.userId,
    );

    if (membership?.status !== 'active') {
      // O identificador pedido vai em `details`, não na coluna: quem chama pode
      // ter mandado um ULID que não corresponde a organização nenhuma, e
      // `security_events.organization_id` tem chave estrangeira — gravá-lo ali
      // transformaria uma recusa correta em erro do servidor.
      await this.repository.recordSecurityEvent({
        type: 'organization_switch_denied',
        severity: 'medium',
        userId: input.userId,
        ip: input.origin.ip,
        userAgent: input.origin.userAgent,
        details: {
          requestedOrganizationId: input.organizationId,
          membershipStatus: membership?.status ?? 'none',
        },
      });

      throw organizationAccessDenied();
    }

    const user = await this.repository.findUserById(input.userId);

    if (user === undefined) {
      throw sessionRevoked();
    }

    // O dispositivo da sessão anterior acompanha a nova: continua sendo a mesma
    // máquina, e perder o vínculo apagaria o dispositivo da lista de sessões.
    const previous =
      input.currentSessionId === null
        ? undefined
        : await this.repository.findSession(input.currentSessionId);

    const session = await this.issueSession({
      userId: input.userId,
      organizationId: input.organizationId,
      deviceId: previous?.deviceId ?? null,
      origin: input.origin,
    });

    if (input.currentSessionId !== null) {
      await this.repository.revokeTokenFamily(input.currentSessionId, 'organization_switch');
      await denySession(this.deps.redis, input.currentSessionId);
    }

    logger.info(
      {
        userId: input.userId,
        organizationId: input.organizationId,
        sessionId: session.sessionId,
        previousSessionId: input.currentSessionId,
      },
      'active organization switched',
    );

    return { user: toCurrentUser(user), session };
  }

  /** Cria a sessão e o primeiro par de tokens. */
  private async issueSession(input: {
    userId: string;
    organizationId: string | null;
    deviceId: string | null;
    origin: RequestOrigin;
  }): Promise<IssuedSession> {
    const sessionId = await this.repository.createSession({
      userId: input.userId,
      organizationId: input.organizationId,
      deviceId: input.deviceId,
      ip: input.origin.ip,
      userAgent: input.origin.userAgent,
      expiresAt: addSeconds(new Date(), AUTH_SETTINGS.sessionTtlSeconds),
    });

    return this.rotate({
      sessionId,
      userId: input.userId,
      organizationId: input.organizationId,
      previousTokenId: null,
      origin: input.origin,
    });
  }

  /** Emite access token novo e refresh token novo. */
  private async rotate(input: {
    sessionId: string;
    userId: string;
    organizationId: string | null;
    previousTokenId: string | null;
    origin: RequestOrigin;
  }): Promise<IssuedSession> {
    const refreshToken = randomToken();
    const refreshExpiresAt = addSeconds(new Date(), AUTH_SETTINGS.refreshTokenTtlSeconds);

    await this.repository.insertRefreshToken({
      sessionId: input.sessionId,
      userId: input.userId,
      // Só o hash entra no banco (`Docs/09`).
      tokenHash: hashToken(refreshToken),
      previousTokenId: input.previousTokenId,
      expiresAt: refreshExpiresAt,
      ip: input.origin.ip,
      userAgent: input.origin.userAgent,
    });

    const access = await issueAccessToken(this.deps.config, {
      userId: input.userId,
      sessionId: input.sessionId,
      organizationId: input.organizationId,
      tokenId: newId(),
    });

    return {
      sessionId: input.sessionId,
      accessToken: access.token,
      accessExpiresIn: access.expiresIn,
      refreshToken,
      refreshExpiresIn: AUTH_SETTINGS.refreshTokenTtlSeconds,
      organizationId: input.organizationId,
    };
  }

  // -------------------------------------------------------------------------
  // Recuperação de senha
  // -------------------------------------------------------------------------

  /** Responde igual exista ou não a conta. */
  async requestPasswordReset(email: string, origin: RequestOrigin): Promise<void> {
    const user = await this.repository.findUserByEmail(email);

    if (user === undefined) {
      await this.repository.recordSecurityEvent({
        type: 'password_reset_unknown_email',
        severity: 'low',
        ip: origin.ip,
        userAgent: origin.userAgent,
      });

      return;
    }

    const { token, expiresInSeconds } = await issueSingleUseToken(
      this.deps.redis,
      'password-reset',
      user.id,
    );

    this.dispatch({
      ...passwordResetEmail({
        name: user.displayName,
        resetUrl: `${this.deps.config.http.webUrl}/reset-password?token=${encodeURIComponent(token)}`,
        expiresInSeconds,
      }),
      to: user.email,
    });
  }

  /**
   * Confirma a nova senha.
   *
   * Trocar a senha derruba todas as sessões **e todos os dispositivos**: se o
   * motivo do reset foi um comprometimento, deixar qualquer porta viva anularia
   * o efeito. A extensão no VS Code é uma porta como as outras — e mais durável,
   * porque a credencial dela vale 90 dias contra os 15 minutos de um access
   * token. É o mesmo que `AccountService.changePassword()` faz, para que
   * "troquei minha senha" signifique uma coisa só nos dois caminhos.
   */
  async confirmPasswordReset(token: string, password: string): Promise<{ userId: string }> {
    const userId = await consumeSingleUseToken(this.deps.redis, 'password-reset', token);

    if (userId === null) {
      throw resetTokenInvalid();
    }

    await this.repository.updatePassword(userId, await hashPassword(password));

    const revoked = await this.repository.revokeAllSessions(userId, 'password_reset');

    await Promise.all(revoked.map((id) => denySession(this.deps.redis, id)));

    const revokedDevices = await this.repository.revokeDevices({
      userId,
      reason: 'password_reset',
    });

    await this.repository.recordSecurityEvent({
      type: 'password_reset_completed',
      severity: 'medium',
      userId,
      details: { revokedSessions: revoked.length, revokedDevices: revokedDevices.length },
    });

    return { userId };
  }

  // -------------------------------------------------------------------------
  // `GET /v1/me`
  // -------------------------------------------------------------------------

  async me(userId: string, activeOrganizationId: string | null): Promise<{
    user: CurrentUserView;
    organizations: SessionOrganization[];
    activeOrganizationId: string | null;
  }> {
    const user = await this.repository.findUserById(userId);

    if (user === undefined) {
      throw sessionRevoked();
    }

    const memberships = await this.repository.listMemberships(userId);

    return {
      user: toCurrentUser(user),
      organizations: memberships.map(toSessionOrganization),
      activeOrganizationId: activeOrganizationId ?? memberships[0]?.organizationId ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Device flow (`Docs/09`)
  // -------------------------------------------------------------------------

  /** Passo 1: a extensão pede um código. */
  async startDeviceAuthorization(input: {
    deviceName: string;
    deviceKind: 'vscode' | 'cli' | 'ci' | 'other';
    platform?: string | undefined;
    clientVersion?: string | undefined;
  }): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  }> {
    const started = await startDeviceFlow(this.deps.redis, {
      deviceName: input.deviceName,
      deviceKind: input.deviceKind,
      platform: input.platform ?? null,
      clientVersion: input.clientVersion ?? null,
    });

    const verificationUri = `${this.deps.config.http.webUrl}/device`;

    return {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri,
      // Passo 2: é este endereço que a extensão abre no navegador.
      verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`,
      expiresIn: started.expiresIn,
      interval: started.interval,
    };
  }

  /** Passo 3a: o navegador mostra o que está sendo autorizado. */
  async describeDeviceAuthorization(userCode: string): Promise<{
    deviceName: string;
    deviceKind: 'vscode' | 'cli' | 'ci' | 'other';
    platform: string | null;
    requestedAt: string;
    expiresAt: string;
  }> {
    const found = await readByUserCode(this.deps.redis, normalizeUserCode(userCode));

    if (found === null) {
      throw deviceCodeInvalid();
    }

    return {
      deviceName: found.state.deviceName,
      deviceKind: found.state.deviceKind,
      platform: found.state.platform,
      requestedAt: found.state.requestedAt,
      expiresAt: found.state.expiresAt,
    };
  }

  /** Passo 3b: o usuário aprova ou nega. */
  async decideDeviceAuthorization(input: {
    userCode: string;
    decision: 'approve' | 'deny';
    userId: string;
    organizationId: string;
  }): Promise<DeviceFlowState> {
    const found = await readByUserCode(this.deps.redis, normalizeUserCode(input.userCode));

    if (found === null) {
      throw deviceCodeInvalid();
    }

    const updated = await decideDeviceFlow(
      this.deps.redis,
      found.codeHash,
      input.decision === 'approve' ? 'approved' : 'denied',
      { userId: input.userId, organizationId: input.organizationId },
    );

    if (updated === null) {
      throw deviceCodeExpired();
    }

    return updated;
  }

  /**
   * Passos 4 e 5: polling limitado e entrega da credencial.
   *
   * O intervalo mínimo é imposto aqui (`SLOW_DOWN`), além do rate limit da
   * rota. Os dois cobrem coisas diferentes: o rate limit contém o volume, e o
   * `SLOW_DOWN` contém a frequência de um cliente só.
   */
  async pollDeviceToken(
    deviceCode: string,
    origin: RequestOrigin,
  ): Promise<{
    deviceId: string;
    deviceToken: string;
    expiresAt: string;
    organizationId: string;
    user: { id: string; name: string; email: string; avatarUrl: string | null };
  }> {
    const poll = await registerPoll(this.deps.redis, deviceCode);

    if (poll.tooSoon) {
      throw new ApiError(
        429,
        'SLOW_DOWN',
        `Polling too fast. Wait ${String(poll.retryInSeconds)} seconds between attempts.`,
        {
          retryAfter: addSeconds(new Date(), poll.retryInSeconds),
          headers: { 'retry-after': String(poll.retryInSeconds) },
        },
      );
    }

    const state = await readByDeviceCode(this.deps.redis, deviceCode);

    if (state === null) {
      // Código inexistente e código vencido são indistinguíveis no Redis: a
      // chave simplesmente não está mais lá. `DEVICE_CODE_EXPIRED` é a leitura
      // correta para o cliente que estava fazendo polling.
      throw deviceCodeExpired();
    }

    if (state.status === 'denied') {
      await finishDeviceFlow(this.deps.redis, deviceCode, state.userCode);

      throw deviceAuthorizationDenied();
    }

    if (state.status === 'pending') {
      throw deviceAuthorizationPending();
    }

    if (state.userId === undefined || state.organizationId === undefined) {
      throw deviceCodeInvalid();
    }

    const user = await this.repository.findUserById(state.userId);

    if (user === undefined) {
      throw deviceCodeInvalid();
    }

    const deviceId = await this.repository.upsertDevice({
      userId: state.userId,
      name: state.deviceName,
      platform: toDevicePlatform(state.platform ?? undefined),
      client: state.deviceKind === 'vscode' ? 'extension' : state.deviceKind,
      clientVersion: state.clientVersion,
      // A impressão da instalação chega no passo 1 e é o que reconhece a mesma
      // máquina depois de reinstalar a extensão.
      fingerprint: null,
      ip: origin.ip,
    });

    // O prefixo distingue a credencial de dispositivo do access token JWT no
    // mesmo header `Authorization` (ver `plugins/auth.ts`).
    const deviceToken = `${DEVICE_TOKEN_PREFIX}${randomToken()}`;
    const expiresAt = addSeconds(new Date(), AUTH_SETTINGS.deviceCredentialTtlSeconds);

    await this.repository.insertDeviceCredential({
      deviceId,
      userId: state.userId,
      tokenHash: hashToken(deviceToken),
      scope: state.organizationId,
      expiresAt,
    });

    // Passo 6 acontece no cliente: guardar em SecretStorage/Keychain. Aqui o
    // pedido é encerrado para que o mesmo device code não valha duas vezes.
    await finishDeviceFlow(this.deps.redis, deviceCode, state.userCode);

    logger.info({ deviceId, userId: state.userId }, 'device credential issued');

    return {
      deviceId,
      deviceToken,
      expiresAt: toIso(expiresAt),
      organizationId: state.organizationId,
      user: {
        id: user.id,
        name: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Convites
  // -------------------------------------------------------------------------

  /** Dispara o e-mail de convite. A gravação é do módulo de organizações. */
  sendInvitationEmail(input: {
    email: string;
    organizationName: string;
    inviterName: string;
    role: string;
    token: string;
  }): void {
    this.dispatch({
      ...invitationEmail({
        organizationName: input.organizationName,
        inviterName: input.inviterName,
        role: input.role,
        invitationUrl: `${this.deps.config.http.webUrl}/invitations/accept?token=${encodeURIComponent(input.token)}`,
        expiresInSeconds: AUTH_SETTINGS.invitationTtlSeconds,
      }),
      to: input.email,
    });
  }

  private verificationUrl(token: string): string {
    return `${this.deps.config.http.webUrl}/verify-email?token=${encodeURIComponent(token)}`;
  }
}

export function toCurrentUser(user: {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  locale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
  isPlatformAdmin?: boolean;
}): CurrentUserView {
  return {
    id: user.id,
    name: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    emailVerified: user.emailVerifiedAt !== null,
    locale: user.locale,
    timeZone: user.timezone,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt),
    isPlatformAdmin: user.isPlatformAdmin === true,
  };
}

export function toSessionOrganization(row: MembershipRow): SessionOrganization {
  return {
    id: row.organizationId,
    name: row.organizationName,
    slug: row.organizationSlug,
    role: row.roleSlug as Role,
  };
}
