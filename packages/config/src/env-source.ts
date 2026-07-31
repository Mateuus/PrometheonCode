/**
 * Origem das variáveis de ambiente.
 *
 * Em desenvolvimento lemos o `.env` da raiz do monorepo — encontrada subindo
 * diretórios até achar o `pnpm-workspace.yaml`. Em produção nada é lido do
 * disco: só `process.env` vale, porque o segredo chega pelo orquestrador.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseDotenv } from 'dotenv';

/** Arquivo que marca a raiz do workspace pnpm. */
export const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

export type RawEnv = Readonly<Record<string, string | undefined>>;

export interface EnvSourceOptions {
  /** Ambiente já resolvido, quando o chamador quiser forçá-lo. */
  readonly nodeEnv?: string | undefined;
  /** Diretório inicial da busca pela raiz. Padrão: `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** Variáveis do processo. Padrão: `process.env`. */
  readonly processEnv?: RawEnv | undefined;
  /** Desliga a leitura de arquivos `.env`. Padrão: ligado fora de produção. */
  readonly loadEnvFiles?: boolean | undefined;
}

export interface EnvSourceResult {
  /** Variáveis mescladas, já sem strings vazias. */
  readonly raw: Record<string, string>;
  /** Arquivos `.env` efetivamente lidos, na ordem de precedência crescente. */
  readonly envFiles: readonly string[];
  /** Raiz do workspace, quando encontrada. */
  readonly workspaceRoot: string | undefined;
}

/** Sobe diretórios até achar o marcador da raiz do workspace. */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let current = resolve(startDir);

  for (;;) {
    if (existsSync(join(current, WORKSPACE_MARKER))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/** Lê e interpreta um arquivo `.env`; devolve `undefined` se ele não existir. */
function readEnvFile(filePath: string): Record<string, string> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  return parseDotenv(readFileSync(filePath, 'utf8'));
}

/**
 * String vazia no `.env` significa "não configurado". Sem isso, `DATABASE_HOST=`
 * passaria pela checagem de obrigatoriedade com um valor inútil.
 */
function assignDefined(
  target: Record<string, string>,
  source: RawEnv,
): Record<string, string> {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }

    if (value.trim().length === 0) {
      continue;
    }

    target[key] = value;
  }

  return target;
}

/**
 * Reúne as variáveis efetivas.
 *
 * Precedência (do mais fraco ao mais forte): `.env`, `.env.<NODE_ENV>` e
 * `process.env`. Quem exporta a variável no shell sempre vence o arquivo.
 */
export function collectRawEnv(options: EnvSourceOptions = {}): EnvSourceResult {
  const processEnv: RawEnv = options.processEnv ?? process.env;
  const nodeEnv = options.nodeEnv ?? processEnv['NODE_ENV'] ?? 'development';
  const loadEnvFiles = options.loadEnvFiles ?? nodeEnv !== 'production';

  if (!loadEnvFiles) {
    return {
      raw: assignDefined({}, processEnv),
      envFiles: [],
      workspaceRoot: undefined,
    };
  }

  const searchRoots = [
    options.cwd ?? process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ];

  let workspaceRoot: string | undefined;

  for (const candidate of searchRoots) {
    workspaceRoot = findWorkspaceRoot(candidate);

    if (workspaceRoot !== undefined) {
      break;
    }
  }

  const raw: Record<string, string> = {};
  const envFiles: string[] = [];

  if (workspaceRoot !== undefined) {
    for (const fileName of ['.env', `.env.${nodeEnv}`]) {
      const filePath = join(workspaceRoot, fileName);
      const parsed = readEnvFile(filePath);

      if (parsed !== undefined) {
        assignDefined(raw, parsed);
        envFiles.push(filePath);
      }
    }
  }

  assignDefined(raw, processEnv);

  return { raw, envFiles, workspaceRoot };
}
