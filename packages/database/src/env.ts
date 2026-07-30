// Leitor mínimo do `.env` da raiz do monorepo.
//
// PROVISÓRIO: quando `@prometheon/config` existir (outro agente está escrevendo
// esse pacote agora), toda a configuração passa a vir de lá e este arquivo some.
// Enquanto isso o pacote precisa das credenciais do MySQL para gerar e aplicar
// migrations sem depender de algo que ainda não foi publicado no workspace.
//
// Regras que este leitor respeita:
// - variáveis já presentes em `process.env` vencem o arquivo (CI e testes);
// - nada é impresso: os valores são segredos de desenvolvimento.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

/** Configuração de conexão usada pelo cliente, pelo runner e pelo Drizzle Kit. */
export interface DatabaseEnv {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let cachedFileEnv: Record<string, string> | undefined;

/** Sobe a árvore de diretórios procurando o `.env` da raiz do monorepo. */
function findEnvFile(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Interpreta o `.env` no formato `CHAVE=valor`, ignorando comentários. */
function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match?.[1]) {
      continue;
    }
    const value = (match[2] ?? '').trim();
    values[match[1]] = value.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
  }
  return values;
}

/**
 * Diretório de partida da busca. O Drizzle Kit transpila este arquivo para CJS
 * antes de executá-lo, e nesse caminho `import.meta.dirname` não existe — daí o
 * recuo para o diretório de trabalho, que também está dentro do monorepo.
 */
function startDirectory(): string {
  const dir: string | undefined = import.meta.dirname;
  return typeof dir === 'string' && dir !== '' ? dir : process.cwd();
}

/** Lê o `.env` uma única vez por processo. */
function fileEnv(): Record<string, string> {
  if (cachedFileEnv) {
    return cachedFileEnv;
  }
  const path = findEnvFile(startDirectory());
  cachedFileEnv = path ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  return cachedFileEnv;
}

/** Valor de uma variável: `process.env` primeiro, depois o arquivo. */
export function envValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') {
    return fromProcess;
  }
  const fromFile = fileEnv()[key];
  return fromFile === '' ? undefined : fromFile;
}

/**
 * Monta a configuração do MySQL. `overrides.database` existe para os testes,
 * que rodam contra um banco descartável em vez do banco de desenvolvimento.
 */
export function readDatabaseEnv(overrides: Partial<DatabaseEnv> = {}): DatabaseEnv {
  const host = overrides.host ?? envValue('DATABASE_HOST');
  const user = overrides.user ?? envValue('DATABASE_USER');
  const password = overrides.password ?? envValue('DATABASE_PASSWORD') ?? '';
  const database = overrides.database ?? envValue('DATABASE_NAME');
  const port = overrides.port ?? Number(envValue('DATABASE_PORT') ?? 3306);

  const missing: string[] = [];
  if (!host) missing.push('DATABASE_HOST');
  if (!user) missing.push('DATABASE_USER');
  if (!database) missing.push('DATABASE_NAME');
  if (missing.length > 0) {
    throw new Error(
      `Configuração de banco incompleta: ${missing.join(', ')}. ` +
        'Copie `.env.example` para `.env` na raiz e preencha os valores.',
    );
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`DATABASE_PORT inválido: ${String(port)}.`);
  }

  return { host: host!, port, user: user!, password, database: database! };
}

/**
 * Chave mestre do envelope encryption. Vive **fora** do banco, só no ambiente.
 * O schema guarda apenas ciphertext + IV + tag + identificador da chave; quem
 * cifra e decifra é a camada de aplicação, nunca o banco.
 */
export function readSecretsMasterKey(): string {
  const key = envValue('SECRETS_MASTER_KEY');
  if (!key) {
    throw new Error(
      'SECRETS_MASTER_KEY ausente. As credenciais de integração só podem ser ' +
        'cifradas com a chave mestre do ambiente — o banco nunca guarda texto puro.',
    );
  }
  return key;
}
