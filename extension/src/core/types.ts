/** Tipos centrais compartilhados entre extensão e webview. */

import type { ModelChoice } from '../providers/types';
import type { TokenUsage } from '../providers/UsageTracker';

export type WorkMode = 'plan' | 'edit' | 'agent-team';
export type Autonomy = 'manual' | 'auto' | 'bypass';
export type ChatType = 'local' | 'web';

export const WORK_MODES: readonly WorkMode[] = ['plan', 'edit', 'agent-team'];
export const AUTONOMY_LEVELS: readonly Autonomy[] = ['manual', 'auto', 'bypass'];
export const CHAT_TYPES: readonly ChatType[] = ['local', 'web'];

/** Rótulos da interface. A UI do produto é em inglês (ver Docs/PROMETHEON_INICIO_EXTENSAO.md). */
export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  plan: 'Plan',
  edit: 'Edit',
  'agent-team': 'Agent Team',
};

export const WORK_MODE_DESCRIPTIONS: Record<WorkMode, string> = {
  plan: 'Analysis and planning only.',
  edit: 'A single agent may edit inside the allowed scope.',
  'agent-team': 'The main agent may delegate work to workers.',
};

export const AUTONOMY_LABELS: Record<Autonomy, string> = {
  manual: 'Manual',
  auto: 'Auto',
  bypass: 'Bypass permissions',
};

export const AUTONOMY_DESCRIPTIONS: Record<Autonomy, string> = {
  manual: 'Ask for approval on relevant actions.',
  auto: 'Approve safe actions and pause on risky ones.',
  bypass: 'No interactive approval inside the authorized scope.',
};

export type BypassScope = 'agent-worktrees' | 'current-project' | 'selected-workspace';
export type BypassDuration = 'one-task' | 'current-session';

export const BYPASS_SCOPES: readonly BypassScope[] = [
  'agent-worktrees',
  'current-project',
  'selected-workspace',
];
export const BYPASS_DURATIONS: readonly BypassDuration[] = ['one-task', 'current-session'];

export const BYPASS_SCOPE_LABELS: Record<BypassScope, string> = {
  'agent-worktrees': 'Agent worktrees',
  'current-project': 'Current project',
  'selected-workspace': 'Selected workspace',
};

export const BYPASS_DURATION_LABELS: Record<BypassDuration, string> = {
  'one-task': 'One task',
  'current-session': 'Current session',
};

export const BYPASS_CONFIRMATION_MESSAGE =
  'Bypass permissions allows agents to execute actions without interactive approval inside the selected scope.';

/**
 * Autorização temporária de bypass. Vive somente em memória: reiniciar a
 * extensão ou trocar de workspace a descarta (nunca é persistida).
 */
export interface BypassGrant {
  readonly scope: BypassScope;
  readonly duration: BypassDuration;
  readonly grantedAt: number;
  /** Workspace em que o bypass foi concedido; trocar de workspace o cancela. */
  readonly workspaceKey: string | null;
}

export type ActiveAgentStatus =
  | 'idle'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AgentSummary {
  readonly id: string;
  readonly displayName: string;
  readonly transport: 'cli' | 'api' | 'mock';
  readonly available: boolean;
}

export interface ActiveAgentSummary {
  readonly sessionId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly role: 'main' | 'worker';
  readonly status: ActiveAgentStatus;
  readonly task: string | null;
}

export type HubState = 'local-only' | 'disconnected' | 'connecting' | 'connected' | 'error';

export const HUB_STATE_LABELS: Record<HubState, string> = {
  'local-only': 'Local only',
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Error',
};

export interface HubConnectionStatus {
  readonly state: HubState;
  /** Detalhe já sanitizado, seguro para exibir. */
  readonly detail?: string;
}

/**
 * Projeto do Hub como a interface o oferece. Conversa do Web Chat mora dentro
 * de um projeto, então sem escolher um não há o que listar.
 */
export interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceStatus {
  /** Existe `.prometheon/prometheon.yaml` na pasta aberta. */
  readonly configured: boolean;
  readonly folderName: string | null;
  readonly hasGit: boolean;
  /** Pasta Prometheon externa escolhida pelo usuário, quando houver. */
  readonly externalFolder: string | null;
  /** Usuário optou por seguir sem workspace compartilhado nesta sessão. */
  readonly skipped: boolean;
}

/**
 * Conta de provedor como a interface a exibe. Só metadados: nada aqui vem do
 * conteúdo do diretório de credenciais.
 */
export interface AccountSummary {
  readonly profileId: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly configDirectory: string;
  /** Modelo escolhido para esta conta; vazio deixa a decisão com o CLI. */
  readonly model: string;
  readonly cliInstalled: boolean;
  readonly cliVersion?: string;
  readonly authenticated: boolean;
  readonly accountLabel?: string;
  readonly organization?: string;
  readonly plan?: string;
  readonly authMethod?: string;
  readonly message?: string;
  /** Tokens contados pelo Prometheon nesta máquina, não pelo provedor. */
  readonly usage: {
    readonly today: { readonly input: number; readonly output: number };
    readonly last7Days: { readonly input: number; readonly output: number };
    readonly total: { readonly input: number; readonly output: number };
    readonly runs: number;
    readonly lastRunAt: number | null;
  };
}

/** Situação do ditado, para a interface saber se e como oferecer o microfone. */
export interface SpeechStatus {
  /** Há motor de voz pronto. Sem isso o botão fica desabilitado, com o motivo. */
  readonly available: boolean;
  readonly state: 'idle' | 'listening' | 'transcribing';
  /** Texto já pronto para exibir, explicando por que o ditado está indisponível. */
  readonly detail?: string;
}

/**
 * O que o agente está fazendo agora, mostrado acima do composer enquanto o run
 * acontece. `label` é curto ("Thinking…"); `detail` diz qual perfil e conta
 * estão em uso — o documento exige que isso nunca fique escondido.
 */
export interface ActivityStatus {
  readonly phase: 'idle' | 'sending' | 'thinking' | 'working' | 'waiting';
  readonly label: string;
  readonly detail?: string;
  readonly startedAt: number | null;
  /**
   * Tokens contados até agora neste run. Some quando o run acaba: o número que
   * fica é o da mensagem, reportado pelo agente no fim.
   */
  readonly usage?: TokenUsage;
}

/**
 * Quanto da janela de contexto o agente principal já está usando.
 *
 * O número é uma **estimativa medida**, não um valor que o provedor informa: o
 * que se sabe é quantos tokens de entrada a última chamada consumiu, e isso
 * inclui todo o histórico reenviado. É a melhor aproximação disponível de fora
 * do CLI, e a interface diz que é aproximação em vez de fingir precisão.
 */
export interface ContextWindowStatus {
  /** Tokens de entrada da última chamada. Zero antes da primeira resposta. */
  readonly usedTokens: number;
  /** Tamanho da janela do modelo em uso. */
  readonly windowTokens: number;
  /** Compactar sozinho ao cruzar o limite, antes da próxima mensagem. */
  readonly autoCompact: boolean;
  /** Fração da janela que dispara a compactação automática. */
  readonly threshold: number;
  /** Modelo considerado no cálculo, já pronto para exibir. */
  readonly modelLabel: string;
}

/**
 * Janela de contexto por modelo, em tokens.
 *
 * É o **plano B**. A fonte boa é o próprio CLI, que anuncia o modelo em uso no
 * início do run e marca a janela no nome (`claude-opus-5[1m]`) — daí sai o
 * número certo sem depender de tabela nenhuma. Esta aqui só cobre o instante
 * antes da primeira resposta, quando ainda não houve run para perguntar.
 *
 * Um modelo fora da lista cai no padrão: uma barra aproximada é mais útil do
 * que nenhuma, e o primeiro run corrige o valor.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
};

/** Fração da janela em que a compactação automática entra. */
export const COMPACT_THRESHOLD = 0.85;

