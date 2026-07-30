import * as vscode from 'vscode';
import {
  MAX_MCP_ARGS,
  MAX_MCP_ARG_LENGTH,
  MAX_MCP_COMMAND_LENGTH,
  MAX_MCP_ENTRIES,
  MAX_MCP_KEY_LENGTH,
  MAX_MCP_NAME_LENGTH,
  MAX_MCP_SERVERS,
  MAX_MCP_URL_LENGTH,
  MAX_MCP_VALUE_LENGTH,
  MCP_TRANSPORTS,
  type McpKeyValue,
  type McpProblem,
  type McpServerDraft,
  type McpServerSummary,
  type McpStatus,
  type McpTransport,
} from '../core/types';
import type { Logger } from '../logger';
import { PrometheonError } from '../utils/errors';
import { sanitize } from '../utils/sanitize';
import type { WorkspaceService } from './WorkspaceService';

/** Nenhuma pasta aberta: não há projeto onde o `.mcp.json` possa morar. */
export class McpWorkspaceRequiredError extends PrometheonError {
  constructor() {
    super(
      'MCP servers are configured in .mcp.json at the root of the open folder. Open a folder first.',
      'mcp.workspace-required',
    );
  }
}

export class McpServerNotFoundError extends PrometheonError {
  constructor(name: string) {
    super(`MCP server not found: ${name}`, 'mcp.server-not-found');
  }
}

export class InvalidMcpServerError extends PrometheonError {
  constructor(message: string) {
    super(message, 'mcp.server-invalid');
  }
}

/** O arquivo existe mas não é um `.mcp.json` que possamos reescrever. */
export class InvalidMcpFileError extends PrometheonError {
  constructor(detail: string) {
    super(`.mcp.json could not be read: ${detail}`, 'mcp.file-invalid');
  }
}

export const MCP_FILE_NAME = '.mcp.json';
const SERVERS_KEY = 'mcpServers';
/** Convenção do arquivo, respeitada na regravação. */
const INDENT = 2;

export interface McpImportResult {
  readonly imported: readonly string[];
  /** Nomes que já existiam: nada é sobrescrito em silêncio. */
  readonly conflicts: readonly string[];
  readonly problems: readonly McpProblem[];
}

/**
 * Servidores MCP do projeto, no `.mcp.json` da raiz do workspace.
 *
 * O formato é o mesmo que Claude Code, Cursor e o VS Code leem: um objeto
 * `mcpServers` mapeando nome → configuração. Como o arquivo pertence ao projeto
 * e é lido por outras ferramentas, campos desconhecidos — de uma entrada ou do
 * documento — são preservados na regravação: apagar o que não entendemos
 * quebraria a configuração de quem mais o usa.
 *
 * O arquivo costuma ser versionado e pode conter `env`/`headers`. Segredos em
 * texto puro são apenas **avisados** na interface; o arquivo do usuário nunca é
 * reescrito nem mascarado por conta própria, e o valor jamais vai para o log.
 */
