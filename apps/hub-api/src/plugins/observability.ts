/**
 * Observabilidade da borda HTTP.
 *
 * O `Docs/11` pede métricas RED (taxa, erro, duração) e correlação por
 * `requestId`. Aqui ficam as duas primeiras coisas: o log de acesso estruturado
 * e os contadores em memória de `http_requests_total` e `http_request_duration`.
 *
 * LIMITAÇÃO CONHECIDA: as métricas ainda não saem por OpenTelemetry nem por um
 * endpoint de scrape — o `Docs/11` pede OTel, e o exportador entra junto com o
 * `otel-collector` do compose. Os contadores já existem e ficam agregados por
 * rota e status, então trocar o destino não muda quem os alimenta.
 *
 * O log de acesso registra método, rota (o padrão, não a URL com os ids), status
 * e duração. Nunca corpo, nunca query string: elas carregam token em fluxos de
 * verificação de e-mail e de convite.
 */

import { child } from '@prometheon/logger';
import type { FastifyInstance } from 'fastify';

export interface RouteMetric {
  /** `http_requests_total`, quebrado por classe de status. */
  total: number;
  byStatusClass: Record<string, number>;
  /** `http_request_duration`: soma e máximo, em milissegundos. */
  durationSumMs: number;
  durationMaxMs: number;
}

export interface MetricsSnapshot {
  readonly requestsTotal: number;
  readonly errorsTotal: number;
  readonly routes: Readonly<Record<string, RouteMetric>>;
}

const routes = new Map<string, RouteMetric>();
let requestsTotal = 0;
let errorsTotal = 0;

function record(routeKey: string, statusCode: number, durationMs: number): void {
  requestsTotal += 1;

  if (statusCode >= 500) {
    errorsTotal += 1;
  }

  const statusClass = `${String(Math.floor(statusCode / 100))}xx`;
  const current = routes.get(routeKey) ?? {
    total: 0,
    byStatusClass: {},
    durationSumMs: 0,
    durationMaxMs: 0,
  };

  current.total += 1;
  current.byStatusClass[statusClass] = (current.byStatusClass[statusClass] ?? 0) + 1;
  current.durationSumMs += durationMs;
  current.durationMaxMs = Math.max(current.durationMaxMs, durationMs);
  routes.set(routeKey, current);
}

export function metricsSnapshot(): MetricsSnapshot {
  return {
    requestsTotal,
    errorsTotal,
    routes: Object.fromEntries(routes),
  };
}

/** Existe para os testes: zera os contadores entre suítes. */
export function resetMetrics(): void {
  routes.clear();
  requestsTotal = 0;
  errorsTotal = 0;
}

export function registerObservability(app: FastifyInstance): void {
  const logger = child('http');

  app.addHook('onResponse', (request, reply, done) => {
    // A chave é o padrão da rota (`/v1/organizations/:orgId`), não a URL
    // concreta: agregar por URL criaria uma série por identificador.
    const routeKey = `${request.method} ${request.routeOptions.url ?? 'unmatched'}`;
    const durationMs = reply.elapsedTime;

    record(routeKey, reply.statusCode, durationMs);

    logger.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? null,
        statusCode: reply.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      },
      'request completed',
    );

    done();
  });
}
