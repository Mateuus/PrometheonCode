/**
 * Rate limit (`Docs/06`, `Docs/09`).
 *
 * Esta suíte liga o rate limit — as demais rodam com ele desligado, porque um
 * balde compartilhado no Redis faria uma suíte contaminar a seguinte.
 *
 * As chaves são limpas antes de cada caso: o Redis é o de desenvolvimento, e um
 * teste que herda o contador de uma execução anterior não prova nada.
 */

import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { body, probeServices, uniqueEmail, type TestHarness } from './support.js';

const probe = await probeServices();

describe.skipIf(!probe.ok)('rate limit', () => {
  let harness: TestHarness;
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env['RATE_LIMIT_ENABLED'];
    process.env['RATE_LIMIT_ENABLED'] = 'true';

    // O harness é importado depois de mexer no ambiente: `routeRateLimit()` lê
    // a chave no momento em que a rota é registrada.
    const { createHarness } = await import('./support.js');

    harness = await createHarness({ prefix: 'prometheon_ratelimit' });
  });

  afterAll(async () => {
    await harness?.dispose();

    if (previous === undefined) {
      delete process.env['RATE_LIMIT_ENABLED'];
    } else {
      process.env['RATE_LIMIT_ENABLED'] = previous;
    }
  });

  /** Apaga os baldes desta execução para o teste começar do zero. */
  async function clearBuckets(): Promise<void> {
    const keys = await harness.app.redis.keys(`${harness.config.redis.keyPrefix}rl:*`);

    if (keys.length > 0) {
      // O `keyPrefix` do ioredis é aplicado de novo nos comandos, então o
      // prefixo é removido antes do `del`.
      await harness.app.redis.del(
        ...keys.map((key) => key.slice(harness.config.redis.keyPrefix.length)),
      );
    }
  }

  it('barra o login depois do teto por IP e e-mail', async () => {
    await clearBuckets();

    const email = uniqueEmail('rate');
    const attempt = async () =>
      harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'uma-senha-qualquer-longa' },
      });

    const statuses: number[] = [];

    // O teto de login é 10 em 5 minutos; a décima primeira precisa cair.
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await attempt()).statusCode);
    }

    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    const blocked = await attempt();

    expect(blocked.statusCode).toBe(429);

    const error = body<{ error: { code: string; retryAfter?: string } }>(blocked).error;

    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfter).toBeDefined();
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('o teto do login é por e-mail, então outra conta continua respondendo', async () => {
    // O balde do teste anterior continua cheio para aquele e-mail; um endereço
    // diferente tem balde próprio.
    const other = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: uniqueEmail('outro'), password: 'uma-senha-qualquer-longa' },
    });

    expect(other.statusCode).toBe(401);
  });

  it('não limita os health checks', async () => {
    await clearBuckets();

    for (let index = 0; index < 30; index += 1) {
      const response = await harness.app.inject({ method: 'GET', url: '/health/live' });

      expect(response.statusCode).toBe(200);
    }
  });

  it('barra o registro depois do teto por IP', async () => {
    await clearBuckets();

    const statuses: number[] = [];

    // Registro: 5 por hora e por IP.
    for (let index = 0; index < 7; index += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          name: 'Cadastro em Massa',
          email: uniqueEmail('massa'),
          password: 'senha-do-cadastro-em-massa',
          acceptedTerms: true,
        },
      });

      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 5).every((status) => status === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe.skipIf(probe.ok)('rate limit (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