/**
 * Janela do modelo, em tokens.
 *
 * O sufixo entre colchetes vence a tabela: é o CLI dizendo com quantos tokens
 * ele está rodando de fato. O mesmo modelo pode rodar com janelas diferentes, e
 * quem sabe qual delas está valendo é ele, não esta lista.
 */
export function contextWindowFor(model: string | undefined): number {
  if (model === undefined || model === '') {
    return DEFAULT_CONTEXT_WINDOW;
  }

  const marked = /\[(\d+)(k|m)]\s*$/i.exec(model);

  if (marked !== null) {
    const amount = Number(marked[1]);
    const scale = marked[2]?.toLowerCase() === 'm' ? 1_000_000 : 1_000;
    return amount * scale;
  }

  return CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/** Nome do modelo sem a marca de janela, para exibir. */
export function modelWithoutWindow(model: string): string {
  return model.replace(/\[\d+[km]]\s*$/i, '');
}

export interface UiNotification {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

// ---------- Agent Profiles ----------

/**
 * Papel de um agente (Docs/PROMETHEON_MULTI_PROVIDER_AGENT_PROFILES.md §6).
 * Não confundir com `ActiveAgentSummary.role`, que diz apenas quem lidera a
 * execução em andamento.
 *
 * `custom` é o guarda-chuva dos papéis nomeados pelo time: o perfil guarda
 * `role: 'custom'` mais o `customRoleId`, e o papel em si vive em
 * `.prometheon/agents/roles.yaml` ou no Hub — ver `CustomAgentRole`.
 */
export type AgentRole =
  | 'orchestrator'
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'researcher'
  | 'tester'
  | 'custom';

export const AGENT_ROLES: readonly AgentRole[] = [
  'orchestrator',
  'planner',
  'implementer',
  'reviewer',
  'researcher',
  'tester',
  'custom',
];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  orchestrator: 'Orchestrator',
  planner: 'Planner',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  tester: 'Tester',
  custom: 'Custom',
};

export const AGENT_ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  orchestrator: 'Leads the work and delegates to the other agents.',
  planner: 'Breaks the task down before anything is edited.',
  implementer: 'Writes and changes code inside the allowed scope.',
  reviewer: 'Reads the diff and reports risks.',
  researcher: 'Explores the codebase and gathers context.',
  tester: 'Runs and writes tests for the change.',
  custom: 'A role you define through the system prompt.',
};

// ---------- Papéis nomeados pelo time ----------

/**
 * Onde um papel nomeado foi definido. A ordem também é a de precedência quando
 * o mesmo id aparece em mais de um lugar: o projeto vence, porque é o que a
 * equipe versiona; o Hub vem em seguida; a máquina é o rascunho pessoal.
 */
export type AgentRoleScope = 'project' | 'hub' | 'machine';

export const AGENT_ROLE_SCOPES: readonly AgentRoleScope[] = ['project', 'hub', 'machine'];

export const AGENT_ROLE_SCOPE_LABELS: Record<AgentRoleScope, string> = {
  project: 'Project',
  hub: 'Team',
  machine: 'This machine',
};

export const AGENT_ROLE_SCOPE_DESCRIPTIONS: Record<AgentRoleScope, string> = {
  project: 'Lives in .prometheon/agents/roles.yaml and reaches the team through Git.',
  hub: 'Shared through the Hub with everyone in the organization.',
  machine: 'Yours only. Never leaves this computer.',
};

/**
 * Papel criado pelo time — "Gameplay PIE UE5 Test", por exemplo. Existe para
 * dar nome e skills a uma especialidade que os sete papéis embutidos não
 * cobrem, sem que cada agente tenha de repetir a mesma configuração.
 *
 * É configuração compartilhável: nada aqui é credencial.
 */
