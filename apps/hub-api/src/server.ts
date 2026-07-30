/**
 * Ponto de entrada do processo.
 *
 * Três responsabilidades, e nenhuma delas é lógica de aplicação:
 *
 * 1. carregar e validar a configuração **antes** de qualquer coisa — falhar cedo
 *    quando falta variável obrigatória é o que o `Docs/11` pede;
 * 2. abrir a porta;
 * 3. desligar com graça: parar de aceitar conexão nova, terminar o que já está
 *    em voo, fechar banco, Redis e transporte de e-mail.
 */

import process from 'node:process';

import { ConfigValidationError, redactedConfig } from '@prometheon/config';
import { child, configureRootLogger } from '@prometheon/logger';

import { buildApp } from './app.js';
import { getConfig } from './config/index.js';

/** Sinais que devem levar a um desligamento ordenado. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function main(): Promise<void> {
  let config;

  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // Ainda não há logger configurado — e a mensagem precisa chegar ao
      // operador de qualquer forma. `process.stderr` é o canal certo aqui.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 78; // EX_CONFIG
      return;
    }

    throw error;
  }

  configureRootLogger({ env: config.env, level: config.logLevel });

  const logger = child('server');

  // `redactedConfig` troca todo segredo por um marcador antes de o objeto
  // chegar ao log (`Docs/09`: redaction em logs).
  logger.info({ config: redactedConfig(config) }, 'configuration loaded');

  const { app } = await buildApp({ config });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    try {
      await app.close();
      logger.info('shutdown complete');
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed');
      process.exitCode = 1;
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  // Exceção não tratada deixa o processo em estado desconhecido; o certo é
  // registrar e sair para que o supervisor suba um processo limpo.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection').finally(() => process.exit(1));
  });

  await app.listen({ port: config.http.apiPort, host: '0.0.0.0' });

  logger.info(
    {
      port: config.http.apiPort,
      environment: config.env,
      mailTransport: app.mailer.transport,
    },
    'hub-api listening',
  );
}

await main();
