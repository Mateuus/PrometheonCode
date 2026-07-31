/**
 * `@prometheon/config` — configuração tipada, validada uma vez e congelada.
 *
 * ```ts
 * import { getConfig, redactedConfig } from '@prometheon/config';
 *
 * const config = getConfig();
 * logger.info({ config: redactedConfig(config) }, 'configuration loaded');
 * ```
 */

export {
  buildConfig,
  deepFreeze,
  type AppConfig,
  type ConfigMeta,
  type DatabaseConfig,
  type HttpConfig,
  type RedisConfig,
  type SecretsConfig,
  type SmtpConfig,
  type TranscriptionConfig,
} from './config.js';

export {
  collectRawEnv,
  findWorkspaceRoot,
  WORKSPACE_MARKER,
  type EnvSourceOptions,
  type EnvSourceResult,
  type RawEnv,
} from './env-source.js';

export {
  ConfigValidationError,
  formatConfigIssues,
  type ConfigIssue,
} from './errors.js';

export {
  getConfig,
  loadConfig,
  resetConfigCache,
  type LoadConfigOptions,
} from './load.js';

export {
  redactConnectionUrl,
  redactedConfig,
  REDACTED,
  type RedactedConfigShape,
  type RedactedValue,
} from './redact.js';

export {
  envSchema,
  LOG_LEVELS,
  NODE_ENVIRONMENTS,
  type LogLevel,
  type NodeEnvironment,
  type ParsedEnv,
} from './schema.js';

export {
  assessSecret,
  MIN_SECRET_BYTES,
  secretEntropyBytes,
  type SecretAssessment,
} from './secrets.js';

export {
  assertNoTestSecrets,
  TEST_SECRET_KEYS,
  testSecretFor,
  type TestSecretKey,
} from './test-fallbacks.js';
