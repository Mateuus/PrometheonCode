import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_QUESTIONS,
  MAX_QUESTION_HEADER_LENGTH,
  MAX_QUESTION_OPTIONS,
  type AgentQuestionAnswer,
  type AgentQuestionRequest,
} from '../agents/questions';
import { IMAGE_MIME_TYPES, type ChatEvent, type ImageAttachment } from '../chat/types';
import { LANGUAGE_CHOICES, type LanguageChoice } from '../i18n/language';
import type { PrometheonViewState } from '../core/state';
import {
  AGENT_AUTONOMY_MODES,
  AGENT_ROLES,
  AGENT_ROLE_SCOPES,
  AUTONOMY_LEVELS,
  CHAT_TYPES,
  CONTEXT_STRATEGIES,
  MAX_CONCURRENT_SESSIONS,
  MAX_ROLE_DESCRIPTION_LENGTH,
  MAX_ROLE_LABEL_LENGTH,
  MAX_MCP_ARGS,
  MAX_MCP_ARG_LENGTH,
  MAX_MCP_COMMAND_LENGTH,
  MAX_MCP_ENTRIES,
  MAX_MCP_KEY_LENGTH,
  MAX_MCP_NAME_LENGTH,
  MAX_MCP_URL_LENGTH,
  MAX_MCP_VALUE_LENGTH,
  MCP_TRANSPORTS,
  MAX_MODEL_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOOLS_PER_LIST,
  MAX_TOOL_NAME_LENGTH,
  WORK_MODES,
  type ActiveAgentSummary,
  type ActivityStatus,
  type AgentAutonomyMode,
  type AgentRole,
  type AgentRoleScope,
  COMMIT_LANGUAGES,
  COMMIT_STYLES,
  GRAPH_REBUILD_TRIGGERS,
  type Autonomy,
  type ChatType,
  type CommitLanguage,
  type CommitStyle,
  type ContextStrategy,
  type GraphRebuildTrigger,
  type HubConnectionStatus,
  type McpKeyValue,
  type McpServerDraft,
  type McpTransport,
  type SerializedError,
  type UiNotification,
  type WorkMode,
} from '../core/types';
import { PROVIDER_IDS } from '../providers/types';

export type WorkspaceSetupChoice = 'current' | 'external' | 'skip';

/** Seções do modal de configuração, na ordem em que aparecem na navegação. */
export type SettingsSection =
  | 'general'
  | 'accounts'
  | 'agents'
  | 'skills'
  | 'workspace'
  | 'graph'
  | 'git'
  | 'mcp';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'accounts',
  'agents',
  'skills',
  'workspace',
  'graph',
  'git',
  'mcp',
];

/** Agent Profile como a webview o envia: sem `id`, atribuído pela extensão. */
export interface AgentProfileDraft {
  readonly name: string;
  readonly providerProfileId: string;
  readonly role: AgentRole;
  readonly customRoleId?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly autonomyMode: AgentAutonomyMode;
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly skills: readonly string[];
  readonly maxConcurrentSessions: number;
  readonly contextStrategy: ContextStrategy;
  readonly enabled: boolean;
}

/** Papel nomeado como a webview o envia: sem `id`, atribuído pela extensão. */
export interface CustomRoleDraft {
  readonly label: string;
  readonly description: string;
  readonly basedOn: AgentRole;
  readonly skills: readonly string[];
  readonly systemPrompt?: string;
  readonly scope: AgentRoleScope;
}

/** Anexo como a webview o envia: sem `id`, que é atribuído pela extensão. */
export type DraftAttachment = Omit<ImageAttachment, 'id'>;

