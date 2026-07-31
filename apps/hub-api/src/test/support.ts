/**
 * Apoio aos testes de integração.
 *
 * Regras que valem para toda a suíte:
 *
 * - Os testes falam com o **MySQL e o Redis reais**. Um mock de banco não prova
 *   que o `UPDATE ... WHERE used_at IS NULL` da rotação de refresh funciona sob
 *   concorrência, que é justamente o que precisa ser provado.
 * - O banco é **descartável**: nome único por execução, migrado do zero e
 *   derrubado no final. `prometheon_dev` nunca é tocado.
 * - Se as dependências não estiverem acessíveis, a suíte **pula com motivo
 *   claro** em vez de falhar — pipeline vermelho por infraestrutura ausente
 *   ensina a ignorar o vermelho.
 */

import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type AppConfig } from '@prometheon/config';
import { closeDatabase, newId, runMigrations, runSeed } from '@prometheon/database';
import type { FastifyInstance } from 'fastify';
import { createConnection } from 'mysql2/promise';
import { Redis } from 'ioredis';

import { buildApp } from '../app.js';
import { createDatabaseHandles } from '../plugins/database.js';
import { createMailService } from '../mail/index.js';
import type { MailService } from '../mail/types.js';
import type { GitHubClient } from '../modules/auth/github.js';
import type { AuthService } from '../modules/auth/service.js';

export interface Probe {
  readonly ok: boolean;
  readonly reason: string;
}

let baseConfig: AppConfig | undefined;

/** Configuração do `.env` da raiz, forçada para `test`. */
export function testConfig(overrides: { databaseName?: string } = {}): AppConfig {
  baseConfig ??= withTestProviders(loadConfig({ nodeEnv: 'test' }));

  if (overrides.databaseName === undefined) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    database: { ...baseConfig.database, name: overrides.databaseName },
  };
}

/**
 * Liga o login por provedor com credenciais de mentira.
 *
 * Quem fala com o GitHub nos testes é um cliente injetado, então estes valores
 * nunca saem da máquina. Fixá-los aqui é o que faz a suíte passar igual numa
 * máquina que tem as credenciais reais no `.env` e numa que não tem — sem isso,
 * o teste passaria no laptop de quem configurou e falharia no CI.
 */
function withTestProviders(config: AppConfig): AppConfig {
  return {
    ...config,
    github: {
      enabled: true,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret', // secret-scan:ignore — valor fixo de teste
      callbackUrl: 'http://127.0.0.1:3551/v1/auth/oauth/github/callback',
      scopes: 'read:user user:email',
    },
  };
}

