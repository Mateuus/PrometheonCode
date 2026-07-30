/**
 * Fábrica do logger Pino do projeto.
 *
 * Decisão: este pacote **não** importa `@prometheon/config`. O nível e o
 * ambiente chegam por parâmetro, num formato estruturalmente compatível com o
 * `AppConfig` — assim `createLoggerFromConfig(getConfig())` funciona sem criar
 * dependência entre os dois pacotes nem ordem de build obrigatória.
 */

import { createRequire } from 'node:module';

import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import { getLogContext } from './context.js';
import { createDeepRedactor, type DeepRedactorOptions } from './redaction.js';
import { createErrorSerializer } from './serializers.js';

export type { Logger } from 'pino';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevelName = (typeof LOG_LEVELS)[number];

export type LoggerEnvironment =
  | 'development'
  | 'test'
  | 'staging'
  | 'production';

/**
 * Recorte mínimo da configuração da aplicação. `AppConfig` de
 * `@prometheon/config` satisfaz este tipo sem conversão.
 */
export interface LoggerConfigInput {
  readonly env: LoggerEnvironment;
  readonly logLevel: LogLevelName;
}

export interface CreateLoggerOptions {
  readonly level?: LogLevelName | undefined;
  readonly env?: LoggerEnvironment | undefined;
  /** Vai para o campo `name` de toda linha. */
  readonly name?: string | undefined;
  /** Saída legível via `pino-pretty`. Padrão: só em `development`. */
  readonly pretty?: boolean | undefined;
  /** Inclui a pilha do erro. Padrão: em tudo que não for `production`. */
  readonly includeStack?: boolean | undefined;
  /** Campos fixos acrescentados a toda linha. */
  readonly base?: Readonly<Record<string, unknown>> | undefined;
  /** Destino alternativo; usado nos testes para capturar a saída. */
  readonly destination?: DestinationStream | undefined;
  /** Ajustes da redaction. */
  readonly redaction?: DeepRedactorOptions | undefined;
}

/**
 * Carrega o `pino-pretty` de forma síncrona e tolerante: ele é dependência de
 * desenvolvimento, então em produção simplesmente não está instalado — e aí a
 * saída JSON continua valendo.
 */
function tryCreatePrettyStream(): DestinationStream | undefined {
  try {
    const require = createRequire(import.meta.url);
    const loaded: unknown = require('pino-pretty');
    const factory =
      typeof loaded === 'function'
        ? (loaded as (options: Record<string, unknown>) => DestinationStream)
        : ((loaded as { default?: unknown }).default as
            | ((options: Record<string, unknown>) => DestinationStream)
            | undefined);

    if (factory === undefined) {
      return undefined;
    }

    return factory({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
      singleLine: false,
    });
  } catch {
    return undefined;
  }
}

/** Monta as opções do Pino, exposto para quem precisar decorar um logger. */
export function buildPinoOptions(options: CreateLoggerOptions = {}): LoggerOptions {
  const env: LoggerEnvironment = options.env ?? 'development';
  const level: LogLevelName = options.level ?? (env === 'test' ? 'silent' : 'info');
  const includeStack = options.includeStack ?? env !== 'production';
  const serializeError = createErrorSerializer({ includeStack });
  const redact = createDeepRedactor({
    transformError: serializeError,
    ...options.redaction,
  });

  const base: Record<string, unknown> = { ...options.base };

  if (options.name !== undefined) {
    base['name'] = options.name;
  }

  return {
    level,
    // `base` só é informado quando há algo a acrescentar: passá-lo vazio faria
    // o Pino descartar `pid` e `hostname`.
    ...(Object.keys(base).length > 0 ? { base } : {}),
    timestamp: pino.stdTimeFunctions.isoTime,
    // O contexto assíncrono entra em toda linha, sem passar o logger adiante.
    mixin: () => getLogContext(),
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => redact(bindings) as Record<string, unknown>,
      log: (object) => redact(object) as Record<string, unknown>,
    },
    // Os serializers padrão do Pino ficam desligados de propósito: o redator já
    // converte `Error` em objeto simples antes deles, e uma segunda passagem só
    // transformaria o resultado em "[object Object]".
    serializers: { err: identity, error: identity },
  };
}

