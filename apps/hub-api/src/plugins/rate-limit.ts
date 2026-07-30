/**
 * Rate limit por IP, usuário, organização e rota (`Docs/06`, `Docs/09`).
 *
 * As quatro dimensões não cabem num contador só, então são três mecanismos que
 * se somam:
 *
 * 1. `@fastify/rate-limit` global, com chave por IP — a defesa que funciona
 *    antes de saber quem está chamando.
 * 2. `@fastify/rate-limit` por rota, com tetos próprios em login, registro,
 *    recuperação de senha e device flow. A chave já inclui a rota, então cada
 *    endpoint tem seu balde.
 * 3. `consumeRateLimit`, um contador manual chamado nos pontos em que a
 *    identidade já é conhecida: por usuário dentro de `authenticate`, por
 *    organização dentro de `requirePermission`, e por device code no polling.
 *
 * O estado vive no Redis, então o limite é do serviço e não da réplica.
 */

import rateLimit from '@fastify/rate-limit';
import type { ErrorCode } from '@prometheon/contracts';
import type { FastifyContextConfig, FastifyInstance, FastifyRequest } from 'fastify';

import { RATE_LIMITS, runtimeSettings, type RateLimitTier } from '../config/index.js';
import { tooManyRequests } from '../shared/errors.js';
import type { RedisClient } from './redis.js';

/** Endereço do cliente, considerando o proxy reverso quando confiável. */
export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const settings = runtimeSettings();

  await app.register(rateLimit, {
    global: settings.rateLimitEnabled,
    max: RATE_LIMITS.global.max,
    timeWindow: RATE_LIMITS.global.windowSeconds * 1_000,
    redis: app.redis,
    // Prefixo próprio: o `keyPrefix` do ioredis já entra na frente, e este
    // separa os baldes de rate limit do resto das chaves da API.
    nameSpace: 'rl:global:',
    keyGenerator: (request) => clientIp(request),
    // `/health` é o que o orquestrador consulta o tempo todo; limitá-lo
    // derrubaria o serviço justamente quando ele mais precisa ser observado.
    allowList: (request) => request.url.startsWith('/health'),
    // O plugin **lança** o que este builder devolve, e o handler central é
    // quem monta o envelope. Devolver um `ApiError` mantém a resposta de 429
    // idêntica à de qualquer outro erro da API.
    errorResponseBuilder: (_request, context) =>
      tooManyRequests(
        `Too many requests. Try again in ${context.after}.`,
        new Date(Date.now() + context.ttl),
      ),
  });
}

/**
 * Configuração de rate limit para uma rota específica.
 *
 * `keyGenerator` recebe a rota no `nameSpace`, então dois endpoints com o mesmo
 * gerador continuam tendo baldes separados.
 */
export function routeRateLimit(
  tier: RateLimitTier,
  keyGenerator?: (request: FastifyRequest) => string,
): FastifyContextConfig {
  if (!runtimeSettings().rateLimitEnabled) {
    return {};
  }

  return {
    rateLimit: {
      max: tier.max,
      timeWindow: tier.windowSeconds * 1_000,
      ...(keyGenerator === undefined ? {} : { keyGenerator }),
    },
  };
}

/**
 * Chave de rate limit escopada por IP e e-mail.
 *
 * Os dois juntos: só o IP deixaria um atacante distribuído tentar uma senha em
 * mil contas, e só o e-mail deixaria alguém de fora trancar a conta de outra
 * pessoa. O e-mail entra normalizado e não hasheado — a chave vive no Redis com
 * TTL curto e carrega o mesmo valor que já veio no corpo.
 *
 * Esta chave é consumida por `enforceRateLimit` **dentro do handler**, e não
 * pelo `keyGenerator` do plugin: aquele roda em `onRequest`, antes de o corpo
 * ter sido lido, e ali `request.body` ainda é `undefined` — o limite pareceria
 * estar por e-mail e estaria, na verdade, só por IP.
 */
export function emailScopedKey(request: FastifyRequest, scope: string, email: string): string {
  return `${scope}:${clientIp(request)}|${email.trim().toLowerCase()}`;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
}

/**
 * Contador manual, para as dimensões que o plugin não alcança.
 *
 * Janela fixa: `INCR` cria a chave, e o primeiro incremento define o `EXPIRE`.
 * É mais grosseiro que uma janela deslizante — o dobro do teto passa se as
 * chamadas caírem exatamente na virada — e é o suficiente aqui, porque estes
 * contadores complementam o limite por IP em vez de substituí-lo.
 */
export async function consumeRateLimit(
  redis: RedisClient,
  key: string,
  tier: RateLimitTier,
): Promise<RateLimitVerdict> {
  const namespaced = `rl:${key}`;
  const results = await redis
    .multi()
    .incr(namespaced)
    .ttl(namespaced)
    .exec();

  const count = Number(results?.[0]?.[1] ?? 0);
  let ttl = Number(results?.[1]?.[1] ?? -1);

  if (ttl < 0) {
    await redis.expire(namespaced, tier.windowSeconds);
    ttl = tier.windowSeconds;
  }

  return {
    allowed: count <= tier.max,
    remaining: Math.max(0, tier.max - count),
    resetAt: new Date(Date.now() + ttl * 1_000),
  };
}

/** Consome e lança 429 quando estourou. */
export async function enforceRateLimit(
  redis: RedisClient,
  key: string,
  tier: RateLimitTier,
  message: string,
  code: ErrorCode = 'RATE_LIMITED',
): Promise<void> {
  if (!runtimeSettings().rateLimitEnabled) {
    return;
  }

  const verdict = await consumeRateLimit(redis, key, tier);

  if (!verdict.allowed) {
    throw tooManyRequests(message, verdict.resetAt, code);
  }
}