export interface CustomAgentRole {
  /** Slug estável. É o que `AgentProfile.customRoleId` guarda. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * Papel embutido de que este herda o ícone e a semântica de delegação. Um
   * papel de teste continua sendo um `tester` para o orquestrador.
   */
  readonly basedOn: AgentRole;
  /** Skills que um agente com este papel recebe já marcadas. */
  readonly skills: readonly string[];
  /** Instruções somadas ao system prompt do agente que usa este papel. */
  readonly systemPrompt?: string;
  readonly scope: AgentRoleScope;
}

/** O que a interface envia para criar ou editar um papel nomeado. */
export interface CustomAgentRoleDraft {
  readonly label: string;
  readonly description: string;
  readonly basedOn: AgentRole;
  readonly skills: readonly string[];
  readonly systemPrompt?: string;
  readonly scope: AgentRoleScope;
}

export const MAX_ROLE_LABEL_LENGTH = 60;
export const MAX_ROLE_DESCRIPTION_LENGTH = 240;
export const MAX_CUSTOM_ROLES = 60;
export const MAX_SKILLS_PER_ROLE = 40;

/**
 * Autonomia de um Agent Profile. É a lista do documento (§6) e não a do
 * seletor do composer: aqui `bypass` é sempre temporário, por perfil.
 */
export type AgentAutonomyMode = 'manual' | 'auto' | 'bypass-temporary';

export const AGENT_AUTONOMY_MODES: readonly AgentAutonomyMode[] = [
  'manual',
  'auto',
  'bypass-temporary',
];

export const AGENT_AUTONOMY_MODE_LABELS: Record<AgentAutonomyMode, string> = {
  manual: 'Manual',
  auto: 'Auto',
  'bypass-temporary': 'Bypass (temporary)',
};

export const AGENT_AUTONOMY_MODE_DESCRIPTIONS: Record<AgentAutonomyMode, string> = {
  manual: 'Ask for approval on relevant actions.',
  auto: 'Approve safe actions and pause on risky ones.',
  'bypass-temporary': 'No interactive approval; never persisted across restarts.',
};

export type ContextStrategy = 'isolated' | 'project' | 'team';

export const CONTEXT_STRATEGIES: readonly ContextStrategy[] = ['isolated', 'project', 'team'];

export const CONTEXT_STRATEGY_LABELS: Record<ContextStrategy, string> = {
  isolated: 'Isolated',
  project: 'Project',
  team: 'Team',
};

export const CONTEXT_STRATEGY_DESCRIPTIONS: Record<ContextStrategy, string> = {
  isolated: 'Only the task and the files handed to the agent.',
  project: 'Repository context and the Prometheon Brain.',
  team: 'Authorized Hub context and shared knowledge.',
};

/** Limites da fronteira com a webview, usados na validação e na interface. */
export const MAX_PROFILE_NAME_LENGTH = 60;
export const MAX_MODEL_LENGTH = 120;
export const MAX_SYSTEM_PROMPT_LENGTH = 8_000;
export const MAX_TOOLS_PER_LIST = 40;
export const MAX_TOOL_NAME_LENGTH = 80;
export const MAX_CONCURRENT_SESSIONS = 16;

/**
 * Agente configurado no Prometheon. É configuração compartilhável: nada aqui
 * é credencial — a conta usada vem do `providerProfileId`, que aponta para um
 * Provider Profile local.
 */
export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  /** Binding obrigatório: um agente sem conta não executa (documento §15). */
  readonly providerProfileId: string;
  readonly role: AgentRole;
  /**
   * Papel nomeado, quando `role` é `custom`. Um id que não resolve vira aviso
   * na interface — o agente não cai em outro papel sozinho, pela mesma razão
   * que não cai em outra conta.
   */
  readonly customRoleId?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly autonomyMode: AgentAutonomyMode;
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  /** Skills que este agente pode carregar, além das do papel. */
  readonly skills: readonly string[];
  readonly maxConcurrentSessions: number;
  readonly contextStrategy: ContextStrategy;
  readonly enabled: boolean;
}

