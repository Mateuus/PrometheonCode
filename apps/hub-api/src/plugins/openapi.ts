/**
 * OpenAPI 3.1, gerada a partir dos schemas Zod das rotas (`Docs/03`).
 *
 * Gerada, não escrita à mão: um documento mantido em paralelo ao código começa
 * errado no primeiro dia. O `fastify-type-provider-zod` converte os mesmos
 * schemas que validam a requisição em runtime, então documento e comportamento
 * não conseguem divergir.
 *
 * O JSON fica em `/v1/openapi.json` e a interface de leitura em `/docs`. Em
 * produção a interface é desligada: ela não expõe segredo, mas também não
 * precisa estar de pé num serviço público.
 */

import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { API_PREFIX } from '@prometheon/contracts';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

import { runtimeSettings } from '../config/index.js';

export async function registerOpenapi(app: FastifyInstance): Promise<void> {
  const config = app.appConfig;
  const settings = runtimeSettings();

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Prometheon Hub API',
        version: settings.serviceVersion,
        description: [
          'Every successful response uses the `{ data, meta: { requestId } }` envelope,',
          'and every error uses `{ error: { code, message, requestId } }`.',
          'Lists are paginated by opaque cursor. Timestamps are ISO 8601 UTC.',
        ].join(' '),
      },
      // Sem o `/v1` no servidor: `stripBasePath` cortaria o prefixo de cada
      // rota e o documento mostraria `/auth/login` ao lado de `/health/live`,
      // como se os dois estivessem no mesmo lugar.
      servers: [{ url: config.http.apiUrl }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access token from POST /auth/login, or a device credential from the device flow (prefixed with pdt_).',
          },
        },
      },
      tags: [
        { name: 'auth', description: 'Registration, sessions, device flow' },
        { name: 'organizations', description: 'Tenants, members and invitations' },
        { name: 'devices', description: 'Extension and CLI installations' },
        { name: 'audit', description: 'Audit log' },
        { name: 'health', description: 'Liveness, readiness and version' },
      ],
    },
    transform: jsonSchemaTransform,
    stripBasePath: false,
  });

  // O JSON vive sob `/v1` porque descreve a v1 da API; a interface de leitura
  // não é versionada e fica na raiz.
  app.get(
    `${API_PREFIX}/openapi.json`,
    { schema: { hide: true } },
    () => app.swagger(),
  );

  if (!config.isProduction) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
      staticCSP: false,
    });
  }
}
