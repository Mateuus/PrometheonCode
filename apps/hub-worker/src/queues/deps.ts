// Dependências que todo processador recebe.
//
// Um objeto só, montado uma vez na subida do processo e passado adiante. Nada
// de import de módulo global dentro dos processadores: assim o teste monta o
// mesmo objeto apontando para um banco descartável e um prefixo de chave
// próprio, sem tocar em `prometheon_dev`.

import type { Database } from '@prometheon/database';
import type { Logger } from '@prometheon/logger';

import type { WorkerSettings } from '../config.js';
import type { KeyNamespace } from '../keys.js';
import type { MetricsRegistry } from '../metrics.js';
import type { RedisConnection } from '../redis.js';
import type { DeadLetterSink } from './runtime.js';

export interface JobDeps {
  readonly db: Database;
  /** Conexão de comandos — nunca a que o BullMQ bloqueia. */
  readonly redis: RedisConnection;
  readonly keys: KeyNamespace;
  readonly metrics: MetricsRegistry;
  readonly logger: Logger;
  readonly settings: WorkerSettings;
  readonly deadLetter: DeadLetterSink;
}