/**
 * Agent Profile com o binding já resolvido para a interface mostrar
 * `Agent → Provider → Account` sem precisar cruzar listas.
 */
export interface AgentProfileSummary {
  readonly profile: AgentProfile;
  readonly providerName: string | null;
  readonly accountName: string | null;
  readonly accountAuthenticated: boolean;
  /** Papel nomeado já resolvido, quando o perfil aponta para um. */
  readonly customRole: CustomAgentRole | null;
  /** Texto pronto quando o binding quebrou ou a conta não está autenticada. */
  readonly warning?: string;
}

/**
 * Modelos conhecidos de um provedor.
 *
 * A lista é conveniência da interface, nunca um gate: o campo Model do Agent
 * Profile continua aceitando texto livre. Quem manda no que existe é o CLI do
 * provedor, e ele valida na hora de rodar.
 */
export interface ProviderModels {
  readonly providerId: string;
  readonly models: readonly ModelChoice[];
}

/** Provedor disponível para criar uma conta, como a interface o lista. */
export interface ProviderOption {
  readonly id: string;
  readonly name: string;
  /** Variável que isola a configuração, exibida ao criar a conta. */
  readonly configEnvironmentVariable: string;
}

// ---------- Skills ----------

/**
 * De onde a skill foi lida. A ordem é a de precedência: um mesmo `name` no
 * projeto vence o da máquina, que vence o dos diretórios compatíveis lidos
 * apenas para leitura (`.claude/skills/` e companhia).
 */
export type SkillScope = 'project' | 'machine' | 'compatible';

export const SKILL_SCOPES: readonly SkillScope[] = ['project', 'machine', 'compatible'];

export const SKILL_SCOPE_LABELS: Record<SkillScope, string> = {
  project: 'Project',
  machine: 'This machine',
  compatible: 'Compatible folder',
};

/**
 * Risco declarado pela skill. Vira teto de autonomia: uma skill que lida com
 * segredo nunca roda sem aprovação, por mais permissivo que o perfil seja.
 */
export type SkillRiskLevel = 'none' | 'low' | 'medium' | 'high';

export const SKILL_RISK_LEVELS: readonly SkillRiskLevel[] = ['none', 'low', 'medium', 'high'];

export const SKILL_RISK_LABELS: Record<SkillRiskLevel, string> = {
  none: 'No risk',
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
};

/**
 * Skill como o catálogo a mostra — o nível 1 do progressive disclosure: nome,
 * gatilho e metadados de governança. O corpo só é lido quando alguém pede.
 */
export interface SkillSummary {
  /** `name` do frontmatter; igual ao nome da pasta. É o identificador. */
  readonly name: string;
  /** Primeira linha `# Título` do corpo, ou o próprio nome quando não há. */
  readonly title: string;
  readonly description: string;
  /** Categoria: a pasta acima da skill, ou `metadata.prometheon.category`. */
  readonly category: string;
  readonly scope: SkillScope;
  readonly riskLevel: SkillRiskLevel;
  readonly version: string | null;
  readonly license: string | null;
  readonly author: string | null;
  /** Vazio quer dizer todas as plataformas. */
  readonly platforms: readonly string[];
  /** Nomes em `mcp_registry_entries` exigidos para a skill ser oferecida. */
  readonly requiresMcp: readonly string[];
  /** Teto de autonomia da skill; `handles_secrets` já o força a `manual`. */
  readonly autonomyCeiling: AgentAutonomyMode;
  /** Estimativa de tokens do corpo, para orçar o contexto antes de carregar. */
  readonly bodyTokensEstimate: number;
  /**
   * Arquivos de apoio, relativos à pasta da skill (`references/x.md`). São o
   * nível 3 do progressive disclosure: ficam fora do prompt até o corpo apontar
   * e o modelo pedir, mas contam para o custo de quem for carregá-los.
   */
  readonly supportFiles: readonly string[];
  /** Caminho do `SKILL.md`, para abrir no editor. */
  readonly path: string;
  /** Roda nesta plataforma. Falso mantém a skill visível, mas não oferecível. */
  readonly supported: boolean;
}