export type WebviewToExtensionMessage =
  | { readonly type: 'ui.ready' }
  | {
      readonly type: 'chat.send';
      readonly payload: {
        readonly content: string;
        readonly attachments: readonly DraftAttachment[];
      };
    }
  | { readonly type: 'chat.cancel'; readonly payload: { readonly runId: string } }
  | { readonly type: 'chat.newLocal' }
  | { readonly type: 'chat.clearLocal' }
  | { readonly type: 'chat.openSession'; readonly payload: { readonly conversationId: string } }
  | { readonly type: 'chat.deleteSession'; readonly payload: { readonly conversationId: string } }
  | { readonly type: 'chat.attachImages' }
  /** Abre a saída integral de um passo numa aba somente leitura do editor. */
  | {
      readonly type: 'chat.openStepOutput';
      readonly payload: { readonly stepId: string; readonly label: string };
    }
  /** Escolhe um arquivo do projeto e o cita no composer. */
  | { readonly type: 'context.addFile' }
  | { readonly type: 'context.compact' }
  | { readonly type: 'context.setAutoCompact'; readonly payload: { readonly enabled: boolean } }
  /** Resposta do usuário à pergunta aberta do agente. */
  | {
      readonly type: 'question.answer';
      readonly payload: {
        readonly requestId: string;
        readonly answers: readonly AgentQuestionAnswer[];
      };
    }
  /** O modal foi fechado sem resposta; o agente segue sem ela. */
  | { readonly type: 'question.cancel'; readonly payload: { readonly requestId: string } }
  | { readonly type: 'speech.start' }
  | { readonly type: 'speech.stop' }
  | { readonly type: 'speech.cancel' }
  | { readonly type: 'accounts.refresh' }
  | {
      readonly type: 'accounts.create';
      /** Sem modelo: uma conta é um login isolado, e quem escolhe modelo é o agente. */
      readonly payload: {
        readonly name: string;
        readonly providerId: string;
      };
    }
  /** Corrige o rótulo da conta; o diretório e o login seguem os mesmos. */
  | {
      readonly type: 'accounts.rename';
      readonly payload: { readonly profileId: string; readonly name: string };
    }
  | { readonly type: 'accounts.login'; readonly payload: { readonly profileId: string } }
  | { readonly type: 'accounts.logout'; readonly payload: { readonly profileId: string } }
  | { readonly type: 'accounts.remove'; readonly payload: { readonly profileId: string } }
  | {
      readonly type: 'agentProfiles.create';
      readonly payload: { readonly profile: AgentProfileDraft };
    }
  | {
      readonly type: 'agentProfiles.update';
      readonly payload: { readonly id: string; readonly profile: AgentProfileDraft };
    }
  | { readonly type: 'agentProfiles.remove'; readonly payload: { readonly id: string } }
  | {
      readonly type: 'agentProfiles.setEnabled';
      readonly payload: { readonly id: string; readonly enabled: boolean };
    }
  | { readonly type: 'agentRoles.create'; readonly payload: { readonly role: CustomRoleDraft } }
  | {
      readonly type: 'agentRoles.update';
      readonly payload: { readonly id: string; readonly role: CustomRoleDraft };
    }
  | { readonly type: 'agentRoles.remove'; readonly payload: { readonly id: string } }
  | { readonly type: 'skills.refresh' }
  /** Abre um `SKILL.md` no editor. A webview manda o nome; o Core resolve o caminho. */
  | { readonly type: 'skills.open'; readonly payload: { readonly name: string } }
  | { readonly type: 'mcp.refresh' }
  /** Escolher e mesclar outro `.mcp.json` — a leitura acontece na extensão. */
  | { readonly type: 'mcp.import' }
  | { readonly type: 'mcp.save'; readonly payload: { readonly server: McpServerDraft } }
  | { readonly type: 'mcp.remove'; readonly payload: { readonly name: string } }
  | {
      readonly type: 'mcp.setEnabled';
      readonly payload: { readonly name: string; readonly enabled: boolean };
    }
  | { readonly type: 'chat.selectType'; readonly payload: { readonly chatType: ChatType } }
  /** Projeto do Hub onde as conversas do Web Chat moram. */
  | { readonly type: 'chat.selectProject'; readonly payload: { readonly projectId: string } }
  | { readonly type: 'settings.setWorkMode'; readonly payload: { readonly mode: WorkMode } }
  | { readonly type: 'settings.setAutonomy'; readonly payload: { readonly autonomy: Autonomy } }
  | { readonly type: 'settings.selectMainAgent'; readonly payload: { readonly agentId: string } }
  /** Troca o modelo da conta que o agente principal usa. */
  | { readonly type: 'settings.setModel'; readonly payload: { readonly model: string } }
  | {
      readonly type: 'settings.setLanguage';
      readonly payload: { readonly language: LanguageChoice };
    }
  /** Abre as configurações da extensão no editor do VS Code (botão de engrenagem). */
  | { readonly type: 'settings.openEditor' }
  | {
      readonly type: 'workspace.initialize';
      readonly payload: { readonly choice: WorkspaceSetupChoice };
    }
  | { readonly type: 'agents.stop'; readonly payload: { readonly sessionId: string } }
  /** Grava um ou mais campos do grafo; só o que veio no patch é tocado. */
  | { readonly type: 'graph.update'; readonly payload: { readonly patch: GraphPatch } }
  /** Dispara o comando de rebuild num terminal do editor. */
  | { readonly type: 'graph.rebuild' }
  | { readonly type: 'git.update'; readonly payload: { readonly patch: GitPatch } }
  /** Escreve os hooks e aponta `core.hooksPath` para eles nesta máquina. */
  | { readonly type: 'git.installHooks' }
  | { readonly type: 'git.uninstallHooks' }
  | { readonly type: 'hub.connect.request' }
  /** Sai do Hub: a credencial do dispositivo é esquecida nesta máquina. */
  | { readonly type: 'hub.signOut' };

