import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { bindLogContext, runWithLogContext, updateLogContext } from './context.js';
import {
  child,
  configureRootLogger,
  createLogger,
  createLoggerFromConfig,
  resetRootLogger,
  type Logger,
} from './logger.js';

type LogLine = Readonly<Record<string, unknown>>;

/** Captura as linhas JSON emitidas pelo logger. */
function capture(): { stream: Writable; lines: LogLine[] } {
  const lines: LogLine[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim().length > 0) {
          lines.push(JSON.parse(line) as LogLine);
        }
      }

      callback();
    },
  });

  return { stream, lines };
}

function makeLogger(
  options: Parameters<typeof createLogger>[0] = {},
): { logger: Logger; lines: LogLine[] } {
  const { stream, lines } = capture();
  const logger = createLogger({
    level: 'trace',
    env: 'test',
    destination: stream,
    ...options,
  });

  return { logger, lines };
}

afterEach(() => {
  resetRootLogger();
});

describe('createLogger', () => {
  it('writes structured json with an ISO timestamp and a level label', () => {
    const { logger, lines } = makeLogger();

    logger.info({ projectId: '01J000000000000000000PRJ' }, 'project created');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'project created',
      projectId: '01J000000000000000000PRJ',
    });
    expect(String(lines[0]?.['time'])).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('honours the level coming from the application config', () => {
    const { stream, lines } = capture();
    const logger = createLoggerFromConfig(
      { env: 'production', logLevel: 'warn' },
      { destination: stream },
    );

    logger.info('ignored');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['msg']).toBe('kept');
  });
});

describe('redaction', () => {
  it('redacts sensitive fields at the top level', () => {
    const { logger, lines } = makeLogger();

    logger.info({ password: 'hunter2', authorization: 'Bearer abc' }, 'login');

    expect(lines[0]?.['password']).toBe('[REDACTED]');
    expect(lines[0]?.['authorization']).toBe('[REDACTED]');
  });

  it('redacts sensitive fields nested deep inside the payload', () => {
    const { logger, lines } = makeLogger();

    logger.info(
      {
        request: {
          headers: {
            authorization: 'Bearer super-secret',
            cookie: 'session=abc',
            'x-api-key': 'key-123',
          },
          body: {
            user: {
              email: 'dev@example.com',
              credentials: { password: 'hunter2', refreshToken: 'rt-123' },
            },
          },
        },
      },
      'incoming request',
    );

    const serialized = JSON.stringify(lines[0]);

    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('session=abc');
    expect(serialized).not.toContain('key-123');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('rt-123');
    expect(serialized).toContain('dev@example.com');
  });

  it('redacts inside arrays', () => {
    const { logger, lines } = makeLogger();

    logger.info(
      { devices: [{ id: 'd1', deviceToken: 'tok-1' }, { id: 'd2', secret: 's' }] },
      'devices',
    );

    const serialized = JSON.stringify(lines[0]);

    expect(serialized).not.toContain('tok-1');
    expect(serialized).toContain('d1');
  });

  it('redacts child bindings too', () => {
    const { logger, lines } = makeLogger();

    logger.child({ module: 'auth', apiKey: 'leaky' }).info('bound');

    expect(lines[0]?.['module']).toBe('auth');
    expect(lines[0]?.['apiKey']).toBe('[REDACTED]');
  });

  it('keeps model token counters readable', () => {
    const { logger, lines } = makeLogger();

    logger.info({ usage: { totalTokens: 1234, inputTokens: 900 } }, 'usage');

    expect(lines[0]?.['usage']).toEqual({ totalTokens: 1234, inputTokens: 900 });
  });

  it('scrubs credentials embedded in free strings', () => {
    const { logger, lines } = makeLogger();

    logger.info(
      { note: 'sent header Bearer abcdefghijklmnop to upstream' },
      'call',
    );

    expect(lines[0]?.['note']).toBe('sent header Bearer [REDACTED] to upstream');
  });

  it('survives circular structures', () => {
    const { logger, lines } = makeLogger();
    const node: Record<string, unknown> = { id: 'root' };

    node['self'] = node;

    logger.info({ node }, 'cycle');

    expect(JSON.stringify(lines[0])).toContain('[Circular]');
  });
});

