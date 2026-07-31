/**
 * Rotas de health (`Docs/06`).
 *
 * Ficam **fora** do prefixo `/v1`: elas descrevem o processo, não a API, e
 * precisam continuar respondendo no mesmo endereço quando a v2 existir. Também
 * ficam fora do rate limit — limitar a sonda do orquestrador é a receita para o
 * serviço ser reiniciado justamente quando está sob carga.
 */

import {
  livenessResponseSchema,
  readinessResponseSchema,
  versionResponseSchema,
} from '@prometheon/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { runtimeSettings } from '../../config/index.js';
import { checkReadiness } from './service.js';

const startedAt = Date.now();

// Plugin síncrono: registrar rota não espera nada. `FastifyPluginCallbackZod`
// é a forma que o Fastify oferece para isso — `async` sem `await` só
// esconderia que não há trabalho assíncrono aqui.
export const healthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['health'],
        summary: 'The process is running',
        description:
          'Answers without touching any dependency: it says the event loop is alive, nothing else.',
        response: { 200: livenessResponseSchema },
      },
    },
    () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
    }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'The dependencies answer',
        description:
          'Cheap probes only: SELECT 1, PING and a mail transport check. 503 when a required dependency is down.',
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
    },
    async (_request, reply) => {
      const report = await checkReadiness({
        db: app.db,
        redis: app.redis,
        mailer: app.mailer,
      });

      // `degraded` continua 200: a API atende, só não atende tudo.
      return reply.code(report.status === 'down' ? 503 : 200).send(report);
    },
  );

  app.get(
    '/health/version',
    {
      schema: {
        tags: ['health'],
        summary: 'Which build is running',
        response: { 200: versionResponseSchema },
      },
    },
    () => {
      const settings = runtimeSettings();

      return {
        service: 'hub-api',
        version: settings.serviceVersion,
        commit: settings.commitSha ?? null,
        builtAt: settings.builtAt ?? null,
        environment: app.appConfig.env,
        apiVersion: 'v1' as const,
      };
    },
  );

  done();
};