/** Campos do grafo que a webview pode gravar, todos opcionais. */
export interface GraphPatch {
  readonly enabled?: boolean;
  readonly outputDir?: string;
  readonly rebuildCommand?: string;
  readonly rebuildOn?: GraphRebuildTrigger;
  readonly gate?: string;
  readonly blockOnHygieneFailure?: boolean;
}

/** Campos da política de commit que a webview pode gravar. */
export interface GitPatch {
  readonly coAuthoredBy?: boolean;
  readonly commitStyle?: CommitStyle;
  readonly commitLanguage?: CommitLanguage;
  readonly scopes?: readonly string[];
}

export type ExtensionToWebviewMessage =
  | { readonly type: 'state.snapshot'; readonly payload: PrometheonViewState }
  | { readonly type: 'chat.event'; readonly payload: ChatEvent }
  | { readonly type: 'chat.error'; readonly payload: SerializedError }
  | { readonly type: 'agents.updated'; readonly payload: readonly ActiveAgentSummary[] }
  | { readonly type: 'hub.status'; readonly payload: HubConnectionStatus }
  | {
      readonly type: 'attachments.added';
      readonly payload: { readonly attachments: readonly ImageAttachment[] };
    }
  /** Texto ditado, para o cliente inserir no rascunho onde está o cursor. */
  | { readonly type: 'speech.transcript'; readonly payload: { readonly text: string } }
  /**
   * Revisão do ditado, enquanto a fala continua.
   *
   * Substitui o rascunho corrente por inteiro em vez de acrescentar: o modelo
   * reescreve palavras já ditas quando o resto da frase esclarece o sentido.
   */
  | { readonly type: 'speech.partial'; readonly payload: { readonly text: string } }
  /** Texto para o composer receber no ponto do cursor (citação de arquivo). */
  | { readonly type: 'composer.insert'; readonly payload: { readonly text: string } }
  /** Abre o modal de pergunta do agente; o run espera do outro lado. */
  | { readonly type: 'question.ask'; readonly payload: AgentQuestionRequest }
  | { readonly type: 'question.close'; readonly payload: { readonly requestId: string } }
  | { readonly type: 'activity'; readonly payload: ActivityStatus }
  /**
   * Abre o modal de configuração da webview já na seção pedida. `focus: 'new'`
   * abre o formulário de criação da seção e coloca o cursor nele.
   */
  | {
      readonly type: 'settings.open';
      readonly payload: { readonly section: SettingsSection; readonly focus?: 'new' };
    }
  | { readonly type: 'notification'; readonly payload: UiNotification };

/** Limite defensivo: a webview não deve conseguir enviar payload gigante. */
export const MAX_MESSAGE_LENGTH = 32_000;

/** Limites dos anexos. Imagens ficam em base64 no estado local do workspace. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_LENGTH = 120;
export const MAX_IMAGE_DIMENSION = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Tamanho real dos bytes decodificados; o valor informado pela webview é ignorado. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * Valida um anexo vindo da webview. Nada é normalizado em silêncio: mime fora da
 * lista, base64 malformado ou tamanho acima do limite derrubam a mensagem
 * inteira, como no resto desta fronteira.
 */
function parseAttachment(raw: unknown): DraftAttachment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const mimeType = oneOf(raw['mimeType'], IMAGE_MIME_TYPES);
  const data = raw['data'];
  if (mimeType === null || typeof data !== 'string') {
    return null;
  }
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
    return null;
  }
  const byteSize = base64ByteLength(data);
  if (byteSize > MAX_ATTACHMENT_BYTES) {
    return null;
  }
  const name = nonEmptyString(raw['name'], MAX_ATTACHMENT_NAME_LENGTH);
  if (name === null) {
    return null;
  }
  const width = pixelCount(raw['width']);
  const height = pixelCount(raw['height']);
  if (width === null || height === null) {
    return null;
  }
  return {
    name: fileName(name),
    mimeType,
    data,
    byteSize,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/** Dimensão opcional: inteiro positivo dentro de um limite plausível. */
function pixelCount(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_IMAGE_DIMENSION
    ? value
    : null;
}

function parseAttachments(raw: unknown): readonly DraftAttachment[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return null;
  }
  const parsed: DraftAttachment[] = [];
  for (const item of raw) {
    const attachment = parseAttachment(item);
    if (attachment === null) {
      return null;
    }
    parsed.push(attachment);
  }
  return parsed;
}