function identity<T>(value: T): T {
  return value;
}

/**
 * O Pino só passa `formatters.bindings` pelas bindings iniciais; as de
 * `logger.child({...})` iriam cruas para a saída. Este patch redige as bindings
 * de cada filho e se propaga para os filhos dos filhos.
 */
function patchChild(logger: Logger, redact: (value: unknown) => unknown): Logger {
  type ChildFn = (
    bindings: Record<string, unknown>,
    childOptions?: unknown,
  ) => Logger;

  // O `child` do Pino é genérico em níveis customizados; aqui só precisamos da
  // forma mais simples, então o cast passa por `unknown`.
  const original = logger.child.bind(logger) as unknown as ChildFn;

  const patched: ChildFn = (bindings, childOptions) =>
    patchChild(
      original(redact(bindings) as Record<string, unknown>, childOptions),
      redact,
    );

  Object.defineProperty(logger, 'child', {
    value: patched,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  return logger;
}

/** Cria um logger independente. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env: LoggerEnvironment = options.env ?? 'development';
  const pretty = options.pretty ?? env === 'development';
  const pinoOptions = buildPinoOptions(options);
  const includeStack = options.includeStack ?? env !== 'production';
  const redact = createDeepRedactor({
    transformError: createErrorSerializer({ includeStack }),
    ...options.redaction,
  });

  if (options.destination !== undefined) {
    return patchChild(pino(pinoOptions, options.destination), redact);
  }

  if (pretty) {
    const stream = tryCreatePrettyStream();

    if (stream !== undefined) {
      return patchChild(pino(pinoOptions, stream), redact);
    }
  }

  return patchChild(pino(pinoOptions), redact);
}

/** Atalho para criar o logger a partir do `AppConfig`. */
export function createLoggerFromConfig(
  config: LoggerConfigInput,
  overrides: CreateLoggerOptions = {},
): Logger {
  return createLogger({ env: config.env, level: config.logLevel, ...overrides });
}

let rootLogger: Logger | undefined;

/**
 * Define o logger raiz do processo. A aplicação chama isto uma vez, logo depois
 * de carregar a configuração.
 */
export function setRootLogger(logger: Logger): Logger {
  rootLogger = logger;

  return logger;
}

/** Cria e registra o logger raiz. */
export function configureRootLogger(options: CreateLoggerOptions = {}): Logger {
  return setRootLogger(createLogger(options));
}

/**
 * Logger raiz. Se ninguém configurou ainda, cria um a partir de `NODE_ENV` e
 * `LOG_LEVEL` — suficiente para scripts e para o que roda antes do boot.
 */
export function getRootLogger(): Logger {
  rootLogger ??= createLogger({
    env: readEnvironment(),
    level: readLevel(),
  });

  return rootLogger;
}

/** Descarta o logger raiz. Existe para testes. */
export function resetRootLogger(): void {
  rootLogger = undefined;
}

/**
 * Logger filho por módulo.
 *
 * ```ts
 * const log = child('auth');
 * log.info({ userId }, 'session created');
 * ```
 */
export function child(
  module: string | Readonly<Record<string, unknown>>,
  bindings: Readonly<Record<string, unknown>> = {},
): Logger {
  const base = typeof module === 'string' ? { module } : module;

  return getRootLogger().child({ ...base, ...bindings });
}

function readEnvironment(): LoggerEnvironment {
  const value = process.env['NODE_ENV'];

  switch (value) {
    case 'production':
    case 'staging':
    case 'test':
      return value;
    default:
      return 'development';
  }
}

function readLevel(): LogLevelName | undefined {
  const value = process.env['LOG_LEVEL'];

  return LOG_LEVELS.includes(value as LogLevelName)
    ? (value as LogLevelName)
    : undefined;
}
