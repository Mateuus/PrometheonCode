// Health, readiness e métricas do worker (`Docs/11`).
//
// A diferença entre os dois primeiros é o que faz o orquestrador acertar:
//
// - **`/health` (liveness)** responde enquanto o processo está vivo. Falhar
//   aqui significa "reinicie este contêiner".
// - **`/ready` (readiness)** só responde 200 quando o worker realmente pode
//   trabalhar: MySQL e Redis respondendo, e o processo não em encerramento.
//   Durante o `drain` ele devolve 503 de propósito — é assim que o orquestrador
//   para de mandar tráfego antes de o processo sair.
//
// Há também um arquivo de estado opcional (`WORKER_HEALTH_FILE`) para
// orquestração que prefere `test -f` a HTTP.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Database } from '@prometheon/database';
import type { Logger } from '@prometheon/logger';

import type { HealthSettings } from './config.js';
import { renderPrometheus, type MetricsRegistry } from './metrics.js';
import type { RedisConnection } from './redis.js';

export type WorkerState = 'starting' | 'ready' | 'draining' | 'stopped';

export interface HealthReport {
  readonly state: WorkerState;
  readonly ready: boolean;
  readonly uptimeSeconds: number;
  readonly checks: {
    readonly database: boolean;
    readonly redis: boolean;
  };
  readonly outbox: {
    readonly pending: number;
    readonly lagSeconds: number;
  };
}

export interface HealthServerOptions {
  readonly settings: HealthSettings;
  readonly db: Database;
  readonly redis: RedisConnection;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly instanceId: string;
  /** Atraso corrente do outbox, sem ir ao banco. */
  readonly outboxLag: () => { pending: number; lagMs: number };
}

/** Janela de cache da checagem de dependências. */
const PROBE_CACHE_MS = 2_000;

export class HealthServer {
  readonly #options: HealthServerOptions;
  readonly #startedAt = Date.now();

  #state: WorkerState = 'starting';
  #server: Server | undefined;
  #lastProbeAt = 0;
  #lastProbe = { database: false, redis: false };

  constructor(options: HealthServerOptions) {
    this.#options = options;
  }

  get state(): WorkerState {
    return this.#state;
  }

  /** Porta efetiva. Com `port: 0` o sistema escolhe, e é aqui que se descobre. */
  get port(): number | undefined {
    const address = this.#server?.address();
    return address !== null && typeof address === 'object' ? address.port : undefined;
  }

  /** Muda o estado e reflete no arquivo, quando ele estiver configurado. */
  async setState(state: WorkerState): Promise<void> {
    this.#state = state;
    await this.#writeStateFile();
  }

  async start(): Promise<void> {
    if (!this.#options.settings.enabled) {
      return;
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    // O servidor de health não segura o encerramento do processo.
    server.unref();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.#options.settings.port, this.#options.settings.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    this.#options.logger.info(
      { host: this.#options.settings.host, port: this.#options.settings.port },
      'health disponível',
    );
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    await this.#removeStateFile();
  }

  /** Relatório completo, também usado pelo teste e pelo log de subida. */
  async report(): Promise<HealthReport> {
    const checks = await this.#probe();
    const lag = this.#options.outboxLag();
    return {
      state: this.#state,
      ready: this.#state === 'ready' && checks.database && checks.redis,
      uptimeSeconds: Math.round((Date.now() - this.#startedAt) / 1_000),
      checks,
      outbox: { pending: lag.pending, lagSeconds: lag.lagMs / 1_000 },
    };
  }

  async #probe(): Promise<{ database: boolean; redis: boolean }> {
    const now = Date.now();
    if (now - this.#lastProbeAt < PROBE_CACHE_MS) {
      return this.#lastProbe;
    }
    this.#lastProbeAt = now;

    const [database, redis] = await Promise.all([
      // Consulta trivial: prova que dá para consultar, não só que o
      // `DataSource` foi inicializado.
      this.#options.db
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      this.#options.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    this.#lastProbe = { database, redis };
    return this.#lastProbe;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    try {
      if (path === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(renderPrometheus(this.#options.metrics.snapshot()));
        return;
      }

      if (path === '/health' || path === '/healthz' || path === '/livez') {
        // Liveness não consulta dependência: banco fora não justifica reinício.
        this.#json(response, this.#state === 'stopped' ? 503 : 200, {
          state: this.#state,
          instanceId: this.#options.instanceId,
          uptimeSeconds: Math.round((Date.now() - this.#startedAt) / 1_000),
        });
        return;
      }

      if (path === '/ready' || path === '/readyz') {
        const report = await this.report();
        this.#json(response, report.ready ? 200 : 503, report);
        return;
      }

      this.#json(response, 404, { error: 'not found' });
    } catch (error) {
      this.#options.logger.error({ err: error, path }, 'falha ao responder health');
      this.#json(response, 500, { error: 'internal error' });
    }
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload).toString(),
    });
    response.end(payload);
  }

  async #writeStateFile(): Promise<void> {
    const path = this.#options.settings.filePath;
    if (path === undefined) {
      return;
    }
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify({
          state: this.#state,
          instanceId: this.#options.instanceId,
          updatedAt: new Date().toISOString(),
        })}\n`,
        'utf8',
      );
    } catch (error) {
      this.#options.logger.warn({ err: error, path }, 'não foi possível gravar o arquivo de health');
    }
  }

  async #removeStateFile(): Promise<void> {
    const path = this.#options.settings.filePath;
    if (path === undefined) {
      return;
    }
    await rm(path, { force: true }).catch(() => undefined);
  }
}