/** Caracteres de controle não têm uso em um nome mostrado na interface. */
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
}

/** Só o nome do arquivo: caminho vindo da webview nunca é usado como caminho. */
function fileName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const cleaned = [...base].filter((char) => !isControl(char)).join('').trim();
  return cleaned === '' ? 'image' : cleaned;
}

function nonEmptyString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > maxLength ? null : trimmed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

const SETUP_CHOICES: readonly WorkspaceSetupChoice[] = ['current', 'external', 'skip'];

/**
 * Lista de ferramentas de um Agent Profile. Vem da webview como array de
 * strings: nomes curtos, sem vazio e sem repetição.
 */
function parseToolList(raw: unknown): readonly string[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS_PER_LIST) {
    return null;
  }
  const tools: string[] = [];
  for (const entry of raw) {
    const tool = nonEmptyString(entry, MAX_TOOL_NAME_LENGTH);
    if (tool === null) {
      return null;
    }
    if (!tools.includes(tool)) {
      tools.push(tool);
    }
  }
  return tools;
}

/**
 * Texto opcional: ausente ou vazio vira `undefined`, presente precisa caber no
 * limite. Um valor longo demais derruba a mensagem em vez de ser cortado.
 */
function optionalText(raw: unknown, maxLength: number): string | undefined | null {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > maxLength ? null : trimmed;
}

function boundedInteger(raw: unknown, min: number, max: number): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max ? raw : null;
}

/**
 * Agent Profile vindo da webview. O binding com uma conta é obrigatório aqui:
 * uma mensagem sem `providerProfileId` nem chega ao núcleo.
 */
function parseAgentProfileDraft(raw: unknown): AgentProfileDraft | null {
  if (!isRecord(raw)) {
    return null;
  }
  const name = nonEmptyString(raw['name'], MAX_PROFILE_NAME_LENGTH);
  const providerProfileId = nonEmptyString(raw['providerProfileId'], 128);
  const role = oneOf<AgentRole>(raw['role'], AGENT_ROLES);
  const autonomyMode = oneOf<AgentAutonomyMode>(raw['autonomyMode'], AGENT_AUTONOMY_MODES);
  const contextStrategy = oneOf<ContextStrategy>(raw['contextStrategy'], CONTEXT_STRATEGIES);
  const allowedTools = parseToolList(raw['allowedTools']);
  const deniedTools = parseToolList(raw['deniedTools']);
  const maxConcurrentSessions = boundedInteger(
    raw['maxConcurrentSessions'],
    1,
    MAX_CONCURRENT_SESSIONS,
  );
  const skills = parseToolList(raw['skills']);
  const model = optionalText(raw['model'], MAX_MODEL_LENGTH);
  const systemPrompt = optionalText(raw['systemPrompt'], MAX_SYSTEM_PROMPT_LENGTH);
  const customRoleId = optionalText(raw['customRoleId'], 96);

  if (
    name === null ||
    providerProfileId === null ||
    role === null ||
    autonomyMode === null ||
    contextStrategy === null ||
    allowedTools === null ||
    deniedTools === null ||
    skills === null ||
    maxConcurrentSessions === null ||
    model === null ||
    systemPrompt === null ||
    customRoleId === null ||
    typeof raw['enabled'] !== 'boolean'
  ) {
    return null;
  }

  return {
    name,
    providerProfileId,
    role,
    ...(customRoleId === undefined ? {} : { customRoleId }),
    ...(model === undefined ? {} : { model }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    autonomyMode,
    allowedTools,
    deniedTools,
    skills,
    maxConcurrentSessions,
    contextStrategy,
    enabled: raw['enabled'],
  };
}

/**
 * Papel nomeado vindo da webview. O escopo é validado aqui porque decide onde o
 * arquivo será gravado; o resto das regras é do `AgentRoleService`.
 */
function parseCustomRoleDraft(raw: unknown): CustomRoleDraft | null {
  if (!isRecord(raw)) {
    return null;
  }
  const label = nonEmptyString(raw['label'], MAX_ROLE_LABEL_LENGTH);
  const description = nonEmptyString(raw['description'], MAX_ROLE_DESCRIPTION_LENGTH);
  const basedOn = oneOf<AgentRole>(raw['basedOn'], AGENT_ROLES);
  const scope = oneOf<AgentRoleScope>(raw['scope'], AGENT_ROLE_SCOPES);
  const skills = parseToolList(raw['skills']);
  const systemPrompt = optionalText(raw['systemPrompt'], MAX_SYSTEM_PROMPT_LENGTH);

  if (
    label === null ||
    description === null ||
    basedOn === null ||
    scope === null ||
    skills === null ||
    systemPrompt === null
  ) {
    return null;
  }

  return {
    label,
    description,
    basedOn,
    skills,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    scope,
  };
}

/**
 * Resposta a uma pergunta do agente. Aqui só se verifica a forma — se os
 * rótulos correspondem ao que foi perguntado é o núcleo que decide, porque só
 * ele conhece o pedido que está aberto.
 */
function parseQuestionAnswer(raw: unknown): AgentQuestionAnswer | null {
  if (!isRecord(raw)) {
    return null;
  }
  const header = nonEmptyString(raw['header'], MAX_QUESTION_HEADER_LENGTH);
  const rawSelected = raw['selected'];
  if (header === null || !Array.isArray(rawSelected) || rawSelected.length > MAX_QUESTION_OPTIONS) {
    return null;
  }
  const selected: string[] = [];
  for (const entry of rawSelected) {
    const label = nonEmptyString(entry, MAX_OPTION_LABEL_LENGTH);
    if (label === null || selected.includes(label)) {
      return null;
    }
    selected.push(label);
  }
  const custom = optionalText(raw['custom'], MAX_CUSTOM_ANSWER_LENGTH);
  if (custom === null) {
    return null;
  }
  // Sem escolha e sem texto livre não é resposta, é modal fechado.
  if (selected.length === 0 && custom === undefined) {
    return null;
  }
  return { header, selected, ...(custom === undefined ? {} : { custom }) };
}

function parseQuestionAnswers(raw: unknown): readonly AgentQuestionAnswer[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) {
    return null;
  }
  const answers: AgentQuestionAnswer[] = [];
  for (const entry of raw) {
    const answer = parseQuestionAnswer(entry);
    if (answer === null) {
      return null;
    }
    answers.push(answer);
  }
  return answers;
}

