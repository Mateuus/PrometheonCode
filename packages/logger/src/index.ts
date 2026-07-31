/**
 * `@prometheon/logger` — Pino com redaction profunda e contexto assíncrono.
 *
 * ```ts
 * import { configureRootLogger, child, runWithLogContext } from '@prometheon/logger';
 *
 * configureRootLogger({ env: config.env, level: config.logLevel });
 *
 * const log = child('auth');
 *
 * runWithLogContext({ requestId }, () => {
 *   log.info({ email }, 'login attempt'); // sai com requestId
 * });
 * ```
 */

export {
  bindLogContext,
  getLogContext,
  runWithLogContext,
  updateLogContext,
  type LogContext,
} from './context.js';

export {
  buildPinoOptions,
  child,
  configureRootLogger,
  createLogger,
  createLoggerFromConfig,
  getRootLogger,
  LOG_LEVELS,
  resetRootLogger,
  setRootLogger,
  type CreateLoggerOptions,
  type Logger,
  type LoggerConfigInput,
  type LoggerEnvironment,
  type LogLevelName,
} from './logger.js';

export {
  CIRCULAR,
  createDeepRedactor,
  DEFAULT_ALLOWED_KEYS,
  DEFAULT_SENSITIVE_PATTERNS,
  normalizeKey,
  redactDeep,
  REDACTED,
  TRUNCATED,
  type DeepRedactor,
  type DeepRedactorOptions,
} from './redaction.js';

export {
  createErrorSerializer,
  serializeError,
  type ErrorSerializerOptions,
  type SerializedError,
} from './serializers.js';