export class McpConfigStore {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly logger: Logger,
  ) {}

  get file(): vscode.Uri | null {
    const folder = this.workspace.folder;
    return folder === undefined ? null : vscode.Uri.joinPath(folder.uri, MCP_FILE_NAME);
  }

  /** Situação pronta para a interface, sem lançar quando falta a pasta. */
  async status(): Promise<McpStatus> {
    const file = this.file;
    if (file === null) {
      return {
        available: false,
        exists: false,
        file: null,
        servers: [],
        problems: [],
        message:
          'MCP servers are configured in .mcp.json at the root of the open folder. Open a folder to configure them.',
      };
    }

    const document = await this.readDocument(file);
    if (document === null) {
      return { available: true, exists: false, file: file.fsPath, servers: [], problems: [] };
    }
    if (document.error !== undefined) {
      return {
        available: true,
        exists: true,
        file: file.fsPath,
        servers: [],
        problems: [{ name: MCP_FILE_NAME, detail: document.error }],
      };
    }

    const { servers, problems } = readServers(document.servers);
    return { available: true, exists: true, file: file.fsPath, servers, problems };
  }

  /** Cria ou substitui um servidor, preservando o resto do arquivo. */
  async save(draft: McpServerDraft): Promise<void> {
    const entry = buildEntry(draft);
    await this.mutate((servers) => {
      const existing = servers[draft.name];
      if (existing === undefined && Object.keys(servers).length >= MAX_MCP_SERVERS) {
        throw new InvalidMcpServerError(`At most ${MAX_MCP_SERVERS} MCP servers per workspace.`);
      }
      // Campos que não conhecemos continuam onde estavam; os do transporte
      // anterior saem, senão a entrada ficaria com `command` e `url` ao mesmo tempo.
      const preserved = isRecord(existing) ? dropTransportFields(existing) : {};
      return { ...servers, [draft.name]: { ...preserved, ...entry } };
    });
  }

  async remove(name: string): Promise<void> {
    await this.mutate((servers) => {
      if (!(name in servers)) {
        throw new McpServerNotFoundError(name);
      }
      const next = { ...servers };
      delete next[name];
      return next;
    });
  }

  /**
   * Liga e desliga sem apagar a configuração. Grava `disabled: true`, que é
   * como os clientes MCP marcam um servidor inativo; `enabled` remove a chave.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.mutate((servers) => {
      const current = servers[name];
      if (!isRecord(current)) {
        throw new McpServerNotFoundError(name);
      }
      const next = { ...current };
      if (enabled) {
        delete next['disabled'];
      } else {
        next['disabled'] = true;
      }
      return { ...servers, [name]: next };
    });
  }

  /**
   * Mescla as entradas de outro `.mcp.json`. Nome já existente não é
   * sobrescrito: ele volta como conflito para a interface avisar.
   */
  async importFrom(source: vscode.Uri): Promise<McpImportResult> {
    const document = await this.readDocument(source);
    if (document === null) {
      throw new InvalidMcpFileError('file not found');
    }
    if (document.error !== undefined) {
      throw new InvalidMcpFileError(document.error);
    }

    const { servers, problems } = readServers(document.servers);
    const imported: string[] = [];
    const conflicts: string[] = [];

    await this.mutate((current) => {
      const next = { ...current };
      for (const server of servers) {
        if (server.name in next) {
          conflicts.push(server.name);
          continue;
        }
        const entry = document.servers[server.name];
        if (isRecord(entry)) {
          next[server.name] = entry;
          imported.push(server.name);
        }
      }
      return next;
    });

    this.logger.info(
      `Importação de MCP concluída: ${imported.length} adicionado(s), ${conflicts.length} conflito(s).`,
    );
    return { imported, conflicts, problems };
  }

  /** Lê o documento inteiro para preservar o que não é `mcpServers`. */
  private async readDocument(
    file: vscode.Uri,
  ): Promise<{
    readonly root: Record<string, unknown>;
    readonly servers: Record<string, unknown>;
    readonly error?: string;
  } | null> {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      // Arquivo ausente é o estado normal antes do primeiro servidor.
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // A mensagem do parser pode citar o conteúdo da linha: sanitizada.
      const detail = sanitize(error instanceof Error ? error.message : 'invalid JSON');
      this.logger.warn(`${MCP_FILE_NAME} não é JSON válido: ${detail}`);
      return { root: {}, servers: {}, error: `invalid JSON (${detail})` };
    }
    if (!isRecord(parsed)) {
      return { root: {}, servers: {}, error: 'the file must contain a JSON object' };
    }

    const servers = parsed[SERVERS_KEY];
    if (servers !== undefined && !isRecord(servers)) {
      return { root: parsed, servers: {}, error: `"${SERVERS_KEY}" must be an object` };
    }
    return { root: parsed, servers: isRecord(servers) ? servers : {} };
  }

  /**
   * Lê, altera só `mcpServers` e grava de volta. O resto do documento e a
   * indentação de 2 espaços são preservados.
   */
  private async mutate(
    change: (servers: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const file = this.file;
    if (file === null) {
      throw new McpWorkspaceRequiredError();
    }

    const document = await this.readDocument(file);
    if (document?.error !== undefined) {
      throw new InvalidMcpFileError(document.error);
    }
    const root = document?.root ?? {};
    const servers = document?.servers ?? {};

    const next = { ...root, [SERVERS_KEY]: change(servers) };
    const content = `${JSON.stringify(next, null, INDENT)}\n`;
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(content));
    this.logger.info(`${MCP_FILE_NAME} atualizado.`);
    this.workspace.notifyChanged();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Campos que pertencem a um transporte e não podem sobreviver à troca dele. */
function dropTransportFields(entry: Record<string, unknown>): Record<string, unknown> {
  const next = { ...entry };
  for (const key of ['type', 'command', 'args', 'env', 'url', 'headers', 'disabled']) {
    delete next[key];
  }
  return next;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }
  return hasControlCharacter(trimmed) ? null : trimmed;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/** Só `http` e `https`: o formato não prevê outro esquema. */
function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readPairs(value: unknown, label: string): readonly McpKeyValue[] | string {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return `"${label}" must be an object`;
  }
  const pairs: McpKeyValue[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const name = text(key, MAX_MCP_KEY_LENGTH);
    if (name === null || typeof raw !== 'string' || raw.length > MAX_MCP_VALUE_LENGTH) {
      return `"${label}" must map names to short strings`;
    }
    pairs.push({ key: name, value: raw });
  }
  return pairs.length > MAX_MCP_ENTRIES ? `"${label}" has too many entries` : pairs;
}

