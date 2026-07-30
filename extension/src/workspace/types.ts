import {
  AUTONOMY_LEVELS,
  CHAT_TYPES,
  WORK_MODES,
  type ChatType,
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
    readonly graphify: { readonly enabled: boolean };
    readonly obsidian: { readonly enabled: boolean; readonly paths: readonly string[] };
  };
  readonly hub: { readonly enabled: boolean; readonly url?: string };
  readonly policies: {
    readonly deny: readonly PermissionAction[];
    readonly ask: readonly PermissionAction[];
  };
}

export function defaultConfig(workspaceName: string): WorkspaceConfig {
  return {
    version: 1,
    workspace: { name: workspaceName },
    chat: { defaultType: 'local' },
    orchestration: { workMode: 'plan', autonomy: 'manual', mainAgent: 'mock', maxWorkers: 3 },
    knowledge: {
      graphify: { enabled: false },
      obsidian: { enabled: true, paths: ['.prometheon/knowledge'] },
    },
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
    enabled: false
  obsidian:
    enabled: true
    paths:
      - ".prometheon/knowledge"

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
      graphify: { enabled: graphify['enabled'] === true },
      obsidian: {
        enabled: obsidian['enabled'] !== false,
        paths: paths.length > 0 ? paths : base.knowledge.obsidian.paths,
      },
    },
    hub: hubUrl === undefined ? { enabled: hub['enabled'] === true } : { enabled: hub['enabled'] === true, url: hubUrl },
    policies: { deny: pickActions(policies['deny']), ask: pickActions(policies['ask']) },
  };
}
