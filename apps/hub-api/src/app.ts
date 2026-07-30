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
import type { Database } from '@prometheon/database';
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
import { accountRoutes } from './modules/account/routes.js';
import { AccountService } from './modules/account/service.js';
import { createGovernanceQueues } from './modules/audit/queue.js';
import { auditRoutes } from './modules/audit/routes.js';
import { AuditService } from './modules/audit/service.js';
import { authRoutes } from './modules/auth/routes.js';
import { DeviceRepository } from './modules/devices/repository.js';
import { deviceRoutes } from './modules/devices/routes.js';
import { DeviceService } from './modules/devices/service.js';
import type { GitHubClient } from './modules/auth/github.js';
import { AuthService } from './modules/auth/service.js';
import { billingRoutes } from './modules/billing/routes.js';
import { BillingService } from './modules/billing/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { knowledgeRoutes } from './modules/knowledge/routes.js';
import { KnowledgeService } from './modules/knowledge/service.js';
import { createRealtimeModule } from './modules/realtime/module.js';
import { realtimeRoutes } from './modules/realtime/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { OrganizationService } from './modules/organizations/service.js';

import { conversationRoutes } from './modules/conversations/routes.js';
import { ConversationService } from './modules/conversations/service.js';
import { messageRoutes } from './modules/messages/routes.js';
import { MessageService } from './modules/messages/service.js';
import { projectRoutes } from './modules/projects/routes.js';
import { ProjectService } from './modules/projects/service.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { TaskService } from './modules/tasks/service.js';
import { registerAuth } from './plugins/auth.js';
import { registerDatabase } from './plugins/database.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerObservability } from './plugins/observability.js';
import { registerOpenapi } from './plugins/openapi.js';
import { registerWebsocket } from './plugins/websocket.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { generateRequestId, registerRequestContext } from './plugins/request-context.js';
import { registerRedis } from './plugins/redis.js';
import { registerSecurity } from './plugins/security.js';

export interface BuildAppOptions {
  /** Configuração pronta. Os testes passam a deles; o servidor lê do ambiente. */
  readonly config?: AppConfig | undefined;
  /** Conexão já aberta, usada pelos testes contra banco descartável. */
  readonly database?: Database | undefined;
  /** Serviço de e-mail já montado, para o teste inspecionar as mensagens. */
  readonly mailer?: MailService | undefined;
  /**
   * Liga os temporizadores do tempo real (heartbeat, varredura de presença,
   * revalidação de acesso). O teste os desliga para controlar o relógio.
   */
  readonly realtimeTimers?: boolean | undefined;
  /**
   * Cliente do provedor de identidade. Só o teste passa: em produção ele é
   * construído a partir da configuração, e um teste que fala com o GitHub de
   * verdade falha por motivos que nada dizem sobre o código.
   */
  readonly githubClient?: GitHubClient | undefined;
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
    db: options.database,
    owned: options.database === undefined,
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
  // WebSocket antes das rotas: `{ websocket: true }` só existe depois deste
  // registro.
  await registerWebsocket(app);
  await registerOpenapi(app);

  const authService = new AuthService({
    db: app.db,
    redis: app.redis,
    mailer,
    config,
    ...(options.githubClient === undefined ? {} : { githubClient: options.githubClient }),
  });

  const accountService = new AccountService({ db: app.db, redis: app.redis });

  const organizationService = new OrganizationService({
    db: app.db,
    config,
    authService,
  });

  // O módulo de tempo real é um só para o processo: dois assinariam o mesmo
  // canal do Redis e cada evento chegaria duplicado a quem está conectado.
  const realtime = createRealtimeModule(app, {
    ...(options.realtimeTimers === undefined ? {} : { timers: options.realtimeTimers }),
  });

  const deviceService = new DeviceService({
    repository: new DeviceRepository(app.db),
    realtimeRepository: realtime.repository,
    presence: realtime.presence,
    redis: app.redis,
    keys: realtime.keys,
    hub: realtime.hub,
  });

  const knowledgeService = new KnowledgeService(app.db);
  const billingService = new BillingService(app.db);

  // As filas de governança usam conexão própria: o BullMQ administra o próprio
  // prefixo de chave e exige `maxRetriesPerRequest: null`, o que o `app.redis`
  // não pode ter.
  const governanceQueues = createGovernanceQueues(config);

  app.addHook('onClose', async () => {
    await governanceQueues.close();
  });

  const auditService = new AuditService(app.db, governanceQueues);

  const projectService = new ProjectService({ db: app.db });
  const conversationService = new ConversationService({ db: app.db });
  const messageService = new MessageService({ db: app.db });
  const taskService = new TaskService({ db: app.db });

  // Health fica fora do prefixo: descreve o processo, não a v1 da API.
  await app.register(healthRoutes);

  await app.register(
    async (scope) => {
      await scope.register(authRoutes, { service: authService });
      await scope.register(accountRoutes, { service: accountService });
      await scope.register(organizationRoutes, { service: organizationService });
      await scope.register(knowledgeRoutes, { service: knowledgeService });
      await scope.register(billingRoutes, { service: billingService });
      await scope.register(auditRoutes, { service: auditService });

      await scope.register(projectRoutes, { service: projectService });
      await scope.register(conversationRoutes, {
        service: conversationService,
        messages: messageService,
      });
      await scope.register(messageRoutes, {
        service: messageService,
        conversations: conversationService,
      });
      await scope.register(taskRoutes, { service: taskService });
      await scope.register(realtimeRoutes, { module: realtime });
      await scope.register(deviceRoutes, { service: deviceService });
    },
    { prefix: API_PREFIX },
  );

  // Entregas de e-mail em voo não podem morrer com o processo.
  app.addHook('onClose', async () => {
    await authService.flushPendingMail();
  });

  return { app, authService };
}