/**
 * Interpreta uma entrada do `mcpServers`. Entrada malformada volta como texto
 * de problema: ela é reportada na interface, e nunca corrigida em silêncio.
 */
export function normalizeMcpEntry(name: string, value: unknown): McpServerSummary | string {
  if (text(name, MAX_MCP_NAME_LENGTH) === null || !NAME_PATTERN.test(name)) {
    return 'the server name must be short, without spaces or control characters';
  }
  if (!isRecord(value)) {
    return 'the entry must be a JSON object';
  }

  // `type` ausente significa stdio, que é o padrão do formato.
  const rawType = value['type'];
  const transport: McpTransport | null =
    rawType === undefined
      ? 'stdio'
      : (MCP_TRANSPORTS.find((candidate) => candidate === rawType) ?? null);
  if (transport === null) {
    return `"type" must be one of ${MCP_TRANSPORTS.join(', ')}`;
  }

  const env = readPairs(value['env'], 'env');
  if (typeof env === 'string') {
    return env;
  }
  const headers = readPairs(value['headers'], 'headers');
  if (typeof headers === 'string') {
    return headers;
  }

  const disabled = value['disabled'];
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    return '"disabled" must be true or false';
  }

  const known = new Set(['type', 'command', 'args', 'env', 'url', 'headers', 'disabled']);
  const preservedFields = Object.keys(value).filter((key) => !known.has(key));
  const base = {
    name,
    transport,
    env,
    headers,
    enabled: disabled !== true,
    preservedFields,
    warnings: describeSecrets([...env, ...headers]),
  };

  if (transport === 'stdio') {
    const command = text(value['command'], MAX_MCP_COMMAND_LENGTH);
    if (command === null) {
      return '"command" is required for a stdio server';
    }
    const rawArgs = value['args'];
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      return '"args" must be an array of strings';
    }
    const entries: readonly unknown[] = Array.isArray(rawArgs) ? rawArgs : [];
    if (entries.length > MAX_MCP_ARGS) {
      return '"args" has too many entries';
    }
    const args: string[] = [];
    for (const entry of entries) {
      const arg = text(entry, MAX_MCP_ARG_LENGTH);
      if (arg === null) {
        return '"args" must be an array of strings';
      }
      args.push(arg);
    }
    return { ...base, command, args };
  }

  const url = text(value['url'], MAX_MCP_URL_LENGTH);
  if (url === null || !isSupportedUrl(url)) {
    return `"url" is required for a ${transport} server and must use http or https`;
  }
  return { ...base, args: [], url };
}

