/**
 * Enfileiramento dos jobs de governança.
 *
 * A API não processa exportação nem exclusão: ela grava a linha em
 * `data_export_jobs` / `deletion_jobs` e chama o processador que o worker já
 * tem pronto. As políticas de fila (tentativas, backoff, retenção de jobs) vêm
 * de `@prometheon/hub-worker` para que os dois lados não divirjam.
 *
 * Duas coisas que custam caro se forem esquecidas:
 *
 * - **`jobId` sem `:`.** O BullMQ recusa dois-pontos no identificador do job,
 *   e a convenção de ID do projeto é ULID — `export:01J…` seria o natural e
 *   falharia em produção. `deterministicJobId()` do worker faz a limpeza.
 * - **conexão própria.** O BullMQ exige `maxRetriesPerRequest: null` e
 *   administra o próprio prefixo de chave; reaproveitar o `app.redis`, que tem
 *   `keyPrefix` e limite de tentativas, quebraria os dois.
 */

import {
  createKeyNamespace,
  defaultJobOptions,
  deterministicJobId,
} from '@prometheon/hub-worker';
import { child } from '@prometheon/logger';
import { Queue, type ConnectionOptions } from 'bullmq';

import type { AppConfig } from '../../config/index.js';

const logger = child('governance-queue');

export interface EnqueueExportInput {
  readonly organizationId: string;
  readonly exportJobId: string;
  readonly correlationId: string;
  readonly requestedBy: string;
}

export interface EnqueueDeletionInput {
  readonly organizationId: string;
  readonly deletionJobId: string;
  readonly correlationId: string;
  readonly requestedBy: string;
  /** Instante em que o job deve rodar; a espera é a janela de arrependimento. */
  readonly scheduledFor: Date;
}

export interface GovernanceQueues {
  /** `false` quando o Redis recusou o job; a linha no banco continua pendente. */
  enqueueExport(input: EnqueueExportInput): Promise<boolean>;
  enqueueDeletion(input: EnqueueDeletionInput): Promise<boolean>;
  close(): Promise<void>;
}

function connectionOptions(config: AppConfig): ConnectionOptions {
  const base = {
    // Exigência do BullMQ para as conexões bloqueantes.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    db: config.redis.db,
    ...(config.redis.password !== undefined && config.redis.password !== ''
      ? { password: config.redis.password }
      : {}),
  };

  if (config.redis.url !== undefined) {
    return { ...base, url: config.redis.url };
  }

  return { ...base, host: config.redis.host ?? '127.0.0.1', port: config.redis.port };
}

export function createGovernanceQueues(config: AppConfig): GovernanceQueues {
  const keys = createKeyNamespace(config.redis.keyPrefix);
  const connection = connectionOptions(config);

  const exports = new Queue('exports', {
    connection,
    prefix: keys.bull,
    defaultJobOptions: defaultJobOptions('exports'),
  });
  const deletions = new Queue('deletions', {
    connection,
    prefix: keys.bull,
    defaultJobOptions: defaultJobOptions('deletions'),
  });

  /**
   * Falha ao enfileirar não derruba a requisição: a linha já existe no banco e
   * repetir a chamada criaria um segundo pedido para o mesmo dado. O job fica
   * `pending`, o log registra, e reenfileirar é operação de manutenção.
   */
  const guard = async (queue: string, action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();

      return true;
    } catch (error) {
      logger.error({ err: error, queue }, 'não foi possível enfileirar o job de governança');

      return false;
    }
  };

  return {
    enqueueExport: async (input) =>
      guard('exports', async () =>
        exports.add(
          'export',
          {
            correlationId: input.correlationId,
            organizationId: input.organizationId,
            requestedBy: input.requestedBy,
            requestedAt: new Date().toISOString(),
            exportJobId: input.exportJobId,
          },
          { jobId: deterministicJobId('export', input.exportJobId) },
        ),
      ),
    enqueueDeletion: async (input) =>
      guard('deletions', async () =>
        deletions.add(
          'deletion',
          {
            correlationId: input.correlationId,
            organizationId: input.organizationId,
            requestedBy: input.requestedBy,
            requestedAt: new Date().toISOString(),
            deletionJobId: input.deletionJobId,
          },
          {
            jobId: deterministicJobId('deletion', input.deletionJobId),
            // A exclusão só roda quando a janela de arrependimento fecha.
            delay: Math.max(0, input.scheduledFor.getTime() - Date.now()),
          },
        ),
      ),
    close: async () => {
      await Promise.all([exports.close(), deletions.close()]);
    },
  };
}