/** Nome de servidor: é chave de objeto no `.mcp.json`, então nada de espaço. */
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `env` e `headers` chegam como pares para preservar a ordem da edição. */
function parseKeyValues(raw: unknown): readonly McpKeyValue[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_MCP_ENTRIES) {
    return null;
  }
  const pairs: McpKeyValue[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      return null;
    }
    const key = nonEmptyString(entry['key'], MAX_MCP_KEY_LENGTH);
    const value = entry['value'];
    if (key === null || typeof value !== 'string' || value.length > MAX_MCP_VALUE_LENGTH) {
      return null;
    }
    if (pairs.some((pair) => pair.key === key)) {
      return null;
    }
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * Servidor MCP vindo da webview. O conteúdo vai para o `.mcp.json` do projeto,
 * lido também por outras ferramentas, então nada é normalizado em silêncio.
 */
function parseMcpServer(raw: unknown): McpServerDraft | null {
  if (!isRecord(raw)) {
    return null;
  }
  const name = nonEmptyString(raw['name'], MAX_MCP_NAME_LENGTH);
  const transport = oneOf<McpTransport>(raw['transport'], MCP_TRANSPORTS);
  const env = parseKeyValues(raw['env']);
  const headers = parseKeyValues(raw['headers']);
  if (
    name === null ||
    !MCP_NAME.test(name) ||
    transport === null ||
    env === null ||
    headers === null ||
    typeof raw['enabled'] !== 'boolean'
  ) {
    return null;
  }

  if (transport === 'stdio') {
    const command = nonEmptyString(raw['command'], MAX_MCP_COMMAND_LENGTH);
    const rawArgs = raw['args'];
    if (command === null || (rawArgs !== undefined && !Array.isArray(rawArgs))) {
      return null;
    }
    const entries: readonly unknown[] = Array.isArray(rawArgs) ? rawArgs : [];
    if (entries.length > MAX_MCP_ARGS) {
      return null;
    }
    const args: string[] = [];
    for (const entry of entries) {
      const arg = nonEmptyString(entry, MAX_MCP_ARG_LENGTH);
      if (arg === null) {
        return null;
      }
      args.push(arg);
    }
    return { name, transport, command, args, env, headers: [], enabled: raw['enabled'] };
  }

  const url = nonEmptyString(raw['url'], MAX_MCP_URL_LENGTH);
  if (url === null || !isHttpUrl(url)) {
    return null;
  }
  return { name, transport, args: [], env: [], url, headers, enabled: raw['enabled'] };
}

