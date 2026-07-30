/**
 * Controles de borda do `Docs/09`: CORS, CSP e demais headers, CSRF e limite de
 * payload.
 *
 * **CORS** é uma lista explícita (`CORS_ORIGINS`). O esquema de
 * `@prometheon/config` já recusa `*`; aqui a origem só entra na resposta se
 * estiver na lista, e `credentials` é ligado porque o Hub Web autentica o
 * refresh por cookie.
 *
 * **CSRF** é double-submit cookie, e só entra em cena onde faz diferença:
 * requisição mutante que chega **com o cookie de refresh**. É a única superfície
 * em que o navegador anexa credencial sozinho — chamadas com
 * `Authorization: Bearer` (extensão, Core local, Hub Web depois do login) não
 * são forjáveis por um site terceiro, porque nenhum navegador anexa esse header
 * automaticamente. Além do par cookie/header, a origem é conferida contra a
 * mesma lista do CORS: `SameSite=Strict` já barra quase tudo, e as duas
 * verificações juntas cobrem os navegadores que tratam `SameSite` de forma
 * própria.
 */

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { cookieProfile } from '../config/index.js';
import { randomToken, safeEqual } from '../shared/crypto.js';
import { forbidden } from '../shared/errors.js';

/** Métodos que não mudam estado e, por isso, não precisam de CSRF. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Prefixo cuja resposta nunca pode ser cacheada por proxy ou navegador. */
const NO_STORE_PREFIXES = ['/v1/auth', '/v1/me', '/v1/devices'];

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const config = app.appConfig;
  const cookies = cookieProfile(config);
  const allowedOrigins = new Set(config.http.corsOrigins);

  await app.register(cookie, {
    // Sem `secret`: nenhum cookie desta API é assinado. O de refresh guarda um
    // token de 256 bits que já é verificado contra o hash no banco, e o de CSRF
    // só precisa ser imprevisível — assinar os dois seria cerimônia sem efeito.
    parseOptions: {
      httpOnly: true,
      secure: cookies.secure,
      sameSite: cookies.sameSite,
      path: cookies.path,
    },
  });

  await app.register(cors, {
    origin(origin, callback) {
      // Sem `Origin` é chamada que não veio de navegador (curl, extensão,
      // servidor); não há o que liberar nem o que bloquear no CORS.
      if (origin === undefined || origin === '') {
        callback(null, true);

        return;
      }

      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-csrf-token',
      'x-correlation-id',
      'idempotency-key',
      'if-match',
    ],
    exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    maxAge: 600,
  });

  await app.register(helmet, {
    // Esta API devolve JSON. Uma CSP que nega tudo é a resposta certa: se algum
    // dia uma resposta escapar como HTML, o navegador não executa nada dela.
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS só faz sentido sob HTTPS; em `http://127.0.0.1` o header seria
    // ignorado pelo navegador e confundiria quem lê a resposta.
    hsts: cookies.secure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    // O Swagger UI precisa de estilo e script próprios; a exceção é aplicada
    // abaixo, por rota, em vez de afrouxar a CSP de toda a API.
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith('/docs')) {
      void reply.removeHeader('content-security-policy');
    }

    if (NO_STORE_PREFIXES.some((prefix) => request.url.startsWith(prefix))) {
      void reply.header('cache-control', 'no-store');
      void reply.header('pragma', 'no-cache');
    }

    done(null, payload);
  });

  // Garante o cookie legível do double-submit. Ele não é segredo compartilhado
  // com o servidor: o valor só precisa ser imprevisível para um site terceiro,
  // que não consegue lê-lo por causa da política de mesma origem.
  app.addHook('onRequest', (request, reply, done) => {
    if (request.cookies[cookies.csrfName] === undefined) {
      void reply.setCookie(cookies.csrfName, randomToken(16), {
        httpOnly: false,
        secure: cookies.secure,
        sameSite: cookies.sameSite,
        path: cookies.path,
        maxAge: 60 * 60 * 12,
      });
    }

    done();
  });

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method)) {
      return;
    }

    const refreshCookie = request.cookies[cookies.refreshName];

    // Sem cookie de refresh não há credencial ambiente: a requisição só vale se
    // trouxer um Bearer, e aí o CSRF não se aplica.
    if (refreshCookie === undefined) {
      return;
    }

    const origin = request.headers.origin;

    if (typeof origin === 'string' && origin !== '' && !allowedOrigins.has(origin)) {
      throw forbidden('The request origin is not allowed.', 'FORBIDDEN');
    }

    const cookieValue = request.cookies[cookies.csrfName];
    const headerValue = request.headers['x-csrf-token'];
    const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (
      cookieValue === undefined ||
      header === undefined ||
      header === '' ||
      !safeEqual(cookieValue, header)
    ) {
      throw forbidden(
        'Missing or invalid CSRF token. Send the value of the CSRF cookie in the x-csrf-token header.',
        'FORBIDDEN',
      );
    }
  });
}
