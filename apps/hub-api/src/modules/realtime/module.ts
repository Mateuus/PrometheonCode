/**
 * Montagem do módulo de tempo real.
 *
 * As peças (chaves, repositório, serviço, hub) nascem juntas porque o módulo de
 * dispositivos precisa das mesmas: o heartbeat escreve na presença e publica
 * `device.changed` no canal que o hub assina. Criar duas cópias faria dois
 * assinantes do mesmo canal no mesmo processo — e cada evento chegaria duas
 * vezes a quem está conectado.
 */

import type { FastifyInstance } from 'fastify';

import { createRealtimeKeys, type RealtimeKeys } from './keys.js';
import { PresenceStore } from './presence.js';
import { RealtimeHub } from './hub.js';
import { RealtimeRepository } from './repository.js';
import { RealtimeService } from './service.js';

export interface RealtimeModule {
  readonly keys: RealtimeKeys;
  readonly repository: RealtimeRepository;
  readonly service: RealtimeService;
  readonly presence: PresenceStore;
  readonly hub: RealtimeHub;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Módulo de tempo real do processo. Um só, por desenho. */
    readonly realtime: RealtimeModule;
  }
}

export interface CreateRealtimeModuleOptions {
  /** Desliga os relógios internos; o teste dispara os passos à mão. */
  readonly timers?: boolean | undefined;
}

export function createRealtimeModule(
  app: FastifyInstance,
  options: CreateRealtimeModuleOptions = {},
): RealtimeModule {
  const keys = createRealtimeKeys(app.appConfig.redis.keyPrefix);
  const repository = new RealtimeRepository(app.db);
  const service = new RealtimeService({ repository, redis: app.redis, config: app.appConfig });
  const presence = new PresenceStore(app.redis);
  const hub = new RealtimeHub({
    redis: app.redis,
    keys,
    service,
    presence,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });

  const module: RealtimeModule = { keys, repository, service, presence, hub };

  app.decorate('realtime', module);

  app.addHook('onClose', async () => {
    await hub.close();
  });

  return module;
}
