// Ponto de entrada do processo.
//
// Só três responsabilidades: subir o runtime, ouvir os sinais do orquestrador e
// garantir que nenhuma falha silenciosa deixe o processo vivo e inútil. Toda a
// lógica está em `worker.ts` — assim o teste sobe o mesmo runtime sem precisar
// de um processo separado.

import process from 'node:process';

import { getRootLogger } from '@prometheon/logger';

import { createWorkerRuntime } from './worker.js';

/** Sinais que significam "encerre com calma". */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGQUIT'] as const;

async function main(): Promise<void> {
  const runtime = await createWorkerRuntime();

  let exiting = false;
  const stop = (reason: string, code: number): void => {
    if (exiting) {
      // Segundo sinal: quem insiste quer sair agora.
      runtime.logger.warn({ reason }, 'segundo sinal recebido; saindo imediatamente');
      process.exit(code);
    }
    exiting = true;
    void runtime
      .shutdown(reason)
      .catch((error: unknown) => {
        runtime.logger.error({ err: error }, 'falha no encerramento');
      })
      .finally(() => {
        process.exit(code);
      });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      stop(signal, 0);
    });
  }

  // Erro não tratado deixa o processo em estado desconhecido: melhor cair de
  // forma controlada e deixar o orquestrador recriar o contêiner.
  process.on('uncaughtException', (error) => {
    runtime.logger.fatal({ err: error }, 'exceção não tratada');
    stop('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    runtime.logger.fatal({ err: reason }, 'promessa rejeitada sem tratamento');
    stop('unhandledRejection', 1);
  });

  await runtime.start();
}

await main().catch((error: unknown) => {
  getRootLogger().fatal({ err: error }, 'falha ao subir o worker');
  process.exit(1);
});