describe('error serializer', () => {
  it('keeps code and the cause chain', () => {
    const { logger, lines } = makeLogger();
    const root = new Error('socket closed');

    Object.assign(root, { code: 'ECONNRESET' });

    const wrapped = new Error('query failed', { cause: root });

    Object.assign(wrapped, { code: 'DB_QUERY_FAILED' });

    logger.error({ err: wrapped }, 'database error');

    const err = lines[0]?.['err'] as Record<string, unknown>;

    expect(err['code']).toBe('DB_QUERY_FAILED');
    expect(err['message']).toBe('query failed');
    expect(err['stack']).toBeTypeOf('string');
    expect(err['cause']).toMatchObject({
      message: 'socket closed',
      code: 'ECONNRESET',
    });
  });

  it('omits the stack in production', () => {
    const { stream, lines } = capture();
    const logger = createLogger({
      env: 'production',
      level: 'trace',
      destination: stream,
    });

    logger.error({ err: new Error('boom') }, 'failed');

    const err = lines[0]?.['err'] as Record<string, unknown>;

    expect(err['message']).toBe('boom');
    expect(err['stack']).toBeUndefined();
  });

  it('redacts sensitive properties attached to the error', () => {
    const { logger, lines } = makeLogger();
    const error = new Error('bad credentials');

    Object.assign(error, { code: 'AUTH_FAILED', password: 'hunter2' });

    logger.error({ err: error }, 'auth');

    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
  });
});

describe('async log context', () => {
  it('stamps requestId and correlationId on every line in scope', async () => {
    const { logger, lines } = makeLogger();

    await runWithLogContext(
      { requestId: 'req-1', correlationId: 'corr-1' },
      async () => {
        logger.info('before await');
        await Promise.resolve();
        logger.child({ module: 'deep' }).info('after await');
      },
    );

    logger.info('outside');

    expect(lines[0]).toMatchObject({ requestId: 'req-1', correlationId: 'corr-1' });
    expect(lines[1]).toMatchObject({ requestId: 'req-1', module: 'deep' });
    expect(lines[2]?.['requestId']).toBeUndefined();
  });

  it('lets a scope be enriched after it opened', () => {
    const { logger, lines } = makeLogger();

    runWithLogContext({ requestId: 'req-2' }, () => {
      updateLogContext({ userId: '01J000000000000000000USR' });
      logger.info('authenticated');
    });

    expect(lines[0]).toMatchObject({
      requestId: 'req-2',
      userId: '01J000000000000000000USR',
    });
  });

  it('nests scopes without losing the outer values', () => {
    const { logger, lines } = makeLogger();

    runWithLogContext({ requestId: 'req-3' }, () => {
      runWithLogContext({ projectId: 'prj-1' }, () => {
        logger.info('inner');
      });

      logger.info('outer');
    });

    expect(lines[0]).toMatchObject({ requestId: 'req-3', projectId: 'prj-1' });
    expect(lines[1]?.['projectId']).toBeUndefined();
  });

  it('does not let a log payload stick to the surrounding context', () => {
    const { logger, lines } = makeLogger();

    runWithLogContext({ requestId: 'req-5' }, () => {
      logger.info({ user: { email: 'dev@example.com' } }, 'first');
      logger.info('second');
    });

    expect(lines[1]).toMatchObject({ requestId: 'req-5', msg: 'second' });
    expect(lines[1]?.['user']).toBeUndefined();
  });

  it('replays a captured context inside a deferred callback', async () => {
    const { logger, lines } = makeLogger();

    const deferred = runWithLogContext({ requestId: 'req-4' }, () =>
      bindLogContext(() => {
        logger.info('later');
      }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        deferred();
        resolve();
      }, 0);
    });

    expect(lines[0]).toMatchObject({ requestId: 'req-4' });
  });
});

describe('root logger', () => {
  it('creates module children from the configured root', () => {
    const { stream, lines } = capture();

    configureRootLogger({ env: 'test', level: 'trace', destination: stream });
    child('knowledge').info('indexed');

    expect(lines[0]).toMatchObject({ module: 'knowledge', msg: 'indexed' });
  });
});