/** Só `http` e `https`: o formato não prevê outro esquema. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Um comando de shell inteiro cabe folgado; mais que isto é abuso. */
export const MAX_COMMAND_LENGTH = 1_000;
export const MAX_PATH_LENGTH = 260;
export const MAX_SCOPES = 32;
export const MAX_SCOPE_LENGTH = 40;

/**
 * Patch do grafo.
 *
 * Campo ausente significa "não mexa"; campo presente com tipo errado derruba a
 * mensagem inteira. O comando de rebuild vai parar num shell, então o que passa
 * daqui precisa ser exatamente o que o usuário digitou — nada de "corrigir" um
 * valor estranho e executar a correção.
 */
function parseGraphPatch(raw: unknown): GraphPatch | null {
  if (!isRecord(raw)) {
    return null;
  }
  const patch: {
    enabled?: boolean;
    outputDir?: string;
    rebuildCommand?: string;
    rebuildOn?: GraphRebuildTrigger;
    gate?: string;
    blockOnHygieneFailure?: boolean;
  } = {};

  for (const [key, limit] of [
    ['outputDir', MAX_PATH_LENGTH],
    ['rebuildCommand', MAX_COMMAND_LENGTH],
    ['gate', MAX_COMMAND_LENGTH],
  ] as const) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.length > limit) {
      return null;
    }
    patch[key] = value.trim();
  }

  for (const key of ['enabled', 'blockOnHygieneFailure'] as const) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'boolean') {
      return null;
    }
    patch[key] = value;
  }

  if (raw['rebuildOn'] !== undefined) {
    const trigger = GRAPH_REBUILD_TRIGGERS.find((entry) => entry === raw['rebuildOn']);
    if (trigger === undefined) {
      return null;
    }
    patch.rebuildOn = trigger;
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

function parseGitPatch(raw: unknown): GitPatch | null {
  if (!isRecord(raw)) {
    return null;
  }
  const patch: {
    coAuthoredBy?: boolean;
    commitStyle?: CommitStyle;
    commitLanguage?: CommitLanguage;
    scopes?: readonly string[];
  } = {};

  if (raw['coAuthoredBy'] !== undefined) {
    if (typeof raw['coAuthoredBy'] !== 'boolean') {
      return null;
    }
    patch.coAuthoredBy = raw['coAuthoredBy'];
  }

  if (raw['commitStyle'] !== undefined) {
    const style = COMMIT_STYLES.find((entry) => entry === raw['commitStyle']);
    if (style === undefined) {
      return null;
    }
    patch.commitStyle = style;
  }

  if (raw['commitLanguage'] !== undefined) {
    const language = COMMIT_LANGUAGES.find((entry) => entry === raw['commitLanguage']);
    if (language === undefined) {
      return null;
    }
    patch.commitLanguage = language;
  }

  if (raw['scopes'] !== undefined) {
    if (!Array.isArray(raw['scopes']) || raw['scopes'].length > MAX_SCOPES) {
      return null;
    }
    const scopes: string[] = [];
    for (const entry of raw['scopes']) {
      if (typeof entry !== 'string' || entry.length > MAX_SCOPE_LENGTH) {
        return null;
      }
      const scope = entry.trim();
      if (scope !== '' && !scopes.includes(scope)) {
        scopes.push(scope);
      }
    }
    patch.scopes = scopes;
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Valida em runtime tudo o que vem da webview. TypeScript não protege esta
 * fronteira: a mensagem chega como `unknown` e qualquer campo inesperado deve
 * derrubar a mensagem inteira, não ser normalizado silenciosamente.
 */
export function parseWebviewMessage(raw: unknown): WebviewToExtensionMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    return null;
  }
  const payload = isRecord(raw['payload']) ? raw['payload'] : undefined;

  switch (raw['type']) {
    case 'ui.ready':
    case 'chat.newLocal':
    case 'chat.clearLocal':
    case 'chat.attachImages':
    case 'speech.start':
    case 'speech.stop':
    case 'speech.cancel':
    case 'accounts.refresh':
    case 'skills.refresh':
    case 'mcp.refresh':
    case 'mcp.import':
    case 'settings.openEditor':
    case 'context.addFile':
    case 'context.compact':
    case 'graph.rebuild':
    case 'git.installHooks':
    case 'git.uninstallHooks':
    case 'hub.signOut':
    case 'hub.connect.request':
      return { type: raw['type'] };

    case 'graph.update': {
      const patch = payload === undefined ? null : parseGraphPatch(payload['patch']);
      return patch === null ? null : { type: 'graph.update', payload: { patch } };
    }

    case 'git.update': {
      const patch = payload === undefined ? null : parseGitPatch(payload['patch']);
      return patch === null ? null : { type: 'git.update', payload: { patch } };
    }

    case 'chat.send': {
      if (payload === undefined || typeof payload['content'] !== 'string') {
        return null;
      }
      const content = payload['content'].trim();
      if (content.length > MAX_MESSAGE_LENGTH) {
        return null;
      }
      const attachments = parseAttachments(payload['attachments']);
      if (attachments === null) {
        return null;
      }
      // Uma mensagem só de imagens é válida; uma mensagem sem nada, não.
      if (content.length === 0 && attachments.length === 0) {
        return null;
      }
      return { type: 'chat.send', payload: { content, attachments } };
    }

    case 'chat.openStepOutput': {
      const stepId = payload === undefined ? null : nonEmptyString(payload['stepId'], 128);
      const label = payload === undefined ? null : nonEmptyString(payload['label'], 120);
      return stepId === null || label === null
        ? null
        : { type: 'chat.openStepOutput', payload: { stepId, label } };
    }

    case 'accounts.login':
    case 'accounts.logout':
    case 'accounts.remove': {
      const profileId = payload === undefined ? null : nonEmptyString(payload['profileId'], 128);
      return profileId === null ? null : { type: raw['type'], payload: { profileId } };
    }

    case 'accounts.rename': {
      const profileId = payload === undefined ? null : nonEmptyString(payload['profileId'], 128);
      // Renomear para nada seria apagar a única forma de reconhecer a conta na
      // lista: um nome vazio recusa a mensagem inteira.
      const name = payload === undefined ? null : nonEmptyString(payload['name'], MAX_PROFILE_NAME_LENGTH);
      return profileId === null || name === null
        ? null
        : { type: 'accounts.rename', payload: { profileId, name } };
    }

    case 'accounts.create': {
      // O provedor é restrito à lista conhecida: a webview não inventa CLI.
      const name = payload === undefined ? null : nonEmptyString(payload['name'], MAX_PROFILE_NAME_LENGTH);
      const providerId = payload === undefined ? null : oneOf(payload['providerId'], PROVIDER_IDS);
      return name === null || providerId === null
        ? null
        : { type: 'accounts.create', payload: { name, providerId } };
    }

    case 'agentProfiles.create': {
      const profile = payload === undefined ? null : parseAgentProfileDraft(payload['profile']);
      return profile === null ? null : { type: 'agentProfiles.create', payload: { profile } };
    }

    case 'agentProfiles.update': {
      const id = payload === undefined ? null : nonEmptyString(payload['id'], 128);
      const profile = payload === undefined ? null : parseAgentProfileDraft(payload['profile']);
      return id === null || profile === null
        ? null
        : { type: 'agentProfiles.update', payload: { id, profile } };
    }

    case 'agentProfiles.remove': {
      const id = payload === undefined ? null : nonEmptyString(payload['id'], 128);
      return id === null ? null : { type: 'agentProfiles.remove', payload: { id } };
    }

    case 'agentProfiles.setEnabled': {
      const id = payload === undefined ? null : nonEmptyString(payload['id'], 128);
      const enabled = payload?.['enabled'];
      return id === null || typeof enabled !== 'boolean'
        ? null
        : { type: 'agentProfiles.setEnabled', payload: { id, enabled } };
    }

    case 'agentRoles.create': {
      const role = payload === undefined ? null : parseCustomRoleDraft(payload['role']);
      return role === null ? null : { type: 'agentRoles.create', payload: { role } };
    }

    case 'agentRoles.update': {
      const id = payload === undefined ? null : nonEmptyString(payload['id'], 96);
      const role = payload === undefined ? null : parseCustomRoleDraft(payload['role']);
      return id === null || role === null
        ? null
        : { type: 'agentRoles.update', payload: { id, role } };
    }

    case 'agentRoles.remove': {
      const id = payload === undefined ? null : nonEmptyString(payload['id'], 96);
      return id === null ? null : { type: 'agentRoles.remove', payload: { id } };
    }

    case 'skills.open': {
      // Só o nome atravessa a fronteira. Um caminho vindo da webview viraria
      // leitura arbitrária de disco; aqui o Core resolve pelo catálogo.
      const name = payload === undefined ? null : nonEmptyString(payload['name'], 64);
      return name === null ? null : { type: 'skills.open', payload: { name } };
    }

    case 'mcp.save': {
      const server = payload === undefined ? null : parseMcpServer(payload['server']);
      return server === null ? null : { type: 'mcp.save', payload: { server } };
    }

    case 'mcp.remove': {
      const name = payload === undefined ? null : nonEmptyString(payload['name'], MAX_MCP_NAME_LENGTH);
      return name === null ? null : { type: 'mcp.remove', payload: { name } };
    }

    case 'mcp.setEnabled': {
      const name = payload === undefined ? null : nonEmptyString(payload['name'], MAX_MCP_NAME_LENGTH);
      const enabled = payload?.['enabled'];
      return name === null || typeof enabled !== 'boolean'
        ? null
        : { type: 'mcp.setEnabled', payload: { name, enabled } };
    }

    case 'chat.openSession': {
      const conversationId = payload === undefined ? null : nonEmptyString(payload['conversationId'], 128);
      return conversationId === null
        ? null
        : { type: 'chat.openSession', payload: { conversationId } };
    }

    case 'chat.deleteSession': {
      const conversationId =
        payload === undefined ? null : nonEmptyString(payload['conversationId'], 128);
      return conversationId === null
        ? null
        : { type: 'chat.deleteSession', payload: { conversationId } };
    }

    case 'context.setAutoCompact': {
      const enabled = payload?.['enabled'];
      return typeof enabled !== 'boolean'
        ? null
        : { type: 'context.setAutoCompact', payload: { enabled } };
    }

    case 'settings.setModel': {
      // Igual ao de criar conta: o identificador não é restrito a uma lista, só
      // ao tamanho. Ficar de fora da tabela não pode impedir o uso do modelo.
      const model = payload === undefined ? '' : (nonEmptyString(payload['model'], 64) ?? '');
      return { type: 'settings.setModel', payload: { model } };
    }

    case 'chat.cancel': {
      const runId = payload === undefined ? null : nonEmptyString(payload['runId']);
      return runId === null ? null : { type: 'chat.cancel', payload: { runId } };
    }

    case 'question.answer': {
      const requestId = payload === undefined ? null : nonEmptyString(payload['requestId'], 128);
      const answers = payload === undefined ? null : parseQuestionAnswers(payload['answers']);
      return requestId === null || answers === null
        ? null
        : { type: 'question.answer', payload: { requestId, answers } };
    }

    case 'question.cancel': {
      const requestId = payload === undefined ? null : nonEmptyString(payload['requestId'], 128);
      return requestId === null ? null : { type: 'question.cancel', payload: { requestId } };
    }

    case 'chat.selectType': {
      const chatType = payload === undefined ? null : oneOf(payload['chatType'], CHAT_TYPES);
      return chatType === null ? null : { type: 'chat.selectType', payload: { chatType } };
    }

    case 'chat.selectProject': {
      const projectId = payload === undefined ? null : nonEmptyString(payload['projectId'], 64);
      return projectId === null ? null : { type: 'chat.selectProject', payload: { projectId } };
    }

    case 'settings.setWorkMode': {
      const mode = payload === undefined ? null : oneOf(payload['mode'], WORK_MODES);
      return mode === null ? null : { type: 'settings.setWorkMode', payload: { mode } };
    }

    case 'settings.setAutonomy': {
      const autonomy = payload === undefined ? null : oneOf(payload['autonomy'], AUTONOMY_LEVELS);
      return autonomy === null ? null : { type: 'settings.setAutonomy', payload: { autonomy } };
    }

    case 'settings.setLanguage': {
      const language = payload === undefined ? null : oneOf(payload['language'], LANGUAGE_CHOICES);
      return language === null ? null : { type: 'settings.setLanguage', payload: { language } };
    }

    case 'settings.selectMainAgent': {
      const agentId = payload === undefined ? null : nonEmptyString(payload['agentId'], 128);
      return agentId === null ? null : { type: 'settings.selectMainAgent', payload: { agentId } };
    }

    case 'workspace.initialize': {
      const choice = payload === undefined ? null : oneOf(payload['choice'], SETUP_CHOICES);
      return choice === null ? null : { type: 'workspace.initialize', payload: { choice } };
    }

    case 'agents.stop': {
      const sessionId = payload === undefined ? null : nonEmptyString(payload['sessionId'], 128);
      return sessionId === null ? null : { type: 'agents.stop', payload: { sessionId } };
    }

    default:
      return null;
  }
}
