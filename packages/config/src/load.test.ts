import { describe, expect, it } from 'vitest';

import { ConfigValidationError } from './errors.js';
import { loadConfig, type LoadConfigOptions } from './load.js';
import { redactedConfig } from './redact.js';
import { TEST_SECRET_KEYS, testSecretFor } from './test-fallbacks.js';

/** Segredos válidos e distintos, gerados fora do modo de teste do pacote. */
const SECRETS = {
  AUTH_ACCESS_TOKEN_SECRET: 'Kq7bZ3xW9tR2vN8mL5cP1yJ4hG6dS0fA2eU7iO3wQxY',
  AUTH_REFRESH_TOKEN_SECRET: 'Zm4pT8yH2vC6nK9bX3jR7dL1sW5gQ0fE4aI8uO2cVtN',
  AUTH_REALTIME_TOKEN_SECRET: 'Wd9sJ2mF6xB4nZ8tK1vQ5cR7hL3gY0pA2eU6iO4wXrT',
  SECRETS_MASTER_KEY: 'Pj5nR8wT2yV6bM9xK3cH7dL1sG4qZ0fE5aI8uO2vCmB',
} as const;

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_USER: 'prometheon',
  DATABASE_PASSWORD: 'local-password',
  DATABASE_NAME: 'prometheon_dev',
  VALKEY_HOST: '127.0.0.1',
  ...SECRETS,
};

/** Carrega ignorando arquivos `.env`, para isolar o teste do ambiente real. */
function load(
  overrides: Record<string, string | undefined> = {},
  options: LoadConfigOptions = {},
): ReturnType<typeof loadConfig> {
  const processEnv: Record<string, string | undefined> = {
    ...BASE_ENV,
    ...overrides,
  };

  return loadConfig({ processEnv, loadEnvFiles: false, ...options });
}

function expectFailure(
  overrides: Record<string, string | undefined>,
  options: LoadConfigOptions = {},
): ConfigValidationError {
  try {
    load(overrides, options);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);

    return error as ConfigValidationError;
  }

  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('resolves a valid environment and freezes the result', () => {
    const config = load();

    expect(config.env).toBe('development');
    expect(config.isDevelopment).toBe(true);
    expect(config.isProduction).toBe(false);
    expect(config.http.apiPort).toBe(3551);
    expect(config.http.webPort).toBe(3550);
    expect(config.database.name).toBe('prometheon_dev');
    expect(config.redis.enabled).toBe(true);
    expect(config.redis.keyPrefix).toBe('prometheon:');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.secrets)).toBe(true);
  });

  it('coerces ports, booleans and comma separated origins', () => {
    const config = load({
      HUB_API_PORT: '4000',
      VALKEY_ENABLED: 'FALSE',
      SMTP_SECURE: 'Yes',
      CORS_ORIGINS: 'https://a.example.com , https://b.example.com,',
    });

    expect(config.http.apiPort).toBe(4000);
    expect(config.redis.enabled).toBe(false);
    expect(config.smtp.secure).toBe(true);
    expect(config.http.corsOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('treats empty values as missing', () => {
    const error = expectFailure({ DATABASE_HOST: '   ' });

    expect(error.invalidKeys).toContain('DATABASE_HOST');
  });

  it('reports every invalid variable at once', () => {
    const error = expectFailure({
      DATABASE_HOST: undefined,
      DATABASE_NAME: undefined,
      HUB_API_PORT: 'not-a-port',
      LOG_LEVEL: 'chatty',
      AUTH_ACCESS_TOKEN_SECRET: 'short',
      CORS_ORIGINS: '*',
    });

    expect(error.invalidKeys).toEqual(
      expect.arrayContaining([
        'LOG_LEVEL',
        'HUB_API_PORT',
        'CORS_ORIGINS',
        'DATABASE_HOST',
        'DATABASE_NAME',
        'AUTH_ACCESS_TOKEN_SECRET',
      ]),
    );
    expect(error.issues.length).toBeGreaterThanOrEqual(6);
    expect(error.message).toContain('6 problems found');
    expect(error.message).toContain('DATABASE_HOST');
    expect(error.message).toContain('AUTH_ACCESS_TOKEN_SECRET');
  });

  it('never leaks the rejected secret value in the error message', () => {
    const error = expectFailure({
      AUTH_ACCESS_TOKEN_SECRET: 'hunter2-hunter2-hunter2',
    });

    expect(error.message).not.toContain('hunter2');
  });

  it('rejects secrets below 32 bytes of entropy', () => {
    const error = expectFailure({
      AUTH_REFRESH_TOKEN_SECRET: 'Kq7bZ3xW9tR2vN8mL5cP1yJ',
    });

    expect(error.invalidKeys).toEqual(['AUTH_REFRESH_TOKEN_SECRET']);
    expect(error.message).toContain('bytes of entropy');
  });

  it('rejects placeholder secrets even when long enough', () => {
    const error = expectFailure({
      SECRETS_MASTER_KEY: 'changeme-changeme-changeme-changeme-changeme',
    });

    expect(error.invalidKeys).toEqual(['SECRETS_MASTER_KEY']);
    expect(error.message).toContain('placeholder');
  });

  it('rejects reusing the same value for two secrets', () => {
    const error = expectFailure({
      AUTH_REFRESH_TOKEN_SECRET: SECRETS.AUTH_ACCESS_TOKEN_SECRET,
    });

    expect(error.invalidKeys).toEqual(['AUTH_REFRESH_TOKEN_SECRET']);
    expect(error.message).toContain('must not repeat');
  });

  it('never falls back to a default secret', () => {
    const error = expectFailure({
      AUTH_ACCESS_TOKEN_SECRET: undefined,
      AUTH_REFRESH_TOKEN_SECRET: undefined,
      AUTH_REALTIME_TOKEN_SECRET: undefined,
      SECRETS_MASTER_KEY: undefined,
    });

    expect(error.invalidKeys).toEqual([...TEST_SECRET_KEYS]);
  });

  it('requires a redis endpoint when valkey is enabled', () => {
    const error = expectFailure({
      VALKEY_ENABLED: 'true',
      VALKEY_HOST: undefined,
    });

    expect(error.invalidKeys).toEqual(['VALKEY_URL']);
  });

  it('accepts a disabled redis without endpoint', () => {
    const config = load({ VALKEY_ENABLED: 'false', VALKEY_HOST: undefined });

    expect(config.redis.enabled).toBe(false);
    expect(config.redis.host).toBeUndefined();
  });

  it('requires an smtp password whenever a user is set', () => {
    const error = expectFailure({ SMTP_USER: 'mailer' });

    expect(error.invalidKeys).toEqual(['SMTP_PASSWORD']);
  });

  it('rejects a wildcard cors origin', () => {
    const error = expectFailure({ CORS_ORIGINS: '*' });

    expect(error.message).toContain('wildcard');
  });

  it('rejects cors entries carrying a path', () => {
    const error = expectFailure({
      CORS_ORIGINS: 'https://app.example.com/dashboard',
    });

    expect(error.invalidKeys).toEqual(['CORS_ORIGINS']);
  });
});

describe('loadConfig in production', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    HUB_API_URL: 'https://api.example.com',
    HUB_WEB_URL: 'https://app.example.com',
    CORS_ORIGINS: 'https://app.example.com',
  } as const;

  it('accepts a hardened production environment', () => {
    const config = load(productionEnv);

    expect(config.isProduction).toBe(true);
    expect(config.meta.usesTestSecrets).toBe(false);
    expect(config.meta.envFiles).toEqual([]);
  });

  it('never reads .env files in production', () => {
    const config = loadConfig({
      processEnv: { ...BASE_ENV, ...productionEnv },
    });

    expect(config.meta.envFiles).toEqual([]);
    expect(config.meta.workspaceRoot).toBeUndefined();
  });

  it('requires https, a database password and explicit cors origins', () => {
    const error = expectFailure({
      ...productionEnv,
      HUB_API_URL: 'http://api.example.com',
      HUB_WEB_URL: 'http://app.example.com',
      DATABASE_PASSWORD: '',
      CORS_ORIGINS: undefined,
    });

    expect(error.invalidKeys).toEqual(
      expect.arrayContaining([
        'HUB_API_URL',
        'HUB_WEB_URL',
        'DATABASE_PASSWORD',
        'CORS_ORIGINS',
      ]),
    );
  });

  it('refuses secrets reserved for the test environment', () => {
    const error = expectFailure({
      ...productionEnv,
      SECRETS_MASTER_KEY: testSecretFor('SECRETS_MASTER_KEY'),
    });

    expect(error.invalidKeys).toEqual(['SECRETS_MASTER_KEY']);
    expect(error.message).toContain('reserved for NODE_ENV=test');
  });
});