/** Skill que não pôde ser lida. Reportada, nunca corrigida sozinha. */
export interface SkillProblem {
  /** Caminho relativo do que falhou, para quem for corrigir saber onde olhar. */
  readonly path: string;
  readonly detail: string;
}

export interface SkillCatalogStatus {
  readonly skills: readonly SkillSummary[];
  readonly problems: readonly SkillProblem[];
  /** Raízes varridas, na ordem de precedência, para a interface explicar-se. */
  readonly roots: readonly string[];
}

export const EMPTY_SKILL_CATALOG: SkillCatalogStatus = { skills: [], problems: [], roots: [] };

/**
 * Skills que cada papel embutido recebe marcadas ao criar um agente.
 *
 * Não é gate: é o ponto de partida que evita começar do zero toda vez. O nome
 * é o da skill, e uma que não exista no catálogo simplesmente não aparece —
 * a lista é sugestão, não promessa de instalação.
 */
export const DEFAULT_ROLE_SKILLS: Record<AgentRole, readonly string[]> = {
  orchestrator: ['subagent-driven-development', 'plan', 'bug-triage'],
  planner: ['plan', 'spike', 'code-wiki'],
  implementer: ['test-driven-development', 'systematic-debugging', 'github-pr-workflow'],
  reviewer: ['requesting-code-review', 'simplify-code', 'github-code-review'],
  researcher: ['code-wiki', 'codebase-inspection', 'llm-wiki'],
  tester: ['test-driven-development', 'systematic-debugging', 'dogfood'],
  custom: [],
};

// ---------- MCP ----------

export const MAX_MCP_NAME_LENGTH = 60;
export const MAX_MCP_COMMAND_LENGTH = 260;
export const MAX_MCP_ARGS = 32;
export const MAX_MCP_ARG_LENGTH = 400;
export const MAX_MCP_URL_LENGTH = 400;
export const MAX_MCP_ENTRIES = 24;
export const MAX_MCP_KEY_LENGTH = 80;
export const MAX_MCP_VALUE_LENGTH = 400;
export const MAX_MCP_SERVERS = 40;

/**
 * Transporte de um servidor MCP. `type` ausente no arquivo significa `stdio`,
 * que é o padrão do formato.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'stdio (local process)',
  http: 'http',
  sse: 'sse',
};

export const MCP_TRANSPORT_DESCRIPTIONS: Record<McpTransport, string> = {
  stdio: 'Prometheon starts a local command and talks to it over stdio.',
  http: 'Connects to an MCP server over HTTP.',
  sse: 'Connects to an MCP server over server-sent events.',
};

/** Par chave/valor de `env` ou `headers`, na ordem em que aparece no arquivo. */
export interface McpKeyValue {
  readonly key: string;
  readonly value: string;
}

/**
 * Servidor MCP como a interface o edita. É a leitura do `.mcp.json` do
 * workspace, que pertence ao projeto e é lido também por outras ferramentas —
 * por isso os campos que não conhecemos são preservados na regravação e apenas
 * contados aqui.
 */
export interface McpServerSummary {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: readonly McpKeyValue[];
  readonly url?: string;
  readonly headers: readonly McpKeyValue[];
  /** `disabled: true` no arquivo desliga o servidor sem apagar a configuração. */
  readonly enabled: boolean;
  /** Quantidade de campos desconhecidos preservados nesta entrada. */
  readonly preservedFields: readonly string[];
  /** Avisos prontos para exibir: valor com cara de credencial em texto puro. */
  readonly warnings: readonly string[];
}

/** O que a interface envia para criar ou editar um servidor MCP. */
export interface McpServerDraft {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: readonly McpKeyValue[];
  readonly url?: string;
  readonly headers: readonly McpKeyValue[];
  readonly enabled: boolean;
}

