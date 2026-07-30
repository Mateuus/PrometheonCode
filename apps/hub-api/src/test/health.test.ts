/**
 * Health e envelope de resposta.
 *
 * Além dos três endpoints do `Docs/06`, esta suíte cobre o que vale para toda a
 * API: envelope de sucesso, envelope de erro, `requestId` em ambos e os headers
 * de segurança.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { metricsSnapshot, resetMetrics } from '../plugins/observability.js';
import { body, createHarness, probeServices, type TestHarness } from './support.js';

const probe = await probeServices();

describe.skipIf(!probe.ok)('health e convenções da API', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createHarness({ prefix: 'prometheon_health' });
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('/health/live responde sem tocar em dependência', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(body<{ status: string }>(response).status).toBe('ok');
  });

  it('/health/ready confere MySQL, Redis e o transporte de e-mail', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);

    const payload = body<{
      status: string;
      checks: { name: string; status: string }[];
    }>(response);

    expect(payload.status).toBe('ok');
    expect(payload.checks.map((check) => check.name).sort()).toEqual([
      'mysql',
      'redis',
      'smtp',
    ]);
  });

  it('/health/version identifica o build', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health/version' });

    expect(response.statusCode).toBe(200);
    expect(body<{ service: string; apiVersion: string }>(response)).toMatchObject({
      service: 'hub-api',
      apiVersion: 'v1',
    });
  });

  it('toda resposta de sucesso vem no envelope com requestId', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset',
      payload: { email: 'quem.nao.existe@example.test' },
    });

    expect(response.statusCode).toBe(202);

    const payload = body<{ data: unknown; meta: { requestId: string } }>(response);

    expect(payload.data).toEqual({});
    expect(payload.meta.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(response.headers['x-request-id']).toBe(payload.meta.requestId);
  });

  it('toda resposta de erro vem no envelope com código estável', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/nao-existe' });

    expect(response.statusCode).toBe(404);
    expect(body<{ error: { code: string; requestId: string } }>(response).error).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('erro de validação diz o campo e não devolve o valor enviado', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nao-e-email', password: 'curta' },
    });

    expect(response.statusCode).toBe(400);

    const payload = body<{ error: { code: string; fields?: { path: string }[] } }>(response);

    expect(payload.error.code).toBe('VALIDATION_FAILED');
    expect(payload.error.fields?.map((field) => field.path)).toContain('email');
    expect(response.payload).not.toContain('curta');
  });

  it('aplica os headers de segurança', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health/live' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(String(response.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('recusa payload acima do limite da rota', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'grande@example.test',
        password: 'x'.repeat(64_000),
      },
    });

    expect(response.statusCode).toBe(413);
    expect(body<{ error: { code: string } }>(response).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('conta as métricas RED por rota e classe de status', async () => {
    resetMetrics();

    await harness.app.inject({ method: 'GET', url: '/health/live' });
    await harness.app.inject({ method: 'GET', url: '/health/live' });
    await harness.app.inject({ method: 'GET', url: '/v1/me' });

    const snapshot = metricsSnapshot();

    expect(snapshot.requestsTotal).toBe(3);
    // Nada de 5xx: 401 é resposta correta, não falha do servidor.
    expect(snapshot.errorsTotal).toBe(0);

    const live = snapshot.routes['GET /health/live'];

    expect(live?.total).toBe(2);
    expect(live?.byStatusClass['2xx']).toBe(2);
    expect(snapshot.routes['GET /v1/me']?.byStatusClass['4xx']).toBe(1);
    // A chave é o padrão da rota, não a URL concreta.
    expect(Object.keys(snapshot.routes)).not.toContain('GET /v1/organizations/01ABC');
  });

  it('gera OpenAPI 3.1 com as rotas registradas', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(response.statusCode).toBe(200);

    const document = body<{ openapi: string; paths: Record<string, unknown> }>(response);

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/v1/auth/login', '/v1/me', '/health/ready']),
    );
  });
});

describe.skipIf(probe.ok)('health (pulado)', () => {
  it(`dependências indisponíveis: ${probe.reason}`, () => {
    expect(probe.ok).toBe(false);
  });
});
