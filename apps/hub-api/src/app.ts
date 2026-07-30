/**
 * Montagem da aplicação.
 *
 * A ordem de registro não é arbitrária — cada passo depende do anterior:
 *
 * ```text
 * config  → o resto lê `app.appConfig`
 * logger  → precisa do nível e do ambiente
 * erro    → registrado cedo para capturar falha de qualquer plugin seguinte
 * banco   → `authenticate` consulta usuário e sessão
 * redis   → rate limit e denylist
 * e-mail  → `/health/ready` verifica o transporte
 * segurança → CORS, CSP, CSRF antes de qualquer rota existir
 * rate limit → precisa do Redis
 * auth    → decora `authenticate` e `requirePermission`; precisa de banco e Redis
 * openapi → precisa estar registrado antes das rotas para enxergá-las
 * rotas   → o que sobra
 * ```
 *
 * `buildApp` não escuta porta: quem faz isso é `server.ts`. Assim o teste usa
 * `app.inject()` sem abrir socket, e o servidor de produção controla o
 * desligamento.
 */

import { API_PREFIX } from '@prometheon/contracts';
import { configureRootLogger, getRootLogger } from '@prometheon/logger';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { getConfig, PAYLOAD_LIMITS, runtimeSettings, type AppConfig } from './config/index.js';
import { createMailService } from './mail/index.js';
import type { MailService } from './mail/types.js';
import { auditRoutes } from './modules/audit/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { AuthService } from './modules/auth/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { OrganizationService } from './modules/organizations/service.js';
import { registerAuth } from './plugins/auth.js';
import { registerDatabase, type DatabaseHandles } from './plugins/database.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerObservability } from './plugins/observability.js';
import { registerOpenapi } from './plugins/openapi.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { generateRequestId, registerRequestContext } from './plugins/request-context.js';
import { registerRedis } from './plugins/redis.js';
import { registerSecurity } from './plugins/security.js';

export interface BuildAppOptions {
  /** Configuração pronta. Os testes passam a deles; o servidor lê do ambiente. */
  readonly config?: AppConfig | undefined;
  /** Banco já aberto, usado pelos testes contra banco descartável. */
  readonly databaseHandles?: DatabaseHandles | undefined;
  /** Serviço de e-mail já montado, para o teste inspecionar as mensagens. */
  readonly mailer?: MailService | undefined;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly authService: AuthService;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? getConfig();
  const settings = runtimeSettings();

  // O logger raiz é configurado antes do Fastify para que a própria construção
  // da aplicação já saia com o formato e o nível corretos.
  configureRootLogger({ env: config.env, level: config.logLevel });

  // As opções são anotadas antes de entrar em `Fastify()`: a função tem uma
  // sobrecarga por tipo de servidor, e sem a anotação a inferência escolhe a de
  // HTTP/2 assim que aparece uma chave que ela não reconhece de imediato.
  const serverOptions: FastifyServerOptions = {
    loggerInstance: getRootLogger(),
    genReqId: generateRequestId,
    // Teto global do corpo. Rotas de autenticação apertam mais (16 KiB).
    bodyLimit: PAYLOAD_LIMITS.global,
    // `x-request-id` do cliente é ignorado: o identificador é sempre nosso.
    requestIdHeader: false,
    // Confiar no proxy é o que faz `request.ip` valer algo atrás de um load
    // balancer — e é justamente o que torna o rate limit por IP correto.
    trustProxy: true,
    // O log de acesso é emitido por `plugins/observability.ts`, com rota, status
    // e duração — o par padrão do Fastify (uma linha ao receber, outra ao
    // responder) só duplicaria isso.
    logController: new LogController({ disableRequestLogging: true }),
  };

  const app = Fastify(serverOptions).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('appConfig', config);

  registerErrorHandler(app);
  registerRequestContext(app);
  registerObservability(app);

  await registerDatabase(app, {
    handles: options.databaseHandles,
    owned: options.databaseHandles === undefined,
  });
  await registerRedis(app);

  const mailer =
    options.mailer ??
    (await createMailService({
      config,
      mode: settings.mailTransport,
      captureDirectory: settings.mailCaptureDir,
    }));

  app.decorate('mailer', mailer);

  if (options.mailer === undefined) {
    app.addHook('onClose', async () => {
      await mailer.close();
    });
  }

  await registerSecurity(app);
  await registerRateLimit(app);
  registerAuth(app);
  await registerOpenapi(app);

  const authService = new AuthService({
    db: app.db,
    redis: app.redis,
    mailer,
    config,
  });

  const organizationService = new OrganizationService({
    db: app.db,
    config,
    authService,
  });

  // Health fica fora do prefixo: descreve o processo, não a v1 da API.
  await app.register(healthRoutes);

  await app.register(
    async (scope) => {
      await scope.register(authRoutes, { service: authService });
      await scope.register(organizationRoutes, { service: organizationService });
      await scope.register(auditRoutes);
    },
    { prefix: API_PREFIX },
  );

  // Entregas de e-mail em voo não podem morrer com o processo.
  app.addHook('onClose', async () => {
    await authService.flushPendingMail();
  });

  return { app, authService };
}
