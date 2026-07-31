import {
  AUTONOMY_LEVELS,
  CHAT_TYPES,
  COMMIT_LANGUAGES,
  COMMIT_STYLES,
  GRAPH_REBUILD_TRIGGERS,
  WORK_MODES,
  type ChatType,
  type CommitLanguage,
  type CommitStyle,
  type GraphRebuildTrigger,
  type WorkMode,
} from '../core/types';
import type { PermissionAction } from '../permissions/types';

export const PROMETHEON_DIR = '.prometheon';
export const CONFIG_FILE_NAME = 'prometheon.yaml';

/** Pastas criadas na inicialização, na ordem em que aparecem na documentação. */
export const WORKSPACE_DIRECTORIES: readonly string[] = [
  'agents',
  'brain',
  'graph',
  'knowledge',
  'tasks/active',
  'tasks/completed',
  'sessions/summaries',
  'mcp',
  'local',
];

/** Pastas que nascem vazias e recebem `.gitkeep` para sobreviverem a um clone. */
export const DIRECTORIES_NEEDING_GITKEEP: readonly string[] = [
  'agents',
  'brain',
  'graph',
  'tasks/active',
  'tasks/completed',
  'sessions/summaries',
  'mcp',
];

/** Entradas adicionadas ao `.gitignore` do projeto, sem remover nada existente. */
export const GITIGNORE_ENTRIES: readonly string[] = [
  '.prometheon/local/',
  '.prometheon/cache/',
  '.prometheon/runtime/',
  '.prometheon/logs/',
  '.prometheon/worktrees/',
  '.prometheon/sessions/raw/',
  '.prometheon/graph/cache/',
  '.prometheon/secrets/',
  '.prometheon/*.db',
  '.prometheon/*.db-shm',
  '.prometheon/*.db-wal',
];

export const GITIGNORE_HEADER = '# Prometheon';

/** Autonomia que pode ser persistida: bypass é sempre de sessão. */
export type PersistableAutonomy = 'manual' | 'auto';

/**
 * Conteúdo de `.prometheon/prometheon.yaml`. É configuração compartilhável e
 * versionável — nunca guarda credenciais.
 */
export interface WorkspaceConfig {
  readonly version: 1;
  readonly workspace: { readonly name: string };
  readonly chat: { readonly defaultType: ChatType };
  readonly orchestration: {
    readonly workMode: WorkMode;
    readonly autonomy: PersistableAutonomy;
    readonly mainAgent: string;
    readonly maxWorkers: number;
  };
  readonly knowledge: {
    readonly graphify: GraphifyConfig;
    readonly obsidian: { readonly enabled: boolean; readonly paths: readonly string[] };
  };
  readonly git: GitConfig;
  readonly hub: { readonly enabled: boolean; readonly url?: string };
  readonly policies: {
    readonly deny: readonly PermissionAction[];
    readonly ask: readonly PermissionAction[];
  };
}

/**
 * Grafo de conhecimento do projeto.
 *
 * O comando de rebuild é um **campo**, não uma constante: cada projeto tem o
 * seu (`Scripts\Rebuild-Graphify.ps1` num, `graphify update .` noutro), e
 * chutar o errado é pior do que não chutar nada — há projeto em que o update
 * genérico do CLI corrompe o corpus curado.
 */
export interface GraphifyConfig {
  readonly enabled: boolean;
  readonly outputDir: string;
  readonly rebuildCommand: string;
  readonly rebuildOn: GraphRebuildTrigger;
  readonly gate: string;
  readonly blockOnHygieneFailure: boolean;
}

/** Política de commit do projeto, herdada por quem clona o repositório. */
export interface GitConfig {
  readonly coAuthoredBy: boolean;
  readonly commitStyle: CommitStyle;
  readonly commitLanguage: CommitLanguage;
  readonly scopes: readonly string[];
}

export const DEFAULT_GRAPH_OUTPUT_DIR = 'graphify-out';

export function defaultConfig(workspaceName: string): WorkspaceConfig {
  return {
    version: 1,
    workspace: { name: workspaceName },
    chat: { defaultType: 'local' },
    orchestration: { workMode: 'plan', autonomy: 'manual', mainAgent: 'mock', maxWorkers: 3 },
    knowledge: {
      graphify: {
        enabled: false,
        outputDir: DEFAULT_GRAPH_OUTPUT_DIR,
        rebuildCommand: '',
        rebuildOn: 'commit',
        gate: '',
        blockOnHygieneFailure: true,
      },
      obsidian: { enabled: true, paths: ['.prometheon/knowledge'] },
    },
    // Coautoria de IA nasce desligada: creditar um modelo como autor do commit
    // é uma escolha do time, e o padrão seguro é não fazer o que ninguém pediu.
    git: { coAuthoredBy: false, commitStyle: 'conventional', commitLanguage: 'en', scopes: [] },
    hub: { enabled: false },
    policies: { deny: [], ask: [] },
  };
}

/** Texto inicial do arquivo, com comentários. Updates posteriores os preservam. */
export function initialConfigText(workspaceName: string): string {
  return `# Configuração compartilhável do Prometheon.
# Este arquivo pode ser versionado. Nunca coloque chaves, tokens ou senhas aqui:
# segredos vivem apenas no cofre do VS Code (SecretStorage).
version: 1

workspace:
  name: ${JSON.stringify(workspaceName)}

chat:
  defaultType: local

orchestration:
  workMode: plan
  autonomy: manual
  mainAgent: mock
  maxWorkers: 3

knowledge:
  graphify:
    # Grafo de conhecimento do projeto. Quando ligado, os agentes sabem que ele
    # existe e o consultam antes de sair lendo arquivo por arquivo.
    enabled: false
    outputDir: ${DEFAULT_GRAPH_OUTPUT_DIR}
    # Comando que reconstrói o grafo. É por projeto: não existe um genérico que
    # sirva para todos, e o errado corrompe o corpus em silêncio.
    rebuildCommand: ""
    # manual | commit | run
    rebuildOn: commit
    gate: ""
    blockOnHygieneFailure: true
  obsidian:
    enabled: true
    paths:
      - ".prometheon/knowledge"

git:
  # Creditar uma IA como coautora do commit. Desligado por padrão.
  coAuthoredBy: false
  # conventional | free
  commitStyle: conventional
  # en | pt-br | es
  commitLanguage: en
  scopes: []

hub:
  enabled: false
`;
}