/** Confere se MySQL e Redis respondem. Nunca lança. */
export async function probeServices(): Promise<Probe> {
  const config = testConfig();

  try {
    const connection = await createConnection({
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: config.database.password,
      connectTimeout: 5_000,
    });

    await connection.query('SELECT 1');
    await connection.end();
  } catch (error) {
    return {
      ok: false,
      reason: `MySQL em ${config.database.host}:${String(config.database.port)} não respondeu: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const redis = new Redis(
    config.redis.url ?? `redis://${config.redis.host ?? '127.0.0.1'}:${String(config.redis.port)}`,
    { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5_000 },
  );

  try {
    await redis.connect();
    await redis.ping();

    return { ok: true, reason: '' };
  } catch (error) {
    return {
      ok: false,
      reason: `Redis não respondeu: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    redis.disconnect();
  }
}

export interface TestHarness {
  readonly app: FastifyInstance;
  readonly authService: AuthService;
  readonly config: AppConfig;
  readonly databaseName: string;
  readonly mailDirectory: string;
  readonly mailer: MailService;
  /** Fecha a aplicação e apaga o banco descartável. */
  readonly dispose: () => Promise<void>;
}

/**
 * Sobe uma aplicação completa contra um banco descartável já migrado e semeado.
 *
 * O seed é obrigatório: sem os papéis do sistema e sem o plano padrão, o
 * registro não consegue criar organização — o que é o comportamento certo, e
 * não algo para o teste contornar.
 */
export async function createHarness(
  options: { prefix?: string; githubClient?: GitHubClient } = {},
): Promise<TestHarness> {
  const base = testConfig();
  const databaseName = `${options.prefix ?? 'prometheon_apitest'}_${newId().slice(-12).toLowerCase()}`;

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

  const config = testConfig({ databaseName });
  const database = await createDatabaseHandles(config, { connectionLimit: 5 });

  // Cada harness captura e-mail em um diretório próprio: duas suítes rodando
  // uma depois da outra não podem ler a mensagem uma da outra.
  const mailDirectory = await mkdtemp(join(tmpdir(), 'prometheon-mail-test-'));
  const mailer = await createMailService({
    config,
    // `capture` explícito: o teste não pode depender de haver um SMTP no ar.
    mode: 'capture',
    captureDirectory: mailDirectory,
  });

  const { app, authService } = await buildApp({
    config,
    database,
    mailer,
    ...(options.githubClient === undefined ? {} : { githubClient: options.githubClient }),
  });

  await app.ready();

  return {
    app,
    authService,
    config,
    databaseName,
    mailDirectory,
    mailer,
    dispose: async () => {
      await authService.flushPendingMail();
      await app.close();
      await closeDatabase(database);
      await mailer.close();

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

export interface CapturedMail {
  readonly kind: string;
  readonly to: string;
  readonly subject: string;
  readonly primaryLink: string | null;
  readonly text: string;
  readonly html: string;
}

/** Última mensagem capturada de um tipo, opcionalmente filtrada por destinatário. */
export async function lastMail(
  directory: string,
  kind: string,
  to?: string,
): Promise<CapturedMail | undefined> {
  const files = (await readdir(directory))
    .filter((name) => name.endsWith('.json') && name.includes(kind))
    .sort();

  for (const name of files.reverse()) {
    const parsed = JSON.parse(await readFile(join(directory, name), 'utf8')) as CapturedMail;

    if (to === undefined || parsed.to === to) {
      return parsed;
    }
  }

  return undefined;
}

/** Extrai o valor de um parâmetro da URL principal da mensagem. */
export function tokenFromLink(mail: CapturedMail, parameter = 'token'): string {
  if (mail.primaryLink === null) {
    throw new Error(`A mensagem ${mail.kind} não trouxe link.`);
  }

  const value = new URL(mail.primaryLink).searchParams.get(parameter);

  if (value === null) {
    throw new Error(`O link de ${mail.kind} não tem o parâmetro ${parameter}.`);
  }

  return value;
}

/**
 * Corpo JSON da resposta de `app.inject()`.
 *
 * O parâmetro de tipo existe para o chamador dizer o que espera
 * (`body<{ data: ... }>(response)`); não há como inferi-lo de uma string.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function body<T = Record<string, unknown>>(response: { payload: string }): T {
  return JSON.parse(response.payload) as T;
}

export interface RegisteredUser {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationId: string;
}

/**
 * Cria, verifica e autentica uma conta em um passo.
 *
 * Passa pelas rotas de verdade, não pelo repositório: o objetivo é que o
 * caminho exercitado pelo teste seja o mesmo que o usuário percorre.
 */
export async function registerAndLogin(
  harness: TestHarness,
  input: { name: string; email: string; password: string; organizationName?: string; invitationToken?: string },
): Promise<RegisteredUser> {
  const registration = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      name: input.name,
      email: input.email,
      password: input.password,
      acceptedTerms: true,
      ...(input.organizationName === undefined
        ? {}
        : { organizationName: input.organizationName }),
      ...(input.invitationToken === undefined
        ? {}
        : { invitationToken: input.invitationToken }),
    },
  });

  if (registration.statusCode !== 202) {
    throw new Error(`Registro falhou: ${registration.payload}`);
  }

  await harness.authService.flushPendingMail();

  const verification = await lastMail(harness.mailDirectory, 'email-verification', input.email);

  if (verification === undefined) {
    throw new Error(`Nenhum e-mail de verificação capturado para ${input.email}.`);
  }

  const verified = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: tokenFromLink(verification) },
  });

  if (verified.statusCode !== 200) {
    throw new Error(`Verificação falhou: ${verified.payload}`);
  }

  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: input.email, password: input.password },
  });

  if (login.statusCode !== 200) {
    throw new Error(`Login falhou: ${login.payload}`);
  }

  const parsed = body<{
    data: {
      user: { id: string };
      tokens: { accessToken: string; refreshToken: string };
    };
  }>(login);

  const me = await harness.app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: { authorization: `Bearer ${parsed.data.tokens.accessToken}` },
  });

  const meBody = body<{ data: { activeOrganizationId: string | null } }>(me);

  return {
    userId: parsed.data.user.id,
    email: input.email,
    password: input.password,
    accessToken: parsed.data.tokens.accessToken,
    refreshToken: parsed.data.tokens.refreshToken,
    organizationId: meBody.data.activeOrganizationId ?? '',
  };
}

/** Endereço único por execução, para não colidir com registro anterior. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}.${newId().slice(-10).toLowerCase()}@example.test`;
}
