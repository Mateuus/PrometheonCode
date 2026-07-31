// Configuração do worker.
//
// O que é compartilhado com o resto do Hub (banco, Redis, ambiente, nível de
// log) vem de `@prometheon/config`, que já valida tudo na inicialização e falha
// cedo quando falta variável obrigatória (`Docs/11`). O que é só do worker —
// concorrência por fila, janela do outbox, porta de health — é lido aqui, com
// padrão razoável para cada item, porque não faz sentido a API carregar isso.

import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { collectRawEnv, getConfig, type AppConfig } from '@prometheon/config';

import { QUEUE_NAMES, type QueueName } from './queues/definitions.js';

/** Ajustes do publicador do Transactional Outbox (`Docs/08`). */
export interface OutboxSettings {
  /** Quantas mensagens o worker traz por varredura. */
  readonly batchSize: number;
  /** Intervalo entre varreduras quando o lote anterior veio cheio. */
  readonly pollIntervalMs: number;
  /** Intervalo quando não há nada pendente — evita martelar o banco à toa. */
  readonly idlePollIntervalMs: number;
  /**
   * TTL do lock curto por mensagem. Precisa ser maior que o tempo de publicar
   * e marcar, e pequeno o bastante para que a morte de um worker não segure a
   * mensagem por muito tempo.
   */
  readonly lockTtlMs: number;
  /** Tentativas de publicação antes da dead-letter. */
  readonly maxAttempts: number;
  /** Primeiro degrau do backoff exponencial. */
  readonly backoffBaseMs: number;
  /** Teto do backoff. */
  readonly backoffMaxMs: number;
  /** Frequência da amostragem do atraso (métrica que denuncia worker parado). */
  readonly lagSampleIntervalMs: number;
}

export interface HealthSettings {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  /**
   * Caminho opcional de um arquivo de estado. Serve para orquestrador que
   * prefere `test -f` a fazer HTTP (contêiner com rede restrita, por exemplo).
   */
  readonly filePath: string | undefined;
}

export interface StorageSettings {
  /**
   * Onde os pacotes de exportação são gravados. Em produção isto vira object
   * storage; enquanto não existe, o worker escreve num diretório do host e
   * grava o caminho relativo em `data_export_jobs.storage_key`.
   */
  readonly exportsDir: string;
  /** Validade do link de download (`Docs/09`: o pacote não fica para sempre). */
  readonly downloadTtlMs: number;
}

export interface WorkerSettings {
  readonly app: AppConfig;
  readonly instanceId: string;
  /** Ligar/desligar partes do processo sem mexer no código. */
  readonly outboxEnabled: boolean;
  readonly queuesEnabled: boolean;
  readonly outbox: OutboxSettings;
  readonly health: HealthSettings;
  readonly storage: StorageSettings;
  /** Concorrência por fila, já resolvida. */
  readonly concurrency: Readonly<Record<QueueName, number>>;
  /** Teto do encerramento gracioso antes de desistir e sair. */
  readonly shutdownTimeoutMs: number;
}

/** Concorrência padrão por fila: I/O externo escala mais que trabalho pesado. */
const DEFAULT_CONCURRENCY: Readonly<Record<QueueName, number>> = {
  webhooks: 8,
  notifications: 8,
  'context-summarization': 2,
  'knowledge-indexing': 4,
  retention: 1,
  exports: 2,
  deletions: 2,
  'dead-letter': 1,
};

/** `WORKER_CONCURRENCY_CONTEXT_SUMMARIZATION` a partir de `context-summarization`. */
function concurrencyEnvKey(queue: QueueName): string {
  return `WORKER_CONCURRENCY_${queue.replace(/-/g, '_').toUpperCase()}`;
}

function readInteger(
  raw: Readonly<Record<string, string>>,
  key: string,
  fallback: number,
  minimum = 1,
): number {
  const value = raw[key];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(
      `${key} inválido: "${value}". Esperado inteiro maior ou igual a ${String(minimum)}.`,
    );
  }
  return parsed;
}

