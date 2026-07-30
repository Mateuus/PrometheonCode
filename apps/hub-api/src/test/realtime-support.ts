/**
 * Apoio aos testes de tempo real e de dispositivo.
 *
 * Segue as mesmas regras de `support.ts` — MySQL e Redis reais, banco
 * descartável por suíte, nada de `prometheon_dev` — e acrescenta o que o
 * WebSocket exige:
 *
 * - **porta de verdade.** `app.inject()` não faz upgrade de protocolo; o teste
 *   precisa de um socket, então o harness escuta em `127.0.0.1:0` e devolve a
 *   porta que o sistema escolheu.
 * - **prefixo de chave próprio.** O prefixo entra na configuração, não só nas
 *   chaves: ele também nomeia o **canal** de pub/sub, então duas execuções
 *   simultâneas não enxergam os eventos uma da outra. No fim tudo que começa
 *   com ele é apagado do servidor.
 * - **relógios desligados.** Heartbeat, varredura e revalidação são disparados à
 *   mão pelo teste. Esperar trinta segundos por um `setInterval` seria um teste
 *   lento e, pior, intermitente.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '@prometheon/config';
import { newId, runMigrations, runSeed } from '@prometheon/database';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { createConnection } from 'mysql2/promise';
import { WebSocket } from 'ws';

import { buildApp } from '../app.js';
import { createMailService } from '../mail/index.js';
import type { MailService } from '../mail/types.js';
import type { AuthService } from '../modules/auth/service.js';
import type { RealtimeModule } from '../modules/realtime/module.js';
import { createDatabaseHandles } from '../plugins/database.js';
import { testConfig } from './support.js';

export interface RealtimeHarness {
  readonly app: FastifyInstance;
  readonly authService: AuthService;
  readonly config: AppConfig;
  readonly realtime: RealtimeModule;
  readonly databaseName: string;
  readonly keyPrefix: string;
  readonly mailDirectory: string;
  readonly mailer: MailService;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly dispose: () => Promise<void>;
}

export async function createRealtimeHarness(
  options: { prefix?: string } = {},
): Promise<RealtimeHarness> {
  const base = testConfig();
  const suffix = newId().slice(-12).toLowerCase();
  const databaseName = `${options.prefix ?? 'prometheon_rttest'}_${suffix}`;
  const keyPrefix = `rttest:${suffix}:`;

  const admin = await createConnection({
    host: base.database.host,
    port: base.database.port,
    user: base.database.user,
    password: base.database.password,
    connectTimeout: 5_000,
  });

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await admin.end();
  }

  await runMigrations({ database: databaseName });
  await runSeed({ database: databaseName });

  const config: AppConfig = {
    ...base,
    database: { ...base.database, name: databaseName },
    redis: { ...base.redis, keyPrefix },
  };

  const handles = createDatabaseHandles(config, { connectionLimit: 5 });
  const mailDirectory = await mkdtemp(join(tmpdir(), 'prometheon-rt-mail-'));
  const mailer = await createMailService({
    config,
    mode: 'capture',
    captureDirectory: mailDirectory,
  });

  const { app, authService } = await buildApp({
    config,
    databaseHandles: handles,
    mailer,
    realtimeTimers: false,
  });

  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('O servidor de teste não abriu uma porta TCP.');
  }

  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    app,
    authService,
    config,
    realtime: app.realtime,
    databaseName,
    keyPrefix,
    mailDirectory,
    mailer,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${String(address.port)}/v1/realtime`,
    dispose: async () => {
      await authService.flushPendingMail();
      await app.close();
      await handles.pool.end();
      await mailer.close();
      await purgeKeys(config, keyPrefix);

      const cleanup = await createConnection({
        host: base.database.host,
        port: base.database.port,
        user: base.database.user,
        password: base.database.password,
        connectTimeout: 5_000,
      });

      try {
        await cleanup.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * Apaga tudo que a suíte escreveu no Redis.
 *
 * `SCAN` e não `KEYS`: o servidor é compartilhado com o desenvolvimento, e um
 * `KEYS` num banco grande bloqueia o processo inteiro do Redis.
 */
async function purgeKeys(config: AppConfig, keyPrefix: string): Promise<void> {
  const redis = new Redis(
    config.redis.url ?? `redis://${config.redis.host ?? '127.0.0.1'}:${String(config.redis.port)}`,
    { db: config.redis.db, lazyConnect: true, maxRetriesPerRequest: 1 },
  );

  try {
    await redis.connect();

    let cursor = '0';

    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 500);

      cursor = next;

      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

/** Mensagem do servidor, na forma frouxa que o teste inspeciona. */
export interface ServerFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Cliente WebSocket de teste.
 *
 * Guarda tudo que chegou e oferece espera por predicado: `waitFor` resolve com a
 * primeira mensagem que casa, inclusive uma que já tenha chegado antes da
 * chamada. Sem isso o teste teria corrida com o próprio servidor.
 */
export class TestClient {
  readonly frames: ServerFrame[] = [];
  readonly socket: WebSocket;

  #closeCode: number | undefined;
  #closed = false;
  readonly #waiters: { match: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] =
    [];
  readonly #closeWaiters: ((code: number) => void)[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;

    socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString('utf8')) as ServerFrame;

      this.frames.push(frame);

      for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.#waiters[index];

        if (waiter?.match(frame) === true) {
          this.#waiters.splice(index, 1);
          waiter.resolve(frame);
        }
      }
    });

    socket.on('close', (code: number) => {
      this.#closed = true;
      this.#closeCode = code;

      for (const resolve of this.#closeWaiters.splice(0)) {
        resolve(code);
      }
    });
  }

  static async connect(url: string, token: string): Promise<TestClient> {
    const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', (code: number) => {
        reject(new Error(`O socket fechou antes de abrir (código ${String(code)}).`));
      });
    });

    socket.removeAllListeners('close');

    return new TestClient(socket);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeCode(): number | undefined {
    return this.#closeCode;
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Primeira mensagem que casa, olhando também o que já chegou. */
  async waitFor(
    match: (frame: ServerFrame) => boolean,
    timeoutMs = 10_000,
  ): Promise<ServerFrame> {
    const existing = this.frames.find((frame) => match(frame));

    if (existing !== undefined) {
      return existing;
    }

    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Nenhuma mensagem casou em ${String(timeoutMs)} ms. Recebidas: ${this.frames
              .map((frame) => frame.type)
              .join(', ')}`,
          ),
        );
      }, timeoutMs);

      this.#waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  async waitForType(type: string, timeoutMs = 10_000): Promise<ServerFrame> {
    return this.waitFor((frame) => frame.type === type, timeoutMs);
  }

  async waitForClose(timeoutMs = 10_000): Promise<number> {
    if (this.#closed) {
      return this.#closeCode ?? 1006;
    }

    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`O socket não fechou em ${String(timeoutMs)} ms.`));
      }, timeoutMs);

      this.#closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

/** Chamada HTTP contra o servidor real (o WebSocket exige porta aberta). */
export async function call(
  harness: RealtimeHarness,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }

  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();

  let json: Record<string, unknown>;

  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }

  return { status: response.status, json };
}

/** Token de handshake para uma credencial. */
export async function realtimeToken(harness: RealtimeHarness, accessToken: string): Promise<string> {
  const response = await call(harness, 'GET', '/v1/realtime/token', { token: accessToken });

  if (response.status !== 200) {
    throw new Error(`Falha ao emitir o token de realtime: ${JSON.stringify(response.json)}`);
  }

  return (response.json['data'] as { token: string }).token;
}