/** Entrada que não pôde ser interpretada. Reportada, nunca corrigida sozinha. */
export interface McpProblem {
  readonly name: string;
  readonly detail: string;
}

export interface McpStatus {
  /** Há uma pasta aberta; sem isso não existe `.mcp.json` de projeto. */
  readonly available: boolean;
  /** O arquivo já existe em disco. */
  readonly exists: boolean;
  /** Caminho do arquivo, para a interface mostrar onde isso mora. */
  readonly file: string | null;
  readonly servers: readonly McpServerSummary[];
  readonly problems: readonly McpProblem[];
  /** Motivo já pronto para exibir quando `available` é falso. */
  readonly message?: string;
}

/**
 * Quando o grafo de conhecimento do projeto é reconstruído.
 *
 * `commit` é o padrão recomendado. O gatilho alternativo — "ao fim do run do
 * agente" — depende de o agente declarar que terminou, e o agente que escreveu
 * o código é o pior juiz de se ele funciona. O commit é a única declaração
 * verificável de "isto está bom", e mantém grafo e código no mesmo commit em
 * vez de N rebuilds dessincronizados para um commit só.
 */
export const GRAPH_REBUILD_TRIGGERS = ['manual', 'commit', 'run'] as const;
export type GraphRebuildTrigger = (typeof GRAPH_REBUILD_TRIGGERS)[number];

/** Grafo de conhecimento do projeto, do jeito que o painel precisa exibi-lo. */
export interface GraphStatus {
  /** Há uma pasta aberta; sem isso não existe grafo de projeto. */
  readonly available: boolean;
  /** Os agentes podem consultar o grafo e sabem que ele existe. */
  readonly enabled: boolean;
  /** Pasta do grafo, relativa à raiz do projeto. */
  readonly outputDir: string;
  /** A pasta do grafo existe em disco. */
  readonly exists: boolean;
  /** Idade do grafo em milissegundos; `null` quando ele ainda não existe. */
  readonly ageMs: number | null;
  /** Comando que reconstrói o grafo. Vazio significa "ainda não configurado". */
  readonly rebuildCommand: string;
  readonly rebuildOn: GraphRebuildTrigger;
  /** Comando cujo código de saída 0 libera o rebuild. Vazio desliga o portão. */
  readonly gate: string;
  readonly blockOnHygieneFailure: boolean;
  /** O CLI `graphify` respondeu no PATH desta máquina. */
  readonly cliDetected: boolean;
  /** Motivo já pronto para exibir quando `available` é falso. */
  readonly message?: string;
}

/** Formato exigido da mensagem de commit. */
export const COMMIT_STYLES = ['conventional', 'free'] as const;
export type CommitStyle = (typeof COMMIT_STYLES)[number];

/** Idioma das mensagens de commit. Independe do idioma do painel. */
export const COMMIT_LANGUAGES = ['en', 'pt-br', 'es'] as const;
export type CommitLanguage = (typeof COMMIT_LANGUAGES)[number];

/** Política de commit do projeto e o estado dos hooks que a garantem. */
export interface GitStatus {
  /** A pasta aberta é um repositório Git. */
  readonly available: boolean;
  /** Permitir que uma IA seja creditada como coautora. Desligado por padrão. */
  readonly coAuthoredBy: boolean;
  readonly commitStyle: CommitStyle;
  readonly commitLanguage: CommitLanguage;
  /** Escopos aceitos no título quando o formato é Conventional Commits. */
  readonly scopes: readonly string[];
  /** `core.hooksPath` aponta para os hooks que o Prometheon escreveu. */
  readonly hooksInstalled: boolean;
  /** Valor atual de `core.hooksPath`, quando aponta para outro lugar. */
  readonly hooksPath: string | null;
  /** Motivo já pronto para exibir quando `available` é falso. */
  readonly message?: string;
}