function readServers(servers: Record<string, unknown>): {
  readonly servers: readonly McpServerSummary[];
  readonly problems: readonly McpProblem[];
} {
  const parsed: McpServerSummary[] = [];
  const problems: McpProblem[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const result = normalizeMcpEntry(name, value);
    if (typeof result === 'string') {
      problems.push({ name, detail: result });
    } else {
      parsed.push(result);
    }
  }
  return { servers: parsed, problems };
}

/** Monta a entrada do arquivo a partir do que a interface editou. */
export function buildEntry(draft: McpServerDraft): Record<string, unknown> {
  if (text(draft.name, MAX_MCP_NAME_LENGTH) === null || !NAME_PATTERN.test(draft.name)) {
    return badDraft('Give the server a name without spaces.');
  }

  const entry: Record<string, unknown> = {};
  if (draft.transport === 'stdio') {
    const command = text(draft.command, MAX_MCP_COMMAND_LENGTH);
    if (command === null) {
      return badDraft('A stdio server needs a command.');
    }
    entry['command'] = command;
    if (draft.args.length > 0) {
      entry['args'] = [...draft.args];
    }
    const env = toObject(draft.env);
    if (Object.keys(env).length > 0) {
      entry['env'] = env;
    }
  } else {
    const url = text(draft.url, MAX_MCP_URL_LENGTH);
    if (url === null || !isSupportedUrl(url)) {
      return badDraft('An http or sse server needs a URL starting with http:// or https://.');
    }
    entry['type'] = draft.transport;
    entry['url'] = url;
    const headers = toObject(draft.headers);
    if (Object.keys(headers).length > 0) {
      entry['headers'] = headers;
    }
  }

  if (!draft.enabled) {
    entry['disabled'] = true;
  }
  return entry;
}

function badDraft(message: string): never {
  throw new InvalidMcpServerError(message);
}

function toObject(pairs: readonly McpKeyValue[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    if (pair.key.trim() !== '') {
      record[pair.key.trim()] = pair.value;
    }
  }
  return record;
}

/** Nome de variável (`GITHUB_TOKEN`) ou referência (`${GITHUB_TOKEN}`, `$VAR`). */
const REFERENCE = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|[A-Z][A-Z0-9_]{2,})$/;
const SENSITIVE_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
/** Prefixos usados por chaves reais de provedores conhecidos. */
const KEY_SHAPED = /^(bearer\s+\S+|sk-\S{8,}|ghp_\S{8,}|gh[pousr]_\S{8,}|xox[baprs]-\S{8,})/i;

/**
 * Diz se um par tem cara de credencial em texto puro. Referência por nome de
 * variável — que é o uso correto — não é apontada. O valor nunca aparece na
 * mensagem: só o nome do campo.
 */
export function looksLikeSecret(pair: McpKeyValue): boolean {
  const value = pair.value.trim();
  if (value === '' || REFERENCE.test(value)) {
    return false;
  }
  if (KEY_SHAPED.test(value)) {
    return true;
  }
  return SENSITIVE_KEY.test(pair.key) && value.length >= 8;
}

function describeSecrets(pairs: readonly McpKeyValue[]): readonly string[] {
  const flagged = pairs.filter(looksLikeSecret).map((pair) => pair.key);
  if (flagged.length === 0) {
    return [];
  }
  return [
    `${flagged.join(', ')} looks like a credential written in plain text. This file usually goes into Git — move the value to an environment variable and reference it by name.`,
  ];
}