export const HOME_MARKDOWN = `# Prometheon Knowledge

Base de conhecimento deste workspace. É Markdown puro, compatível com Obsidian:
crie páginas, use links \`[[assim]]\` e versione o que a equipe deve compartilhar.

## Como isto é usado

- Os agentes leem estas páginas como contexto do projeto.
- \`.prometheon/local/\` guarda estado da sua máquina e não é versionado.
- Segredos nunca ficam aqui.
`;

const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  'file.read',
  'file.write',
  'terminal.run',
  'git.write',
  'git.init',
  'agent.delegate',
  'hub.network',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

/** Texto útil ou `undefined`: espaço em branco no YAML equivale a ausência. */
function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Escopos aceitos no título do commit, sem duplicatas nem entradas vazias. */
function pickScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const scopes: string[] = [];
  for (const entry of value) {
    const scope = trimmedString(entry);
    if (scope !== undefined && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return scopes;
}

function pickActions(value: unknown): PermissionAction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is PermissionAction =>
    PERMISSION_ACTIONS.includes(entry as PermissionAction),
  );
}

/**
 * Converte YAML arbitrário na configuração tipada, caindo nos padrões a cada
 * campo inválido. Um arquivo corrompido nunca deve impedir a extensão de abrir.
 */
export function normalizeConfig(raw: unknown, workspaceName: string): WorkspaceConfig {
  const base = defaultConfig(workspaceName);
  if (!isRecord(raw)) {
    return base;
  }

  const workspace = isRecord(raw['workspace']) ? raw['workspace'] : {};
  const chat = isRecord(raw['chat']) ? raw['chat'] : {};
  const orchestration = isRecord(raw['orchestration']) ? raw['orchestration'] : {};
  const knowledge = isRecord(raw['knowledge']) ? raw['knowledge'] : {};
  const graphify = isRecord(knowledge['graphify']) ? knowledge['graphify'] : {};
  const obsidian = isRecord(knowledge['obsidian']) ? knowledge['obsidian'] : {};
  const git = isRecord(raw['git']) ? raw['git'] : {};
  const hub = isRecord(raw['hub']) ? raw['hub'] : {};
  const policies = isRecord(raw['policies']) ? raw['policies'] : {};

  const maxWorkers = Number(orchestration['maxWorkers']);
  const paths = Array.isArray(obsidian['paths'])
    ? obsidian['paths'].filter((entry): entry is string => typeof entry === 'string')
    : base.knowledge.obsidian.paths;
  const hubUrl = typeof hub['url'] === 'string' && hub['url'].trim() !== '' ? hub['url'] : undefined;

  return {
    version: 1,
    workspace: {
      name: typeof workspace['name'] === 'string' ? workspace['name'] : workspaceName,
    },
    chat: {
      defaultType: pickString<ChatType>(chat['defaultType'], CHAT_TYPES, 'local'),
    },
    orchestration: {
      workMode: pickString<WorkMode>(orchestration['workMode'], WORK_MODES, 'plan'),
      // `bypass` no arquivo é ignorado: nunca é uma preferência persistida.
      autonomy: pickString<PersistableAutonomy>(
        orchestration['autonomy'],
        AUTONOMY_LEVELS.filter((level): level is PersistableAutonomy => level !== 'bypass'),
        'manual',
      ),
      mainAgent:
        typeof orchestration['mainAgent'] === 'string' ? orchestration['mainAgent'] : 'mock',
      maxWorkers: Number.isFinite(maxWorkers) && maxWorkers > 0 ? Math.floor(maxWorkers) : 3,
    },
    knowledge: {
      graphify: {
        enabled: graphify['enabled'] === true,
        outputDir: trimmedString(graphify['outputDir']) ?? DEFAULT_GRAPH_OUTPUT_DIR,
        rebuildCommand: trimmedString(graphify['rebuildCommand']) ?? '',
        rebuildOn: pickString<GraphRebuildTrigger>(
          graphify['rebuildOn'],
          GRAPH_REBUILD_TRIGGERS,
          'commit',
        ),
        gate: trimmedString(graphify['gate']) ?? '',
        blockOnHygieneFailure: graphify['blockOnHygieneFailure'] !== false,
      },
      obsidian: {
        enabled: obsidian['enabled'] !== false,
        paths: paths.length > 0 ? paths : base.knowledge.obsidian.paths,
      },
    },
    git: {
      coAuthoredBy: git['coAuthoredBy'] === true,
      commitStyle: pickString<CommitStyle>(git['commitStyle'], COMMIT_STYLES, 'conventional'),
      commitLanguage: pickString<CommitLanguage>(
        git['commitLanguage'],
        COMMIT_LANGUAGES,
        'en',
      ),
      scopes: pickScopes(git['scopes']),
    },
    hub: hubUrl === undefined ? { enabled: hub['enabled'] === true } : { enabled: hub['enabled'] === true, url: hubUrl },
    policies: { deny: pickActions(policies['deny']), ask: pickActions(policies['ask']) },
  };
}