function readBoolean(
  raw: Readonly<Record<string, string>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = raw[key]?.toLowerCase();
  if (value === undefined) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  throw new Error(`${key} inválido: "${value}". Esperado booleano.`);
}

export interface LoadWorkerSettingsOptions {
  /** Configuração já carregada; existe para os testes não relerem o ambiente. */
  readonly app?: AppConfig | undefined;
  /** Ambiente bruto alternativo; existe para os testes. */
  readonly raw?: Readonly<Record<string, string>> | undefined;
}

/**
 * Resolve a configuração completa do worker. Lança quando algo obrigatório
 * falta ou está fora de formato — `Docs/11` pede falha na inicialização, não
 * comportamento estranho depois.
 */
export function loadWorkerSettings(options: LoadWorkerSettingsOptions = {}): WorkerSettings {
  const app = options.app ?? getConfig();
  const raw = options.raw ?? collectRawEnv().raw;

  const concurrency = {} as Record<QueueName, number>;
  for (const queue of QUEUE_NAMES) {
    const fallback = readInteger(raw, 'WORKER_CONCURRENCY', DEFAULT_CONCURRENCY[queue]);
    concurrency[queue] = readInteger(raw, concurrencyEnvKey(queue), fallback);
  }

  const outbox: OutboxSettings = {
    batchSize: readInteger(raw, 'WORKER_OUTBOX_BATCH_SIZE', 100),
    pollIntervalMs: readInteger(raw, 'WORKER_OUTBOX_POLL_INTERVAL_MS', 250, 10),
    idlePollIntervalMs: readInteger(raw, 'WORKER_OUTBOX_IDLE_INTERVAL_MS', 1_000, 10),
    lockTtlMs: readInteger(raw, 'WORKER_OUTBOX_LOCK_TTL_MS', 15_000, 500),
    maxAttempts: readInteger(raw, 'WORKER_OUTBOX_MAX_ATTEMPTS', 8),
    backoffBaseMs: readInteger(raw, 'WORKER_OUTBOX_BACKOFF_BASE_MS', 1_000, 10),
    backoffMaxMs: readInteger(raw, 'WORKER_OUTBOX_BACKOFF_MAX_MS', 300_000, 10),
    lagSampleIntervalMs: readInteger(raw, 'WORKER_OUTBOX_LAG_INTERVAL_MS', 5_000, 100),
  };

  const health: HealthSettings = {
    enabled: readBoolean(raw, 'WORKER_HEALTH_ENABLED', true),
    host: raw['WORKER_HEALTH_HOST'] ?? '0.0.0.0',
    port: readInteger(raw, 'WORKER_HEALTH_PORT', 3552, 0),
    filePath: raw['WORKER_HEALTH_FILE'],
  };

  const storage: StorageSettings = {
    exportsDir: resolve(
      raw['WORKER_EXPORT_DIR'] ?? join(process.cwd(), '.prometheon', 'exports'),
    ),
    downloadTtlMs: readInteger(raw, 'WORKER_EXPORT_TTL_MS', 7 * 24 * 3_600_000, 60_000),
  };

  return {
    app,
    instanceId: raw['WORKER_INSTANCE_ID'] ?? `${process.pid.toString()}@${hostLabel()}`,
    outboxEnabled: readBoolean(raw, 'WORKER_OUTBOX_ENABLED', true),
    queuesEnabled: readBoolean(raw, 'WORKER_QUEUES_ENABLED', true),
    outbox,
    health,
    storage,
    concurrency,
    shutdownTimeoutMs: readInteger(raw, 'WORKER_SHUTDOWN_TIMEOUT_MS', 30_000, 100),
  };
}

/** Nome da máquina, sem derrubar o boot se o SO não responder. */
function hostLabel(): string {
  try {
    return hostname();
  } catch {
    return 'worker';
  }
}