describe('loadConfig in test', () => {
  it('fills in deterministic secrets when they are missing', () => {
    const config = loadConfig({
      processEnv: { NODE_ENV: 'test', VALKEY_ENABLED: 'false' },
      loadEnvFiles: false,
    });

    expect(config.isTest).toBe(true);
    expect(config.meta.usesTestSecrets).toBe(true);
    expect(config.secrets.accessToken).toBe(
      testSecretFor('AUTH_ACCESS_TOKEN_SECRET'),
    );
    expect(new Set(Object.values(config.secrets)).size).toBe(4);
  });

  it('still honours secrets provided by the environment', () => {
    const config = loadConfig({
      processEnv: { ...BASE_ENV, NODE_ENV: 'test' },
      loadEnvFiles: false,
    });

    expect(config.secrets.accessToken).toBe(SECRETS.AUTH_ACCESS_TOKEN_SECRET);
    expect(config.meta.usesTestSecrets).toBe(false);
  });

  it('does not relax anything for staging', () => {
    const error = expectFailure({
      NODE_ENV: 'staging',
      AUTH_ACCESS_TOKEN_SECRET: undefined,
    });

    expect(error.invalidKeys).toContain('AUTH_ACCESS_TOKEN_SECRET');
  });
});

describe('redactedConfig', () => {
  it('replaces every secret with a presence marker', () => {
    const config = load({
      VALKEY_URL: 'redis://valkey:sup3r-s3cret-p4ss@127.0.0.1:6379', // secret-scan:ignore — URL inventada para provar a redação
      VALKEY_PASSWORD: 'sup3r-s3cret-p4ss',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'mailer-p4ssword',
    });

    const serialized = JSON.stringify(redactedConfig(config));

    for (const secret of Object.values(config.secrets)) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).not.toContain('local-password');
    expect(serialized).not.toContain('sup3r-s3cret-p4ss');
    expect(serialized).not.toContain('mailer-p4ssword');
    expect(serialized).toContain('***');
  });

  it('keeps the non sensitive parts readable', () => {
    const redacted = redactedConfig(load());

    expect(redacted.env).toBe('development');
    expect(redacted.database.host).toBe('127.0.0.1');
    expect(redacted.database.user).toBe('prometheon');
    expect(redacted.secrets.accessToken).toBe('***');
    expect(redacted.smtp.password).toBeNull();
  });

  it('scrubs credentials embedded in the redis url', () => {
    const redacted = redactedConfig(
      load({ VALKEY_URL: 'redis://user:p4ssw0rd-goes-here@cache.internal:6379' }), // secret-scan:ignore — URL inventada para provar a redação
    );

    expect(redacted.redis.url).toBe('redis://***:***@cache.internal:6379');
  });
});
