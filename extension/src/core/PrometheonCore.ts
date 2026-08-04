import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AgentProfileService } from '../agents/AgentProfileService';
import type { AgentRegistry } from '../agents/AgentRegistry';
import { DelegationServer } from '../agents/DelegationServer';
import { ConcurrencyGuard } from '../agents/ConcurrencyGuard';
import type { DelegationMode } from '../agents/DelegationServer';
import type { Worktree, WorktreeService } from '../workspace/WorktreeService';
import { describeAgentFailure } from '../agents/failures';
import { DEFAULT_MAIN_AGENT_ID } from '../agents/builtinAgents';
import type { StartAgentInput } from '../agents/AgentAdapter';
import type { AgentRoleService } from '../agents/AgentRoleService';
import { buildSkillIndex, effectiveAutonomy, selectSkills } from '../skills/SkillIndexBuilder';
import type { SkillRegistry } from '../skills/SkillRegistry';
import {
  answerValues,
  type AgentQuestionAnswer,
  type AgentQuestionRequest,
} from '../agents/questions';
import type { LocalChatService } from '../chat/LocalChatService';
import type { ToolOutputStore } from '../chat/ToolOutputStore';
import type { WebChatService } from '../chat/WebChatService';
import { UNTITLED } from '../chat/LocalChatService';
import {
  IMAGE_MIME_TYPES,
  type AgentStep,
  type ChatMessage,
  type ConversationSummary,
  type ImageAttachment,
  type ImageMimeType,
} from '../chat/types';
import type { HubClient } from '../hub/types';
import type { Logger } from '../logger';
import type { PermissionService } from '../permissions/PermissionService';
import type { SpeechService } from '../speech/SpeechService';
import type { ModelCatalog } from '../providers/ModelCatalog';
import type { ProviderProfileService } from '../providers/ProviderProfileService';
import type { UsageTracker } from '../providers/UsageTracker';
import type { LocalStateStore } from '../storage/LocalStateStore';
import type { SettingsStore } from '../storage/SettingsStore';
import type { McpConfigStore } from '../workspace/McpConfigStore';
import type { GraphService } from '../workspace/GraphService';
import { HookConflictError, type GitPolicyService } from '../workspace/GitPolicyService';
import {
  DEFAULT_GRAPH_OUTPUT_DIR,
  defaultConfig,
  type GitConfig,
  type GraphifyConfig,
  type WorkspaceConfig,
} from '../workspace/types';
import type { WorkspaceInitializer } from '../workspace/WorkspaceInitializer';
import type { WorkspaceService } from '../workspace/WorkspaceService';
import { applyLanguage, isLanguageChoice, languageChoice, t, type LanguageChoice } from '../i18n';
import { HubNotConfiguredError, serializeError } from '../utils/errors';
import { newId } from '../utils/ids';
import { parseHubUrl, resolveHubUrl } from '../hub/HubClient';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  type AgentProfileDraft,
  type CustomRoleDraft,
  type DraftAttachment,
  type GitPatch,
  type GraphPatch,
  type WebviewToExtensionMessage,
  type WorkspacePatch,
  type WorkspaceSetupChoice,
} from '../views/messages';
import type { EventBus } from './EventBus';
import type { PrometheonViewState } from './state';
import { CLAUDE_MODELS } from '../providers/types';
import {
  AUTONOMY_DESCRIPTIONS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  COMPACT_THRESHOLD,
  contextWindowFor,
  modelWithoutWindow,
  BYPASS_CONFIRMATION_MESSAGE,
  BYPASS_DURATIONS,
  BYPASS_DURATION_LABELS,
  BYPASS_SCOPES,
  BYPASS_SCOPE_LABELS,
  EMPTY_SKILL_CATALOG,
  HUB_STATE_LABELS,
  WORK_MODES,
  WORK_MODE_DESCRIPTIONS,
  AGENT_ROLE_DESCRIPTIONS,
  AGENT_ROLE_LABELS,
  WORK_MODE_LABELS,
  type ActiveAgentStatus,
  type ActiveAgentSummary,
  type AgentSummary,
  type Autonomy,
  type BypassDuration,
  type BypassGrant,
  type BypassScope,
  type ChatType,
  type AccountSummary,
  type ActivityStatus,
  type ContextWindowStatus,
  type EffortLevel,
  type AgentProfileSummary,
  type CustomAgentRole,
  type GitStatus,
  type GraphStatus,
  type HubConnectionStatus,
  type McpServerDraft,
  type McpProbeStatus,
  type McpServerSummary,
  type McpStatus,
  type SkillCatalogStatus,
  type ProjectOption,
  type ProviderModels,
  type ProviderOption,
  type SpeechStatus,
  type WorkMode,
  type WorkspaceStatus,
} from './types';

/** Motivo mostrado na interface enquanto nenhum motor de voz está registrado. */
const NO_SPEECH_ENGINE = 'No speech engine configured yet.';

const IDLE_ACTIVITY: ActivityStatus = { phase: 'idle', label: '', startedAt: null };

/** Teto da lista de arquivos oferecida ao citar contexto. */
const MAX_CONTEXT_FILE_CHOICES = 4_000;

/**
 * Pedido de compactação.
 *
 * É o comando do próprio CLI, e não uma instrução em prosa: o Claude Code sabe
 * resumir a própria conversa e continuar dela, o que uma frase pedindo "resuma"
 * não faria — ela viraria só mais uma mensagem dentro do contexto cheio.
 */
const COMPACT_PROMPT = '/compact';

/** Nome legível do modelo. Um identificador fora da tabela aparece como veio. */
function modelLabel(model: string): string {
  if (model === '') {
    return 'Account default';
  }
  // A marca de janela sai do rótulo: ela já é o número exibido ao lado.
  const clean = modelWithoutWindow(model);
  return CLAUDE_MODELS.find((choice) => choice.id === clean)?.label ?? clean;
}

export interface PrometheonCoreDeps {
  readonly extensionVersion: string;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly registry: AgentRegistry;
  readonly localChat: LocalChatService;
  readonly webChat: WebChatService;
  readonly hub: HubClient;
  readonly permissions: PermissionService;
  readonly speech: SpeechService;
  readonly profiles: ProviderProfileService;
  readonly agentProfiles: AgentProfileService;
  readonly agentRoles: AgentRoleService;
  readonly skills: SkillRegistry;
  readonly modelCatalog: ModelCatalog;
  readonly mcp: McpConfigStore;
  readonly graph: GraphService;
  readonly gitPolicy: GitPolicyService;
  readonly toolOutputs: ToolOutputStore;
  readonly usage: UsageTracker;
  readonly local: LocalStateStore;
  readonly settings: SettingsStore;
  readonly workspace: WorkspaceService;
  readonly initializer: WorkspaceInitializer;
  /** Cópias isoladas do repositório, uma por agente que edita arquivos. */
  readonly worktrees: WorktreeService;
}

/**
 * Núcleo do Prometheon: guarda o estado da sessão, valida intenções vindas da
 * webview ou dos comandos e encaminha para o serviço adequado. É o único lugar
 * que decide o que acontece.
 */
export class PrometheonCore implements vscode.Disposable {
  private chatType: ChatType = 'local';
  private workMode: WorkMode = 'plan';
  private autonomy: Autonomy = 'manual';
  /** Somente em memória: bypass nunca é persistido. */
  private bypass: BypassGrant | null = null;
  private mainAgentId = 'mock';
  private agents: readonly AgentSummary[] = [];
  private activeAgents: ActiveAgentSummary[] = [];
  /** Delegações já feitas no pedido em curso; zera a cada mensagem do usuário. */
  private delegationsThisRun = 0;
  /** Mensagens escritas enquanto o agente trabalhava, na ordem em que chegaram. */
  private queued: QueuedMessage[] = [];
  /** Vagas de execução dos workers; a reserva é feita antes de qualquer espera. */
  private readonly concurrency = new ConcurrencyGuard();
  /** Delegações longas, por bilhete, esperando coleta. */
  private readonly delegations = new Map<string, PendingDelegation>();
  /** Relatórios que chegaram tarde e ainda não foram levados ao orquestrador. */
  private readonly finishedReports: string[] = [];
  private conversationId: string | null = null;
  private conversationTitle: string = UNTITLED;
  private messages: readonly ChatMessage[] = [];
  private sessions: readonly ConversationSummary[] = [];
  private busy = false;
  private currentRunId: string | null = null;
  /** Pergunta aberta do agente; some quando é respondida ou o run acaba. */
  private pendingQuestion: AgentQuestionRequest | null = null;
  private hubStatus: HubConnectionStatus = { state: 'local-only' };
  /**
   * Esforço escolhido no composer. `null` significa "o do agente" — o padrão
   * do perfil continua valendo até alguém decidir outra coisa nesta sessão.
   */
  private sessionEffort: EffortLevel | null = null;
  /** Vigia do login de conta em andamento; o mais recente é o único que vale. */
  private loginWatch: {
    profileId: string;
    timer: ReturnType<typeof setTimeout> | null;
    deadline: number;
  } | null = null;
  /** Última sonda dos servidores MCP; vazio até alguém pedir o teste. */
  private mcpProbes: Readonly<Record<string, McpProbeStatus>> = {};
  /** Servidor da ferramenta de delegação; nasce na primeira execução em equipe. */
  private delegationServer: DelegationServer | null = null;
  /** Projetos do Hub; só existem depois de uma conexão autenticada. */
  private webProjects: readonly ProjectOption[] = [];
  private speechStatus: SpeechStatus = {
    available: false,
    state: 'idle',
    detail: NO_SPEECH_ENGINE,
  };
  private accounts: readonly AccountSummary[] = [];
  private agentProfiles: readonly AgentProfileSummary[] = [];
  private customRoles: readonly CustomAgentRole[] = [];
  private skillCatalog: SkillCatalogStatus = EMPTY_SKILL_CATALOG;
  private models: readonly ProviderModels[] = [];
  private mcpStatus: McpStatus = {
    available: false,
    exists: false,
    file: null,
    servers: [],
    problems: [],
    message: 'MCP servers are configured in .mcp.json at the root of the open folder.',
  };
  /**
   * Configuração de grafo e de commit vinda do `prometheon.yaml`.
   *
   * Fica em memória porque o painel edita um campo por vez: o patch que sobe
   * traz só o que mudou, e o resto precisa continuar valendo para gerar os
   * hooks e disparar o rebuild.
   */
  private graphConfig: GraphifyConfig = defaultConfig('').knowledge.graphify;
  private gitConfig: GitConfig = defaultConfig('').git;
  private graphStatus: GraphStatus = {
    available: false,
    enabled: false,
    outputDir: DEFAULT_GRAPH_OUTPUT_DIR,
    exists: false,
    ageMs: null,
    rebuildCommand: '',
    rebuildOn: 'commit',
    gate: '',
    blockOnHygieneFailure: true,
    cliDetected: false,
    message: 'The project graph lives inside the open folder. Open a folder to configure it.',
  };
  private gitStatus: GitStatus = {
    available: false,
    coAuthoredBy: false,
    commitStyle: 'conventional',
    commitLanguage: 'en',
    scopes: [],
    hooksInstalled: false,
    hooksPath: null,
    message: 'Commit policy belongs to a project. Open a folder to configure it.',
  };
  private activity: ActivityStatus = IDLE_ACTIVITY;
  /** Entrada do turno mais pesado já visto nesta conversa. */
  private contextTokens = 0;
  /** Modelo que o CLI reportou no último run; vazio antes da primeira resposta. */
  private reportedModel = '';
  /** Compactar sozinho ao cruzar o limite da janela. */
  private autoCompact = true;
  /** Compactação em curso; impede que ela dispare a si mesma. */
  private compacting = false;
  private workspaceStatus: WorkspaceStatus = {
    configured: false,
    folderName: null,
    hasGit: false,
    externalFolder: null,
    skipped: false,
  };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: PrometheonCoreDeps) {
    this.disposables.push(
      deps.workspace.onDidChange(() => {
        void this.onWorkspaceChanged();
      }),
      // Salvar um `SKILL.md` ou o `roles.yaml` tem efeito na hora: sem isto, a
      // skill recém-escrita só apareceria depois de reiniciar a extensão.
      deps.workspace.onDidChangeContent(() => {
        void this.onProjectContentChanged();
      }),
      // O idioma também pode ser trocado pelas configurações do VS Code; o
      // painel precisa acompanhar de qualquer um dos dois lugares.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('prometheon.language')) {
          void this.refreshLanguage();
        }
      }),
    );
  }

  /**
   * Carrega preferências e prepara a conversa local.
   *
   * Precedência das preferências de orquestração: `.prometheon/prometheon.yaml`
   * (config do projeto, pode refletir política do time) > estado local do
   * usuário > padrão. Bypass nunca vem de nenhuma das duas fontes.
   */
  async initialize(): Promise<void> {
    this.agents = await this.deps.registry.summaries();

    const config = await this.deps.workspace.readConfig();
    const localMain = this.deps.local.getMainAgentId(this.deps.registry.main.id);

    this.autoCompact = this.deps.local.getAutoCompact();
    this.chatType = config?.chat.defaultType ?? this.deps.local.getChatType();
    this.workMode = config?.orchestration.workMode ?? this.deps.local.getWorkMode();
    this.autonomy = config?.orchestration.autonomy ?? this.deps.local.getAutonomy();
    this.mainAgentId = this.resolveAgentId(config?.orchestration.mainAgent ?? localMain);
    this.deps.registry.setMain(this.mainAgentId);

    this.deps.permissions.update({
      workMode: this.workMode,
      autonomy: this.autonomy,
      bypass: null,
      ...(config === null ? {} : { projectPolicy: config.policies }),
    });

    this.hubStatus = this.deps.hub.getStatus();
    // O projeto guardado vale antes de qualquer conexão: sem ele, trocar para o
    // Web Chat mostraria a lista vazia até alguém escolher de novo.
    this.deps.webChat.setProject(this.deps.local.getWebProjectId());
    await this.refreshWebProjects();
    await this.refreshSpeechStatus();
    // Papéis e skills antes das contas: `refreshAccounts` resolve os agentes, e
    // resolver contra uma lista de papéis ainda vazia marcaria como quebrado
    // todo agente que aponta para um papel nomeado.
    await this.refreshModels();
    await this.refreshSkills();
    await this.refreshCustomRoles();
    await this.refreshAccounts();
    // Os perfis só existem depois de `refreshAccounts`; um principal que é
    // perfil ("Claudio Main" no yaml) precisa ser revalidado agora, senão a
    // resolução da linha de cima já o teria trocado pelo adaptador padrão.
    this.mainAgentId = this.resolveAgentId(config?.orchestration.mainAgent ?? localMain);
    this.deps.registry.setMain(this.executionAgentId());
    await this.refreshMcp();
    await this.refreshProjectPolicies(config);
    this.workspaceStatus = await this.deps.workspace.status();
    await this.ensureConversation();
    await this.publish();
  }

  get snapshot(): PrometheonViewState {
    const effort = this.effortForRun();
    return {
      extensionVersion: this.deps.extensionVersion,
      language: languageChoice(),
      chatType: this.chatType,
      workMode: this.workMode,
      autonomy: this.autonomy,
      // O efetivo, não o escolhido: a interface mostra o que vai valer no
      // próximo run, venha do composer ou do padrão do agente.
      ...(effort === undefined ? {} : { effort }),
      bypass: this.bypass,
      mainAgentId: this.mainAgentId,
      agents: this.agents,
      activeAgents: this.activeAgents,
      hub: this.hubStatus,
      webProjects: this.webProjects,
      webProjectId: this.deps.webChat.selectedProject,
      speech: this.speechStatus,
      accounts: this.accounts,
      providers: this.providerOptions,
      models: this.models,
      agentProfiles: this.agentProfiles,
      customRoles: this.customRoles,
      skills: this.skillCatalog,
      mcp:
        Object.keys(this.mcpProbes).length === 0
          ? this.mcpStatus
          : { ...this.mcpStatus, probes: this.mcpProbes },
      graph: this.graphStatus,
      git: this.gitStatus,
      activity: this.activity,
      context: this.contextStatus,
      workspace: this.workspaceStatus,
      conversationId: this.conversationId,
      conversationTitle: this.conversationTitle,
      messages: this.messages,
      sessions: this.sessions,
      busy: this.busy,
      queued: this.queued.map((item) => item.content),
      pendingQuestion: this.pendingQuestion,
    };
  }

  get isBypassActive(): boolean {
    return this.bypass !== null;
  }

  /**
   * Ocupação da janela de contexto, como a interface a desenha.
   *
   * A janela é a do modelo escolhido na conta em uso. Sem conta ou sem modelo
   * explícito, cai no padrão: um indicador aproximado é mais útil do que nenhum.
   */
  private get contextStatus(): ContextWindowStatus {
    const model = this.activeModel();

    return {
      usedTokens: this.contextTokens,
      windowTokens: contextWindowFor(model),
      autoCompact: this.autoCompact,
      threshold: COMPACT_THRESHOLD,
      modelLabel: modelLabel(model),
    };
  }

  /**
   * Modelo considerado no cálculo do contexto.
   *
   * O reportado pelo CLI vence o escolhido na conta: "padrão da conta" não diz
   * qual modelo é, e mesmo um modelo escolhido pode rodar com uma janela
   * diferente da que a tabela supõe.
   */
  private activeModel(): string {
    if (this.reportedModel !== '') {
      return this.reportedModel;
    }
    return this.accounts.find((item) => item.profileId === this.usageProfileId())?.model ?? '';
  }

  /** Provedores com adaptador registrado, como a interface os oferece. */
  private get providerOptions(): readonly ProviderOption[] {
    return this.deps.profiles.providers.map((adapter) => ({
      id: adapter.providerId,
      name: adapter.displayName,
      configEnvironmentVariable: adapter.configEnvironmentVariable,
    }));
  }

  async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ui.ready':
        await this.refreshWorkspaceStatus();
        await this.publish();
        return;
      case 'chat.send':
        await this.send(message.payload.content, message.payload.attachments);
        return;
      case 'chat.sendQueued':
        await this.sendQueuedNow();
        return;
      case 'chat.dropQueued':
        await this.dropQueued(message.payload.index);
        return;
      case 'chat.cancel':
        await this.cancel(message.payload.runId);
        return;
      case 'chat.newLocal':
        await this.newLocalChat();
        return;
      case 'chat.clearLocal':
        await this.clearLocalChat();
        return;
      case 'chat.openSession':
        await this.openSession(message.payload.conversationId);
        return;
      case 'chat.deleteSession':
        await this.deleteSession(message.payload.conversationId);
        return;
      case 'chat.renameSession':
        await this.renameSession(message.payload.conversationId, message.payload.title);
        return;
      case 'chat.attachImages':
        await this.attachImages();
        return;
      case 'chat.openStepOutput':
        await this.openStepOutput(message.payload.stepId, message.payload.label);
        return;
      case 'context.addFile':
        await this.addFileToComposer();
        return;
      case 'context.compact':
        await this.compactConversation();
        return;
      case 'context.setAutoCompact':
        await this.setAutoCompact(message.payload.enabled);
        return;
      case 'settings.setModel':
        await this.setModel(message.payload.model);
        return;
      case 'question.answer':
        await this.answerQuestion(message.payload.requestId, message.payload.answers);
        return;
      case 'question.cancel':
        await this.cancelQuestion(message.payload.requestId);
        return;
      case 'speech.start':
        await this.startDictation();
        return;
      case 'speech.stop':
        await this.stopDictation();
        return;
      case 'speech.cancel':
        await this.cancelDictation();
        return;
      case 'accounts.refresh':
        await this.refreshAccounts();
        await this.publish();
        return;
      case 'accounts.create':
        await this.createAccount(message.payload.name, message.payload.providerId);
        return;
      case 'agentProfiles.create':
        await this.createAgentProfile(message.payload.profile);
        return;
      case 'agentProfiles.update':
        await this.updateAgentProfile(message.payload.id, message.payload.profile);
        return;
      case 'agentProfiles.openPrompt':
        await this.openAgentPrompt(message.payload.id);
        return;
      case 'agentProfiles.remove':
        await this.removeAgentProfile(message.payload.id);
        return;
      case 'agentProfiles.setEnabled':
        await this.setAgentProfileEnabled(message.payload.id, message.payload.enabled);
        return;
      case 'agentRoles.create':
        await this.createCustomRole(message.payload.role);
        return;
      case 'agentRoles.update':
        await this.updateCustomRole(message.payload.id, message.payload.role);
        return;
      case 'agentRoles.remove':
        await this.removeCustomRole(message.payload.id);
        return;
      case 'agentRoles.openPrompt':
        await this.openRolePrompt(message.payload.id);
        return;
      case 'skills.refresh':
        await this.refreshSkills();
        await this.publish();
        return;
      case 'skills.open':
        await this.openSkill(message.payload.name);
        return;
      case 'skills.create':
        await this.createSkill(message.payload.name, message.payload.scope);
        return;
      case 'mcp.refresh':
        await this.refreshMcp();
        await this.publish();
        return;
      case 'mcp.import':
        await this.importMcpServers();
        return;
      case 'mcp.probe':
        await this.probeMcpServers();
        return;
      case 'mcp.save':
        await this.saveMcpServer(message.payload.server);
        return;
      case 'mcp.remove':
        await this.removeMcpServer(message.payload.name);
        return;
      case 'mcp.setEnabled':
        await this.setMcpServerEnabled(message.payload.name, message.payload.enabled);
        return;
      case 'accounts.rename':
        await this.renameAccount(message.payload.profileId, message.payload.name);
        return;
      case 'accounts.login':
        await this.loginAccount(message.payload.profileId);
        return;
      case 'accounts.logout':
        await this.logoutAccount(message.payload.profileId);
        return;
      case 'accounts.remove':
        await this.removeAccount(message.payload.profileId);
        return;
      case 'chat.selectType':
        await this.setChatType(message.payload.chatType);
        return;
      case 'chat.selectProject':
        await this.setWebProject(message.payload.projectId);
        return;
      case 'settings.setWorkMode':
        await this.setWorkMode(message.payload.mode);
        return;
      case 'settings.setAutonomy':
        await this.setAutonomy(message.payload.autonomy);
        return;
      case 'settings.setEffort':
        await this.setEffort(message.payload.effort);
        return;
      case 'settings.selectMainAgent':
        await this.setMainAgent(message.payload.agentId);
        return;
      case 'settings.setLanguage':
        await this.setLanguage(message.payload.language);
        return;
      case 'settings.openEditor':
        await this.openSettingsEditor();
        return;
      case 'workspace.initialize':
        await this.configureWorkspace(message.payload.choice);
        return;
      case 'agents.stop':
        await this.stopAgent(message.payload.sessionId);
        return;
      case 'graph.update':
        await this.updateGraph(message.payload.patch);
        return;
      case 'workspace.update':
        await this.updateWorkspaceConfig(message.payload.patch);
        return;
      case 'graph.rebuild':
        await this.rebuildGraph();
        return;
      case 'graph.createScript':
        await this.createGraphScript();
        return;
      case 'git.update':
        await this.updateGitPolicy(message.payload.patch);
        return;
      case 'git.installHooks':
        await this.installGitHooks();
        return;
      case 'git.uninstallHooks':
        await this.uninstallGitHooks();
        return;
      case 'hub.connect.request':
        await this.connectHub();
        return;
      case 'hub.signOut':
        await this.signOutHub();
        return;
    }
  }

  // ---------- Chat ----------

  async send(
    content: string,
    drafts: readonly DraftAttachment[] = [],
    author: 'user' | 'system' = 'user',
  ): Promise<void> {
    if (this.busy) {
      // Enfileira em vez de descartar. Quem escreve enquanto o agente trabalha
      // está complementando o pedido — lembrou de um detalhe, viu um erro
      // passar. Engolir a mensagem faz a pessoa reescrevê-la sem saber por quê.
      this.queued.push({ content, drafts, author });
      await this.publish();
      return;
    }
    // Quem executa muda com o tipo de chat: no Local é o CLI desta máquina, no
    // Web é o Hub. O resto do laço é o mesmo — os dois falam o mesmo contrato
    // de evento, que é justamente o motivo de ele existir.
    const chat = this.chatType === 'web' ? this.deps.webChat : this.deps.localChat;

    if (this.chatType === 'web' && !this.deps.hub.isAuthenticated()) {
      this.deps.bus.emit('chat.error', serializeError(new HubNotConfiguredError()));
      return;
    }

    const attachments = drafts.map<ImageAttachment>((draft) => ({ id: newId('att'), ...draft }));
    const conversationId = await this.ensureConversation();
    this.busy = true;
    this.setActivity('sending', 'Sending…');
    await this.publish();

    try {
      const systemPrompt = this.systemPromptForMainAgent();
      const model = this.mainAgentProfile?.profile.model;
      const effort = this.effortForRun();
      // O orçamento vale por pedido do usuário. Uma retomada automática é
      // continuação do mesmo pedido: zerar ali daria crédito infinito a quem
      // delega, retoma e delega de novo.
      if (author === 'user') {
        this.delegationsThisRun = 0;
      }
      // A ferramenta de delegar só existe no modo de equipe e quando há a quem
      // delegar — oferecê-la sem isso seria prometer o que não se cumpre.
      const delegation =
        this.chatType === 'local' &&
        this.workMode === 'agent-team' &&
        this.delegatableAgents().length > 0
          ? await this.delegationEndpoint()
          : undefined;
      // Sem esta linha, a orquestração falha muda: o agente responde sozinho e
      // nada diz que a ferramenta não chegou até ele.
      this.deps.logger.info(
        delegation === undefined
          ? `Delegação desligada (chat=${this.chatType}, modo=${this.workMode}, delegáveis=${String(this.delegatableAgents().length)}).`
          : `Delegação ligada: ${String(this.delegatableAgents().length)} agente(s) disponíveis em ${delegation.url}.`,
      );
      for await (const event of chat.sendMessage({
        conversationId,
        content,
        ...(attachments.length === 0 ? {} : { attachments }),
        workMode: this.workMode,
        // A mais restritiva entre o composer, o perfil e o teto das skills
        // carregadas — uma skill que lida com segredo prende o run em manual.
        autonomy: this.effectiveAutonomyForRun(),
        // O executor é sempre um adaptador; quando o principal é um perfil, o
        // adaptador sai do provedor da conta vinculada.
        mainAgentId: this.executionAgentId(),
        // A raiz aberta no editor é a casa do agente. Omiti-la fazia o CLI
        // rodar no diretório do processo da extensão.
        ...(this.deps.workspace.folder === undefined
          ? {}
          : { workspaceFolder: this.deps.workspace.folder.uri.fsPath }),
        // O nome que a mensagem exibe é o do agente do Prometheon.
        ...(this.mainAgentProfile === undefined
          ? {}
          : { agentLabel: this.mainAgentProfile.profile.name }),
        ...(model === undefined || model === '' ? {} : { model }),
        ...(systemPrompt === '' ? {} : { systemPrompt }),
        ...(effort === undefined ? {} : { effort }),
        ...(delegation === undefined ? {} : { delegation }),
        ...(author === 'user' ? {} : { author }),
      })) {
        if (event.type === 'agent.status') {
          this.upsertActiveAgent(event.agent);
          this.trackActivity(event.agent.status);
          this.deps.bus.emit('agents.updated', this.activeAgents);
          this.deps.bus.emit('activity.changed', this.activity);
          continue;
        }
        if (event.type === 'run.started') {
          this.currentRunId = event.runId;
          this.setActivity('thinking', 'Thinking…');
          this.deps.bus.emit('activity.changed', this.activity);
        }
        if (event.type === 'run.model') {
          // O que o CLI respondeu vence o que a conta pediu: é ele quem sabe
          // com que janela está rodando.
          this.reportedModel = event.model;
        }
        if (event.type === 'run.usage') {
          // Contagem em andamento: alimenta o relógio da barra de atividade e
          // não entra no histórico de uso, que só conta o total do fim do run.
          this.activity = { ...this.activity, usage: event.usage };
          if (event.contextTokens !== undefined) {
            this.contextTokens = Math.max(this.contextTokens, event.contextTokens);
          }
          this.deps.bus.emit('activity.changed', this.activity);
        }
        if (event.type === 'question.asked') {
          // A pergunta entra no estado antes de ir para a interface: se a view
          // for reconstruída enquanto o agente espera, o modal volta com ela.
          this.pendingQuestion = event.request;
          this.deps.bus.emit('question.ask', event.request);
        }
        if (event.type === 'question.closed') {
          this.clearPendingQuestion(event.requestId);
        }
        if (event.type === 'message.completed' && event.usage !== undefined) {
          // O uso é contabilizado no perfil que executou, não no agente.
          await this.deps.usage.record(this.usageProfileId(), event.usage);
          await this.refreshAccounts();
          // O total do agente vence a estimativa em andamento nos últimos
          // instantes do run, para o número exibido terminar no valor certo.
          this.activity = { ...this.activity, usage: event.usage };
          this.deps.bus.emit('activity.changed', this.activity);
        }
        this.deps.bus.emit('chat.event', event);
        if (event.type === 'run.failed') {
          // O CLI fala consigo mesmo: "401 OAuth access token has expired" diz
          // o que houve, não o que fazer. Quem lê precisa saber que é a conta e
          // onde reconectá-la — o texto do provedor fica, porque a classificação
          // é palpite sobre a frase dele.
          const diagnosis = describeAgentFailure(event.error.message);
          // Sem classificação não há o que acrescentar: repetir a mesma frase
          // num aviso ao lado da mensagem seria só barulho.
          if (diagnosis.kind !== 'unknown') {
            const account = this.accounts.find(
              (item) => item.profileId === this.mainAgentProfile?.profile.providerProfileId,
            );
            this.deps.bus.emit('notification', {
              level: 'warning',
              message:
                account === undefined
                  ? t('The agent stopped: {0}.', diagnosis.summary)
                  : t('The agent stopped: {0} ({1}).', diagnosis.summary, account.name),
            });
          }
          this.deps.bus.emit('chat.error', event.error);
        }
      }
    } catch (error) {
      this.deps.logger.error(`Falha ao enviar mensagem: ${String(error)}`);
      this.deps.bus.emit('chat.error', serializeError(error));
    } finally {
      // Um run que acabou não tem pergunta aberta, aconteça o que acontecer.
      this.clearPendingQuestion(this.pendingQuestion?.requestId ?? null);
      this.busy = false;
      this.currentRunId = null;
      // As sessões deste run terminaram: o agente volta a ser um só, ocioso.
      // Sem isto, cada mensagem enviada deixava mais uma linha "trabalhando"
      // na lista, e ela crescia a cada pergunta.
      this.settleActiveAgents();
      this.deps.bus.emit('agents.updated', this.activeAgents);
      this.activity = IDLE_ACTIVITY;
      this.deps.bus.emit('activity.changed', this.activity);
      await this.expireOneTaskBypass();
      await this.publish();
    }

    await this.maybeAutoCompact();
    await this.flushQueue();
  }

  /**
   * Envia o que ficou esperando o agente terminar.
   *
   * Vai tudo numa mensagem só: duas linhas que a pessoa escreveu seguidas são
   * um pedido só, e mandá-las separadas faria o agente responder à primeira e
   * recomeçar na segunda.
   */
  private async flushQueue(): Promise<void> {
    if (this.busy || this.queued.length === 0) {
      return;
    }
    const pending = this.queued.splice(0, this.queued.length);
    const content = pending.map((item) => item.content).join('\n\n');
    const drafts = pending.flatMap((item) => [...item.drafts]);
    await this.send(content, drafts, pending[0]?.author ?? 'user');
  }

  /** Tira da fila uma mensagem que a pessoa desistiu de mandar. */
  async dropQueued(index: number): Promise<void> {
    if (index < 0 || index >= this.queued.length) {
      return;
    }
    this.queued.splice(index, 1);
    await this.publish();
  }

  /**
   * Interrompe o que está rodando para mandar a fila agora.
   *
   * O CLI não aceita texto no meio de um run — a entrada dele já foi fechada.
   * Então "agora" quer dizer parar o turno atual e começar outro, o que só é
   * aceitável porque a conversa é retomada: o agente continua sabendo de tudo
   * o que já foi dito.
   */
  async sendQueuedNow(): Promise<void> {
    if (this.queued.length === 0) {
      return;
    }
    if (this.busy && this.currentRunId !== null) {
      await this.cancel(this.currentRunId);
    }
    await this.flushQueue();
  }

  /**
   * Compacta sozinho quando a janela está quase cheia.
   *
   * Acontece **depois** do run, e não antes do próximo: quem acabou de ler uma
   * resposta entende o aviso de compactação melhor do que quem acabou de enviar
   * uma mensagem e ficaria esperando sem saber por quê.
   */
  private async maybeAutoCompact(): Promise<void> {
    const { usedTokens, windowTokens, threshold } = this.contextStatus;

    if (!this.autoCompact || this.compacting || this.busy) {
      return;
    }
    if (usedTokens < windowTokens * threshold) {
      return;
    }

    this.compacting = true;
    try {
      this.deps.bus.emit('notification', {
        level: 'info',
        message: 'Context window is nearly full — compacting the conversation.',
      });
      await this.compactConversation();
    } finally {
      this.compacting = false;
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.deps.localChat.cancel(runId);
  }

  // ---------- Idioma ----------

  /**
   * Troca o idioma do painel. A escolha vai para a configuração do usuário —
   * é preferência de pessoa, não do projeto — e o HTML da webview é refeito,
   * porque o texto viaja junto dele.
   */
  async setLanguage(choice: LanguageChoice): Promise<void> {
    await vscode.workspace
      .getConfiguration('prometheon')
      .update('language', choice, vscode.ConfigurationTarget.Global);
    await this.refreshLanguage();
  }

  /** Relê a preferência e redesenha a interface, se algo mudou. */
  private async refreshLanguage(): Promise<void> {
    const preferred = vscode.workspace.getConfiguration('prometheon').get<string>('language');
    if (applyLanguage(isLanguageChoice(preferred) ? preferred : 'auto')) {
      this.deps.bus.emit('language.changed', languageChoice());
      await this.publish();
    }
  }

  // ---------- Perguntas do agente ----------

  /**
   * Entrega a resposta ao agente que perguntou. A checagem aqui não é
   * formalidade: a webview poderia mandar rótulo que ninguém ofereceu, e o
   * agente receberia isso como se tivesse vindo do usuário.
   */
  async answerQuestion(
    requestId: string,
    answers: readonly AgentQuestionAnswer[],
  ): Promise<void> {
    const request = this.pendingQuestion;
    if (request === null || request.requestId !== requestId) {
      this.deps.logger.warn(`Resposta para uma pergunta que não está aberta: ${requestId}.`);
      return;
    }
    if (!matchesRequest(request, answers)) {
      this.deps.logger.warn(`Resposta descartada: não corresponde à pergunta ${requestId}.`);
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'The answer did not match the question and was discarded.',
      });
      return;
    }
    await this.deps.localChat.answerQuestion(requestId, { type: 'answered', answers });
  }

  /** O usuário fechou o modal: o agente recebe "cancelado" e segue o run. */
  async cancelQuestion(requestId: string): Promise<void> {
    if (this.pendingQuestion?.requestId !== requestId) {
      return;
    }
    await this.deps.localChat.answerQuestion(requestId, { type: 'cancelled' });
  }

  /** Tira a pergunta do estado e fecha o modal, se ainda for a mesma. */
  private clearPendingQuestion(requestId: string | null): void {
    if (requestId === null || this.pendingQuestion?.requestId !== requestId) {
      return;
    }
    this.pendingQuestion = null;
    this.deps.bus.emit('question.close', requestId);
  }

  async stopAgent(sessionId: string): Promise<void> {
    const agent = this.activeAgents.find((item) => item.sessionId === sessionId);
    if (agent === undefined) {
      return;
    }
    await this.deps.registry.require(agent.agentId).interrupt(sessionId);
    this.upsertActiveAgent({ ...agent, status: 'stopped' });
    this.deps.bus.emit('agents.updated', this.activeAgents);
  }

  async newLocalChat(): Promise<void> {
    const conversation = await this.deps.localChat.createConversation({ chatType: 'local' });
    this.conversationId = conversation.id;
    this.conversationTitle = conversation.title;
    this.activeAgents = [];
    await this.setChatType('local');
    await this.publish();
  }

  /** Abre uma sessão já existente do histórico local. */
  async openSession(conversationId: string): Promise<void> {
    if (this.busy) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Wait for the current run to finish before switching sessions.',
      });
      return;
    }
    // A sessão é procurada no serviço do tipo de chat aberto: um id do Hub não
    // existe no histórico local, e vice-versa.
    const service = this.chatType === 'web' ? this.deps.webChat : this.deps.localChat;
    const session = (await service.listConversations()).find((item) => item.id === conversationId);
    if (session === undefined) {
      this.deps.bus.emit('notification', { level: 'warning', message: 'Session not found.' });
      return;
    }
    this.conversationId = session.id;
    this.conversationTitle = session.title;
    this.activeAgents = [];
    await this.deps.local.setActiveConversationId(session.id);
    if (this.chatType !== session.chatType) {
      await this.setChatType(session.chatType);
      return;
    }
    await this.publish();
  }

  /**
   * Abre a saída integral de um passo numa aba do editor.
   *
   * O chat guarda só o começo da saída — o suficiente para ler de relance. Um
   * `npm test` inteiro não cabe ali, e rolar dentro de uma bolha de chat seria
   * pior do que ler no editor, onde há busca, quebra de linha e dobra de código.
   */
  async openStepOutput(stepId: string, label: string): Promise<void> {
    const uri = this.deps.toolOutputs.documentUri(stepId, label);
    if (uri === null) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'This output is no longer available.',
      });
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.reportFailure('Não foi possível abrir a saída da ferramenta', error);
    }
  }

  /**
   * Escolhe imagens em disco e devolve os bytes para a webview montar as
   * miniaturas. A leitura acontece aqui: a webview nunca abre arquivo.
   */
  async attachImages(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      title: 'Attach images',
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    });
    if (picked === undefined || picked.length === 0) {
      return;
    }

    const attachments: ImageAttachment[] = [];
    for (const uri of picked.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      const mimeType = imageMimeType(uri.fsPath);
      if (mimeType === null) {
        this.deps.bus.emit('notification', {
          level: 'warning',
          message: `Unsupported image format: ${baseName(uri.fsPath)}`,
        });
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        this.deps.bus.emit('notification', {
          level: 'warning',
          message: `${baseName(uri.fsPath)} is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
        });
        continue;
      }
      attachments.push({
        id: newId('att'),
        name: baseName(uri.fsPath),
        mimeType,
        data: Buffer.from(bytes).toString('base64'),
        byteSize: bytes.byteLength,
      });
    }

    if (attachments.length > 0) {
      this.deps.bus.emit('attachments.added', attachments);
    }
  }

  async clearLocalChat(): Promise<void> {
    if (this.conversationId === null) {
      return;
    }
    await this.deps.localChat.clearConversation(this.conversationId);
    this.conversationTitle = UNTITLED;
    this.activeAgents = [];
    this.contextTokens = 0;
    await this.publish();
  }

  /**
   * Apaga uma sessão do histórico, no serviço a que ela pertence.
   *
   * A confirmação acontece na interface, antes de chegar aqui. Se a sessão
   * apagada era a aberta, uma nova é criada em seguida: ficar sem conversa
   * ativa deixaria o painel num estado em que nem enviar mensagem funciona.
   */
  /**
   * Renomeia a conversa. Um título dado à mão vence o automático para sempre:
   * o batismo pela primeira mensagem só acontece enquanto a sessão é
   * "Untitled", então nada aqui é sobrescrito depois.
   *
   * Conversa do Hub é do time e vive no servidor — renomeá-la é operação do
   * site, não desta máquina; aqui a interface diz isso em vez de fingir.
   */
  async renameSession(conversationId: string, title: string): Promise<void> {
    if (this.chatType === 'web') {
      this.deps.bus.emit('notification', {
        level: 'info',
        message: t('Rename Hub conversations in the Prometheon Hub.'),
      });
      return;
    }
    try {
      await this.deps.localChat.rename(conversationId, title);
      if (conversationId === this.conversationId) {
        this.conversationTitle = title;
      }
      await this.refreshSessions();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível renomear a sessão', error);
    }
  }

  async deleteSession(conversationId: string): Promise<void> {
    if (this.busy && conversationId === this.conversationId) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Stop the current run before deleting this session.',
      });
      return;
    }

    const service = this.chatType === 'web' ? this.deps.webChat : this.deps.localChat;

    try {
      await service.deleteConversation(conversationId);
    } catch (error) {
      const serialized = serializeError(error);
      this.deps.logger.info(`Sessão não apagada: ${serialized.message}`);
      this.deps.bus.emit('notification', { level: 'warning', message: serialized.message });
      return;
    }

    if (conversationId === this.conversationId) {
      this.conversationId = null;
      this.messages = [];
      this.activeAgents = [];
      this.contextTokens = 0;
      await this.ensureConversation();
    }
    await this.publish();
  }

  /**
   * Escolhe um arquivo do projeto e o cita no composer.
   *
   * A leitura do disco fica aqui, como todo acesso a arquivo: a webview recebe
   * só o caminho relativo para colocar no texto. Nada é lido nem enviado agora —
   * quem decide abrir o arquivo é o agente, quando a mensagem for.
   */
  async addFileToComposer(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];

    if (folder === undefined) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Open a folder to mention files from the project.',
      });
      return;
    }

    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.next,coverage}/**',
      MAX_CONTEXT_FILE_CHOICES,
    );

    if (files.length === 0) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'No file found in this folder.',
      });
      return;
    }

    const items = files
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .sort((left, right) => left.localeCompare(right))
      .map((path) => ({ label: baseName(path), description: path }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Add file to the message',
      placeHolder: 'Pick a file to mention',
      matchOnDescription: true,
    });

    if (picked === undefined) {
      return;
    }

    this.deps.bus.emit('composer.insert', { text: `@${picked.description} ` });
  }

  /**
   * Pede ao agente que resuma a conversa e siga a partir do resumo.
   *
   * O pedido vai pelo caminho normal de mensagem, e é o próprio CLI que sabe
   * compactar: o Prometheon não reescreve o histórico do agente por fora, o que
   * daria duas versões do que foi dito e nenhuma delas confiável.
   */
  async compactConversation(): Promise<void> {
    if (this.busy) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Wait for the current run to finish before compacting.',
      });
      return;
    }
    if (this.messages.length === 0) {
      this.deps.bus.emit('notification', {
        level: 'info',
        message: 'Nothing to compact yet.',
      });
      return;
    }
    await this.send(COMPACT_PROMPT);
    // A janela cheia é do processo do CLI, não da conversa: resumir dentro dela
    // não devolve espaço nenhum. O que devolve é largar a sessão e começar
    // outra levando o resumo — que é justamente o que o agente acabou de
    // escrever, e está na última resposta.
    const summary = [...this.messages].reverse().find((item) => item.author === 'agent');
    if (this.conversationId !== null) {
      await this.deps.localChat.startFreshSession(this.conversationId, summary?.content ?? '');
    }
    // O contexto encolheu; a estimativa antiga descreveria a conversa anterior.
    this.contextTokens = 0;
    await this.publish();
  }

  async setAutoCompact(enabled: boolean): Promise<void> {
    this.autoCompact = enabled;
    await this.deps.local.setAutoCompact(enabled);
    await this.publish();
  }

  /** Troca o modelo da conta em uso. Vale para a próxima mensagem. */
  async setModel(model: string): Promise<void> {
    const profileId = this.accounts.find(
      (item) => item.profileId === this.usageProfileId(),
    )?.profileId;

    if (profileId === undefined) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Create an account before choosing a model.',
      });
      return;
    }

    try {
      await this.deps.profiles.setModel(profileId, model);
    } catch (error) {
      const serialized = serializeError(error);
      this.deps.logger.error(`Modelo não trocado: ${serialized.message}`);
      this.deps.bus.emit('notification', { level: 'warning', message: serialized.message });
      return;
    }

    await this.refreshAccounts();
    await this.publish();
  }

  async setChatType(chatType: ChatType): Promise<void> {
    this.chatType = chatType;
    await this.deps.local.setChatType(chatType);

    if (chatType === 'web') {
      // Mostra o estado real do Hub sem tentar conectar nem simular conexão.
      this.hubStatus = this.deps.hub.getStatus();
      this.deps.bus.emit('hub.status', this.hubStatus);
      await this.refreshWebProjects();
    }
    await this.publish();
  }

  /**
   * Lê os projetos do Hub.
   *
   * Sem conexão autenticada a lista é esvaziada em vez de mantida: projeto que
   * veio de outra sessão não pode continuar sendo oferecido como se estivesse
   * ao alcance.
   */
  async refreshWebProjects(): Promise<void> {
    if (!this.deps.hub.isAuthenticated()) {
      this.webProjects = [];
      return;
    }

    try {
      const projects = await this.deps.hub.listProjects();
      this.webProjects = projects.map((project) => ({ id: project.id, name: project.name }));
    } catch (error) {
      const serialized = serializeError(error);
      this.deps.logger.info(`Projetos do Hub indisponíveis: ${serialized.message}`);
      this.webProjects = [];
      return;
    }

    // A escolha guardada só vale se o projeto ainda existir para esta conta;
    // um projeto removido deixaria o painel pedindo conversas de um lugar que
    // não responde mais.
    const stored = this.deps.local.getWebProjectId();
    const known = this.webProjects.find((project) => project.id === stored);
    const chosen = known ?? this.webProjects[0];

    if (chosen !== undefined && chosen.id !== stored) {
      await this.deps.local.setWebProjectId(chosen.id);
    }
    this.deps.webChat.setProject(chosen?.id ?? null);
  }

  /** Troca o projeto do Web Chat. A conversa aberta não sobrevive à troca. */
  async setWebProject(projectId: string): Promise<void> {
    if (!this.webProjects.some((project) => project.id === projectId)) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'This project is not available for your account.',
      });
      return;
    }

    this.deps.webChat.setProject(projectId);
    await this.deps.local.setWebProjectId(projectId);
    // A conversa aberta pertence ao projeto anterior; mantê-la mostraria
    // mensagens de um projeto com a lista de outro.
    this.conversationId = null;
    this.messages = [];
    await this.publish();
  }

  // ---------- Orquestração ----------

  async setWorkMode(mode: WorkMode): Promise<void> {
    this.workMode = mode;
    this.deps.permissions.update({ workMode: mode });
    await this.deps.local.setWorkMode(mode);
    await this.persistOrchestration({ workMode: mode });
    await this.publish();
  }

  /**
   * Troca o nível de autonomia. `bypass` exige confirmação, escopo e duração, e
   * nunca é gravado como preferência.
   */
  async setAutonomy(autonomy: Autonomy): Promise<void> {
    if (autonomy === 'bypass') {
      const grant = await this.requestBypassGrant();
      if (grant === null) {
        // Publica de novo para o seletor da UI voltar ao valor anterior.
        await this.publish();
        return;
      }
      this.bypass = grant;
      this.autonomy = 'bypass';
      this.deps.logger.warn(
        `Bypass ativado — escopo ${grant.scope}, duração ${grant.duration}. Não será persistido.`,
      );
    } else {
      this.bypass = null;
      this.autonomy = autonomy;
      await this.deps.local.setAutonomy(autonomy);
      await this.persistOrchestration({ autonomy });
    }

    this.deps.permissions.update({ autonomy: this.autonomy, bypass: this.bypass });
    await this.syncBypassContext();
    await this.publish();
  }

  async disableBypass(reason = 'Bypass permissions disabled.'): Promise<void> {
    if (this.bypass === null) {
      return;
    }
    this.bypass = null;
    this.autonomy = this.deps.local.getAutonomy();
    this.deps.permissions.update({ autonomy: this.autonomy, bypass: null });
    this.deps.logger.info(reason);
    this.deps.bus.emit('notification', { level: 'info', message: reason });
    await this.syncBypassContext();
    await this.publish();
  }

  async setMainAgent(agentId: string): Promise<void> {
    const isAdapter = this.deps.registry.has(agentId);
    const isProfile = this.agentProfiles.some((summary) => summary.profile.id === agentId);
    if (!isAdapter && !isProfile) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: `Unknown agent: ${agentId}`,
      });
      return;
    }
    this.mainAgentId = agentId;
    // O registro conhece adaptadores; um perfil principal delega ao motor da
    // conta dele — é isso que `executionAgentId` resolve.
    this.deps.registry.setMain(this.executionAgentId());
    await this.deps.local.setMainAgentId(agentId);
    await this.persistOrchestration({ mainAgent: agentId });
    await this.publish();
  }

  // ---------- Seletores via Command Palette ----------

  async pickWorkMode(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      WORK_MODES.map((mode) => ({
        label: WORK_MODE_LABELS[mode],
        ...(mode === this.workMode ? { description: 'current' } : {}),
        detail: WORK_MODE_DESCRIPTIONS[mode],
        mode,
      })),
      { title: 'Prometheon: Select Work Mode', placeHolder: 'How should agents work?' },
    );
    if (picked !== undefined) {
      await this.setWorkMode(picked.mode);
    }
  }

  async pickAutonomy(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      AUTONOMY_LEVELS.map((level) => ({
        label: AUTONOMY_LABELS[level],
        ...(level === this.autonomy ? { description: 'current' } : {}),
        detail: AUTONOMY_DESCRIPTIONS[level],
        level,
      })),
      { title: 'Prometheon: Select Autonomy', placeHolder: 'How much approval do you want?' },
    );
    if (picked !== undefined) {
      await this.setAutonomy(picked.level);
    }
  }

  async pickMainAgent(): Promise<void> {
    this.agents = await this.deps.registry.summaries();
    const picked = await vscode.window.showQuickPick(
      this.agents.map((agent) => ({
        label: agent.displayName,
        description: agent.id === this.mainAgentId ? 'current' : agent.transport,
        detail: agent.available ? 'Available' : 'Unavailable',
        agentId: agent.id,
      })),
      { title: 'Prometheon: Select Main Agent', placeHolder: 'Which agent leads?' },
    );
    if (picked !== undefined) {
      await this.setMainAgent(picked.agentId);
    }
  }

  // ---------- Workspace ----------

  async configureWorkspace(choice?: WorkspaceSetupChoice): Promise<void> {
    const resolved = choice ?? (await this.askWorkspaceChoice());
    if (resolved === undefined) {
      return;
    }

    switch (resolved) {
      case 'current': {
        const outcome = await this.deps.initializer.initializeCurrentWorkspace();
        switch (outcome.kind) {
          case 'done':
            await this.deps.local.setWorkspaceSetupSkipped(false);
            this.deps.bus.emit('notification', {
              level: 'info',
              message: `Prometheon workspace ready${outcome.createdConfig ? '' : ' (existing configuration preserved)'}.`,
            });
            break;
          case 'denied':
            this.deps.bus.emit('notification', { level: 'error', message: outcome.reason });
            break;
          case 'no-folder':
            this.deps.bus.emit('notification', {
              level: 'warning',
              message: 'Open a folder first to create the Prometheon workspace.',
            });
            break;
          case 'cancelled':
            break;
        }
        break;
      }

      case 'external': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use as Prometheon workspace',
          title: 'Choose Prometheon workspace folder',
        });
        const folder = picked?.[0];
        if (folder !== undefined) {
          await this.deps.local.setExternalWorkspaceFolder(folder.fsPath);
          await this.deps.local.setWorkspaceSetupSkipped(false);
          this.deps.bus.emit('notification', {
            level: 'info',
            message: `Prometheon workspace folder set to ${folder.fsPath}.`,
          });
        }
        break;
      }

      case 'skip':
        await this.deps.local.setWorkspaceSetupSkipped(true);
        this.deps.bus.emit('notification', {
          level: 'info',
          message: 'Continuing without a shared workspace. Local Chat keeps working.',
        });
        break;
    }

    await this.refreshWorkspaceStatus();
    // A seção MCP depende de `.prometheon/`: com o workspace pronto, ela sai do
    // estado "indisponível" sem o usuário precisar reabrir o painel.
    await this.refreshMcp();
    await this.publish();
  }

  async initializeWorkspace(): Promise<void> {
    await this.configureWorkspace('current');
  }

  // ---------- Contas de provedor ----------

  /**
   * Relê os perfis e o que os CLIs reportam. Envolve rodar `auth status` de cada
   * perfil, então acontece sob demanda — abrir o painel de contas, criar perfil,
   * concluir um run — e não a cada publicação de estado.
   */
  async refreshAccounts(): Promise<void> {
    try {
      const statuses = await this.deps.profiles.statuses();
      this.accounts = statuses.map((status) => ({
        profileId: status.profile.id,
        name: status.profile.name,
        providerId: status.profile.providerId,
        providerName: status.providerName,
        configDirectory: status.profile.configDirectory,
        model: status.profile.model ?? '',
        cliInstalled: status.installation.installed,
        ...optionalText('cliVersion', status.installation.version),
        authenticated: status.auth.authenticated,
        ...optionalText('accountLabel', status.auth.accountLabel),
        ...optionalText('organization', status.auth.organization),
        ...optionalText('plan', status.auth.plan),
        ...optionalText('authMethod', status.auth.authMethod),
        ...optionalText('message', status.auth.message),
        usage: this.deps.usage.usageFor(status.profile.id),
      }));
    } catch (error) {
      this.deps.logger.error(`Falha ao ler as contas: ${serializeError(error).message}`);
      this.accounts = [];
    }
    // O binding de cada agente é resolvido contra estas contas, então ele é
    // recalculado junto — nunca fica apontando para um estado antigo.
    await this.refreshAgentProfiles();
  }

  /**
   * Cria uma conta local para um provedor. O nome e o provedor vêm do
   * formulário do painel — nenhum diálogo do VS Code participa disso. O login
   * continua sendo um passo à parte, pelo fluxo oficial do CLI (documento §11).
   */
  async createAccount(name: string, providerId: string, model = ''): Promise<void> {
    try {
      const profile = await this.deps.profiles.create({ name, providerId, model });
      const adapter = this.deps.profiles.adapterFor(profile.providerId);
      await this.adoptAgentsWithoutAccount(profile.id);
      await this.refreshAccounts();
      await this.publish();
      this.deps.bus.emit('notification', {
        level: 'info',
        message: `Account "${profile.name}" created with its own ${adapter.configEnvironmentVariable}. Use Sign in to authenticate it through the official CLI flow.`,
      });
    } catch (error) {
      this.reportFailure('Não foi possível criar a conta', error);
    }
  }

  /**
   * Liga à conta recém-criada os agentes que ainda não têm nenhuma.
   *
   * São a equipe embutida na primeira execução, e os agentes que vieram do
   * repositório para quem acabou de cloná-lo. Sem isto, a primeira coisa a
   * fazer depois de conectar seria abrir quatro formulários e escolher a mesma
   * conta em todos.
   *
   * Só alcança quem está sem conta: um agente já vinculado nunca muda de conta
   * porque outra apareceu.
   */
  private async adoptAgentsWithoutAccount(profileId: string): Promise<void> {
    const orphans = this.agentProfiles.filter(
      (summary) => summary.profile.providerProfileId === '',
    );
    if (orphans.length === 0) {
      return;
    }
    for (const summary of orphans) {
      await this.deps.agentProfiles.bind(summary.profile.id, profileId);
    }
    this.deps.logger.info(
      `Conta ${profileId} adotou ${String(orphans.length)} agente(s) sem vínculo.`,
    );
    await this.refreshAgentProfiles();
  }

  /**
   * Corrige o nome de uma conta. Só o rótulo muda: o identificador, o diretório
   * de credenciais e os agentes vinculados continuam intactos, então renomear
   * nunca exige um novo login nem religar agente nenhum.
   */
  async renameAccount(profileId: string, name: string): Promise<void> {
    try {
      await this.deps.profiles.rename(profileId, name);
      await this.refreshAccounts();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível renomear a conta', error);
    }
  }

  // ---------- Agent Profiles ----------

  /**
   * Relê os agentes e resolve os vínculos contra as contas e os papéis
   * conhecidos. Um agente cuja conta ou cujo papel sumiu ganha um aviso: nunca
   * é reapontado para outro.
   */
  async refreshAgentProfiles(): Promise<void> {
    try {
      this.agentProfiles = await this.deps.agentProfiles.summaries(this.accounts, this.customRoles);
    } catch (error) {
      this.deps.logger.error(`Falha ao ler os Agent Profiles: ${serializeError(error).message}`);
      this.agentProfiles = [];
    }
  }

  // ---------- Papéis nomeados ----------

  /** Relê os papéis dos três escopos. O do Hub só entra se houver conexão. */
  async refreshCustomRoles(): Promise<void> {
    try {
      await this.deps.agentRoles.refreshFromHub();
      this.customRoles = await this.deps.agentRoles.list();
    } catch (error) {
      this.deps.logger.error(`Falha ao ler os papéis: ${serializeError(error).message}`);
      this.customRoles = [];
    }
  }

  async createCustomRole(draft: CustomRoleDraft): Promise<void> {
    try {
      const role = await this.deps.agentRoles.create(draft);
      await this.refreshCustomRoles();
      await this.refreshAgentProfiles();
      await this.publish();
      this.deps.bus.emit('notification', {
        level: 'info',
        message: `Role "${role.label}" created.`,
      });
    } catch (error) {
      this.reportFailure('Não foi possível criar o papel', error);
    }
  }

  async updateCustomRole(id: string, draft: CustomRoleDraft): Promise<void> {
    try {
      await this.deps.agentRoles.update(id, draft);
      await this.refreshCustomRoles();
      await this.refreshAgentProfiles();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível salvar o papel', error);
    }
  }

  /**
   * Remove o papel. Confirma no modal porque os agentes que apontam para ele
   * ficam sem papel — e a interface passa a avisar isso em cada um.
   */
  /**
   * Abre (criando se preciso) o prompt em arquivo de um agente. Prompt grande
   * merece editor de verdade — e, sendo arquivo, o próprio agente pode ler e
   * manter o próprio manual.
   */
  async openAgentPrompt(id: string): Promise<void> {
    try {
      const file = await this.deps.agentProfiles.ensurePromptFile(id);
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document, { preview: false });
      // O arquivo vence o texto inline; reler agora deixa o painel coerente.
      await this.refreshAccounts();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível abrir o prompt do agente', error);
    }
  }

  /**
   * Abre (criando se preciso) o prompt em arquivo de uma função de projeto ou
   * máquina. O arquivo é a forma revisável do prompt: no escopo de projeto ele
   * viaja pelo Git e muda por PR, como qualquer comportamento do time.
   */
  async openRolePrompt(id: string): Promise<void> {
    const role = this.customRoles.find((candidate) => candidate.id === id);
    if (role === undefined) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: `Unknown role: ${id}`,
      });
      return;
    }
    if (role.scope === 'hub') {
      this.deps.bus.emit('notification', {
        level: 'info',
        message: t('Team role prompts sync through the Hub; the file editor arrives in a next phase.'),
      });
      return;
    }
    try {
      const file = await this.deps.agentRoles.ensurePromptFile(role);
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document, { preview: false });
      // O arquivo vence o texto inline; reler agora deixa o painel coerente
      // com o que o editor está mostrando.
      await this.refreshCustomRoles();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível abrir o prompt da função', error);
    }
  }

  async removeCustomRole(id: string): Promise<void> {
    try {
      const role = await this.deps.agentRoles.require(id);
      const bound = this.agentProfiles.filter(
        (summary) => summary.profile.customRoleId === role.id,
      );
      const confirm = 'Remove role';
      const answer = await vscode.window.showWarningMessage(
        `Remove the role "${role.label}"?`,
        {
          modal: true,
          detail:
            bound.length === 0
              ? 'No agent uses this role.'
              : `${String(bound.length)} agent profile(s) point to it and will need another role.`,
        },
        confirm,
      );
      if (answer !== confirm) {
        return;
      }
      await this.deps.agentRoles.remove(id);
      await this.refreshCustomRoles();
      await this.refreshAgentProfiles();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível remover o papel', error);
    }
  }

  // ---------- Skills ----------

  /**
   * Monta o que vai somado ao system prompt do agente principal: o papel, o
   * índice de skills e o prompt do próprio perfil, nessa ordem.
   *
   * Vazio quando o agente principal não é um Agent Profile — o adaptador então
   * roda como o CLI roda sozinho, que é o comportamento certo por padrão.
   */
  /** Agent Profile que responde como principal, quando o principal é um. */
  private get mainAgentProfile(): AgentProfileSummary | undefined {
    return this.agentProfiles.find((candidate) => candidate.profile.id === this.mainAgentId);
  }

  /**
   * Id do ADAPTADOR que executa pelo agente principal atual.
   *
   * O principal pode ser um perfil ("Claudio Main"): quem roda é o CLI do
   * provedor da conta vinculada a ele. Um id de adaptador cru continua aceito —
   * é o caminho dos testes e o fallback de quem ainda não criou perfil.
   */
  private executionAgentId(): string {
    if (this.deps.registry.has(this.mainAgentId)) {
      return this.mainAgentId;
    }
    const summary = this.mainAgentProfile;
    if (summary !== undefined) {
      const account = this.accounts.find(
        (item) => item.profileId === summary.profile.providerProfileId,
      );
      if (account !== undefined && this.deps.registry.has(account.providerId)) {
        return account.providerId;
      }
    }
    return this.deps.registry.main.id;
  }

  /**
   * Endereço da ferramenta de delegação, subindo o servidor na primeira vez.
   * Ele vive enquanto a extensão viver — abrir e fechar a cada mensagem
   * trocaria a porta no meio de uma conversa que o CLI está retomando.
   */
  private async delegationEndpoint(): Promise<StartAgentInput['delegation']> {
    this.delegationServer ??= new DelegationServer(
      {
        listAgents: () =>
          Promise.resolve(
            this.delegatableAgents().map((summary) => this.rosterEntry(summary)),
          ),
        delegate: (agent, task, mode) => this.startDelegation(agent, task, mode),
        collect: (ticket) => this.collectDelegation(ticket),
        running: () =>
          Promise.resolve(
            [...this.delegations.values()].map((pending) => ({
              ticket: pending.ticket,
              agent: pending.agent,
              task: pending.task,
              mode: pending.mode,
              seconds: Math.round((Date.now() - pending.startedAt) / 1000),
            })),
          ),
      },
      this.deps.logger,
    );
    return this.delegationServer.start();
  }

  /**
   * Teto de agentes simultâneos nesta máquina.
   *
   * É configuração do computador, não do agente: o mesmo perfil roda num
   * desktop de 64 GB e num notebook de 8. Cada worker é um processo de CLI.
   */
  private globalConcurrencyLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('prometheon')
      .get<number>('agents.globalConcurrency', DEFAULT_GLOBAL_CONCURRENCY);
    return Number.isInteger(configured) && configured >= 1 && configured <= 16
      ? configured
      : DEFAULT_GLOBAL_CONCURRENCY;
  }

  /**
   * Agentes que o orquestrador pode acionar: todos os habilitados, menos ele
   * mesmo. Um agente que delegasse a si próprio giraria em falso.
   */
  /** Um delegável como o orquestrador o lê: nome, função, para quê e vagas. */
  private rosterEntry(summary: AgentProfileSummary): DelegationRoster {
    return {
      name: summary.profile.name,
      role: summary.customRole?.label ?? AGENT_ROLE_LABELS[summary.profile.role],
      description: summary.customRole?.description ?? AGENT_ROLE_DESCRIPTIONS[summary.profile.role],
      slots: summary.profile.maxConcurrentSessions,
    };
  }

  private delegatableAgents(): readonly AgentProfileSummary[] {
    return this.agentProfiles.filter(
      (summary) => summary.profile.enabled && summary.profile.id !== this.mainAgentId,
    );
  }

  /**
   * Começa uma delegação e devolve o relatório — ou um bilhete de retirada.
   *
   * Uma pesquisa de verdade leva minutos, e prender a ferramenta esse tempo
   * todo faz o cliente MCP desistir da chamada: o orquestrador recebe "timed
   * out" enquanto o worker segue trabalhando às escuras, com o relatório
   * inalcançável. Por isso a espera aqui é curta. O trabalho rápido volta na
   * hora, como antes; o demorado vira um bilhete, e quando o worker termina o
   * relatório entra sozinho na conversa — ninguém precisa ficar perguntando se
   * já chegou.
   */
  private async startDelegation(
    agentName: string,
    task: string,
    mode: DelegationMode,
  ): Promise<string> {
    const ticket = newId('task');
    const work = this.delegateToAgent(agentName, task, mode);
    this.delegations.set(ticket, {
      ticket,
      agent: agentName,
      // Cortada: a lista é para reconhecer a tarefa, não para relê-la inteira.
      task: task.length > 120 ? `${task.slice(0, 120)}…` : task,
      mode,
      startedAt: Date.now(),
      work,
    });

    // A recusa (agente inexistente, teto cheio) acontece em milissegundos e
    // precisa voltar como erro — dizer "estou trabalhando nisso" para uma
    // tarefa que nunca começou seria mentir para quem delegou.
    const refusal = await settleWithin(work, 0);
    if (refusal !== null && 'failure' in refusal) {
      this.delegations.delete(ticket);
      throw new Error(refusal.failure);
    }

    // A partir daqui ninguém espera: o relatório vai para a conversa quando
    // ficar pronto, e o orquestrador é retomado com ele.
    void work.then(
      (report) => {
        // Fora do mapa antes de publicar: é ele que responde "quantas ainda
        // estão correndo", e o relatório que já chegou não está mais correndo.
        this.delegations.delete(ticket);
        this.publishReport(agentName, ticket, report, null);
      },
      (error: unknown) => {
        this.delegations.delete(ticket);
        this.publishReport(
          agentName,
          ticket,
          null,
          error instanceof Error ? error.message : String(error),
        );
      },
    );

    return [
      `Sent to "${agentName}". Ticket: ${ticket}.`,
      'It is running now. Do not wait for it, do not sleep, do not poll: end your turn telling the user what you delegated. When every agent finishes, their reports come back to you automatically and you continue from there.',
    ].join(' ');
  }

  /** Troca o bilhete pelo relatório, esperando um pouco se ainda não chegou. */
  private async collectDelegation(ticket: string): Promise<string> {
    const pending = this.delegations.get(ticket.trim());
    if (pending === undefined) {
      return `No delegation with ticket "${ticket}" is running. If it already finished, its report was posted in the conversation and sent to you — look there before delegating it again.`;
    }

    const outcome = await settleWithin(pending.work, DELEGATION_INLINE_WAIT_MS);
    if (outcome === null) {
      return `"${pending.agent}" is still working on ticket ${ticket}. Answer with what you have; the report reaches the conversation when it is done.`;
    }
    this.delegations.delete(ticket);
    if ('failure' in outcome) {
      throw new Error(outcome.failure);
    }
    return outcome.report;
  }

  /** Põe na conversa o relatório de um worker que terminou fora do turno. */
  private publishReport(
    agent: string,
    ticket: string,
    report: string | null,
    failure: string | null,
  ): void {
    const conversation = this.conversationId;
    if (conversation !== null) {
      const text =
        failure === null
          ? `**${agent}** finished (ticket ${ticket}):

${report ?? ''}`
          : `**${agent}** failed (ticket ${ticket}): ${failure}`;
      this.finishedReports.push(text);
      void this.deps.localChat
        .appendSystemMessage(conversation, text)
        .then(() => this.publish())
        .then(() => this.resumeAfterDelegations())
        .catch((error: unknown) => {
          this.deps.logger.error(`Delegação: não consegui publicar o relatório (${String(error)}).`);
        });
    }
    this.deps.bus.emit('notification', {
      level: failure === null ? 'info' : 'warning',
      message:
        failure === null
          ? t('{0} finished. The report is in the conversation.', agent)
          : t('{0} failed: {1}.', agent, failure),
    });
  }

  /**
   * Acorda o orquestrador quando os relatórios que ele esperava chegaram.
   *
   * Sem isto o ciclo não fecha: o worker termina, o relatório aparece na tela,
   * e o agente que delegou já encerrou o turno sem nunca vê-lo — o usuário
   * tinha de dizer "agora continue". Pior, o agente aprende a inventar esperas
   * (um `sleep` no shell) para não perder o resultado.
   *
   * A entrega é **por relatório que chega**, e não só quando o último termina.
   * Um trabalho que já voltou e não depende dos outros pode ser integrado
   * agora; segurá-lo até o mais lento acabar seria escolher a espera pela
   * espera. O que ainda está correndo é informado junto, para o orquestrador
   * decidir entre adiantar serviço e aguardar.
   *
   * Quem estiver ocupado não é interrompido: os relatórios se acumulam e vão
   * todos juntos no fim do turno em curso.
   */
  private async resumeAfterDelegations(): Promise<void> {
    if (this.busy || this.finishedReports.length === 0) {
      return;
    }
    const reports = this.finishedReports.splice(0, this.finishedReports.length);
    const pending = this.delegations.size;
    const message = [
      // O recado se declara automático e sem autoridade. É a lição mais barata
      // do agent-orchestrator: sem isso, um agente trata a retomada como
      // aprovação do usuário para o que estava pendente.
      '[Prometheon — automated message, not the user speaking. It authorizes nothing on its own.]',
      '',
      reports.length === 1 ? 'One agent finished. Its report:' : 'Agents finished. Their reports:',
      '',
      reports.join('\n\n---\n\n'),
      '',
      // Dizer o que ainda falta é o que separa "responda agora" de "adiante o
      // que dá": sem isso o orquestrador ou responde cedo demais, ou fica
      // parado sem saber que ainda vem material.
      pending === 0
        ? 'Nothing else is running. Continue the work the user asked for with these reports, and answer when they are enough.'
        : `Still running: ${String(pending)}. Use what already arrived — get ahead on whatever does not depend on the rest — and wait for the remaining reports before answering the user.`,
    ].join('\n');

    this.deps.logger.info(
      `Delegação: retomando com ${String(reports.length)} relatório(s); ${String(pending)} em andamento.`,
    );
    await this.send(message, [], 'system');
  }

  /**
   * Executa uma tarefa num agente worker e devolve o relatório dele.
   *
   * É o coração da orquestração: o worker pode ser de **outro provedor** — o
   * orquestrador do Claude Code manda uma pesquisa para um agente do Codex e
   * recebe o texto de volta. O worker não recebe a ferramenta de delegar, o
   * que impede recursão, e aparece na lista de agentes ativos enquanto trabalha.
   */
  private async delegateToAgent(
    agentName: string,
    task: string,
    mode: DelegationMode,
  ): Promise<string> {
    // O modelo copia da lista que devolvemos, e às vezes leva o papel junto:
    // "GPT Pesquisador (Researcher)". Recusar isso gastaria uma ida e volta
    // inteira para ensinar o que já dá para entender — o nome está ali.
    const wanted = normalizeAgentName(agentName);
    // Aceita também o id, que é a identidade estável.
    const summary = this.delegatableAgents().find(
      (candidate) =>
        candidate.profile.id.toLowerCase() === wanted ||
        normalizeAgentName(candidate.profile.name) === wanted,
    );
    if (summary === undefined) {
      const known = this.delegatableAgents()
        .map((candidate) => candidate.profile.name)
        .join(', ');
      throw new Error(
        `No agent named "${agentName}". Available: ${known === '' ? 'none' : known}.`,
      );
    }

    if (this.delegationsThisRun >= MAX_DELEGATIONS_PER_RUN) {
      throw new Error(
        `This request already used its ${String(MAX_DELEGATIONS_PER_RUN)} delegations. Finish the work with the reports you have and answer the user.`,
      );
    }
    this.delegationsThisRun += 1;

    // Tetos de concorrência. A vaga é tomada aqui, antes de qualquer `await`:
    // as delegações de um mesmo turno chegam juntas, e contar quem já está na
    // lista deixaria todas passarem pela brecha entre conferir e registrar.
    const reservation = this.concurrency.tryReserve(
      summary.profile.id,
      summary.profile.name,
      summary.profile.maxConcurrentSessions,
      this.globalConcurrencyLimit(),
    );
    if (!reservation.ok) {
      throw new Error(reservation.reason);
    }

    const account = this.accounts.find(
      (item) => item.profileId === summary.profile.providerProfileId,
    );
    const adapterId = account?.providerId ?? '';
    if (!this.deps.registry.has(adapterId)) {
      throw new Error(
        `Agent "${summary.profile.name}" is bound to an account whose CLI is not available here.`,
      );
    }
    const adapter = this.deps.registry.require(adapterId);
    const folder = this.deps.workspace.folder?.uri.fsPath;
    const model = summary.profile.model;
    const prompt = this.systemPromptFor(summary);

    // Trabalho que altera arquivos ganha uma cópia isolada do repositório. Dois
    // agentes editando a mesma árvore se sobrescrevem sem aviso; em worktrees
    // separadas, o encontro do trabalho vira um merge, que o git sabe resolver.
    let worktree: Worktree | null = null;
    if (mode === 'changes' && folder !== undefined) {
      if (await this.deps.worktrees.isRepository(folder)) {
        worktree = await this.deps.worktrees.create(folder, `${summary.profile.name}-${newId('wt')}`);
      } else {
        // Sem git não há isolamento possível, e editar a árvore de todos seria
        // exatamente o que este modo existe para evitar.
        throw new Error(
          `Cannot delegate file changes: "${this.deps.workspace.folder?.name ?? 'this folder'}" is not a git repository. Ask for a report instead, and apply the changes yourself.`,
        );
      }
    }
    const cwd = worktree?.path ?? folder;

    // Sem autonomia para executar comandos, o worker não roda typecheck nem
    // teste. Dizer isso na tarefa evita o pior desfecho: ele tentar, falhar em
    // silêncio e relatar como verificado o que ninguém verificou.
    const verifiable = this.effectiveAutonomyForRun() === 'bypass';
    const brief =
      mode === 'changes' && !verifiable
        ? `${task}

[Prometheon] You cannot run shell commands in this session, so you cannot run typecheck, lint or tests. Do the work, and state plainly in your report that verification did not run.`
        : task;

    const session = await adapter.start({
      // Os dois executam de verdade; a diferença é o que podem tocar. Pôr o
      // worker de leitura em modo de planejamento faria o CLI devolver um plano
      // em vez da pesquisa — o que fecha a porta da escrita é negar as
      // ferramentas, não trocar o modo de trabalho.
      workMode: 'edit',
      ...(mode === 'changes' ? {} : { readOnly: true }),
      // A mesma autonomia do run, nunca mais: um worker que recebesse bypass
      // por conta própria poderia rodar na máquina o que o usuário não
      // autorizou — o isolamento é da árvore de arquivos, não do sistema.
      autonomy: this.effectiveAutonomyForRun(),
      role: 'worker',
      task: brief,
      ...(cwd === undefined ? {} : { workspaceFolder: cwd }),
      ...(model === undefined || model === '' ? {} : { model }),
      ...(prompt === '' ? {} : { systemPrompt: prompt }),
      ...(summary.profile.effort === undefined ? {} : { effort: summary.profile.effort }),
    });

    this.upsertActiveAgent({
      sessionId: session.id,
      agentId: adapter.id,
      displayName: summary.profile.name,
      role: 'worker',
      status: 'working',
      task,
      roleLabel: summary.customRole?.label ?? AGENT_ROLE_LABELS[summary.profile.role],
      engine: adapter.displayName,
      ...(model === undefined || model === '' ? {} : { model: modelWithoutWindow(model) }),
    });
    this.deps.bus.emit('agents.updated', this.activeAgents);
    await this.publish();

    let report = '';
    let failure: string | null = null;
    /** O que o worker fez, para a tela dele. Não entra na conversa. */
    const steps: AgentStep[] = [];
    const recordStep = async (step: AgentStep): Promise<void> => {
      const at = steps.findIndex((item) => item.id === step.id);
      if (at === -1) {
        steps.push(step);
      } else {
        steps[at] = step;
      }
      this.activeAgents = this.activeAgents.map((item) =>
        item.sessionId === session.id ? { ...item, steps: [...steps] } : item,
      );
      this.deps.bus.emit('agents.updated', this.activeAgents);
      await this.publish();
    };

    try {
      for await (const event of adapter.send(session.id, {
        content: brief,
        workMode: 'edit',
        autonomy: this.effectiveAutonomyForRun(),
      })) {
        if (event.type === 'tool.requested') {
          await recordStep({
            id: event.toolId,
            sessionId: session.id,
            kind: 'tool',
            tool: event.tool,
            title: event.title,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
            status: 'running',
            startedAt: Date.now(),
          });
        } else if (event.type === 'tool.completed') {
          const started = steps.find((item) => item.id === event.toolId);
          const startedAt = started?.startedAt ?? Date.now();
          const detail = event.detail ?? started?.detail;
          await recordStep({
            id: event.toolId,
            sessionId: session.id,
            kind: 'tool',
            tool: started?.tool ?? 'Tool',
            title: started?.title ?? '',
            ...(detail === undefined ? {} : { detail }),
            status: event.failed === true ? 'failed' : 'done',
            startedAt,
            durationMs: Date.now() - startedAt,
          });
        } else if (event.type === 'thought') {
          await recordStep({
            id: `${session.id}-thought-${String(steps.length)}`,
            sessionId: session.id,
            kind: 'thought',
            tool: 'Thought',
            title: '',
            status: 'done',
            startedAt: Date.now() - event.durationMs,
            durationMs: event.durationMs,
          });
        } else if (event.type === 'completed') {
          report = event.text;
        } else if (event.type === 'failed') {
          failure = event.error.message;
        } else if (event.type === 'usage') {
          // O gasto do worker é do mesmo run: some no total que a conta mede.
          await this.deps.usage.record(summary.profile.providerProfileId, event.delta);
        }
      }
    } finally {
      // A vaga volta aconteça o que acontecer: vaga não devolvida é vaga
      // perdida até a extensão reiniciar.
      this.concurrency.release(summary.profile.id);
      await adapter.dispose(session.id);
      // O worker fica na lista, no estado em que parou, até o pedido do usuário
      // terminar — é o `settleActiveAgents` do fim do run que o retira. Sumir
      // na hora apagava a única evidência de que ele existiu: um worker que
      // falha em um segundo aparecia e desaparecia antes de alguém ver.
      this.activeAgents = this.activeAgents.map((item) =>
        item.sessionId === session.id
          ? {
              ...item,
              status: failure === null ? ('completed' as const) : ('failed' as const),
              steps: [...steps],
            }
          : item,
      );
      this.deps.bus.emit('agents.updated', this.activeAgents);
      await this.publish();
    }

    // O trabalho de código não cabe num texto: o que importa é onde ele está.
    // Sem branch e sem lista de arquivos, o orquestrador teria de acreditar no
    // relato do worker sobre o que foi feito — e não teria como conferir.
    if (worktree !== null && folder !== undefined) {
      const changed = await this.deps.worktrees.changes(worktree).catch(() => null);
      if (changed === null || changed.files.length === 0) {
        // Nada mudou: a cópia é lixo, e mantê-la encheria o disco de árvores
        // vazias. Só apagamos o que não tem trabalho dentro.
        await this.deps.worktrees.remove(folder, worktree);
        report = [report, '', 'No file was changed in the isolated copy.'].join('\n');
      } else {
        const stat = changed.summary === '' ? '' : ['```', changed.summary, '```'].join('\n');
        report = [
          report,
          '',
          '---',
          'Changes are in an isolated copy, not in your working tree.',
          `- branch: \`${worktree.branch}\``,
          `- path: \`${worktree.path}\``,
          `- files: ${changed.files.join(', ')}`,
          stat,
          '',
          'Read the files at that path to review them. To bring the work in, merge the branch — do not copy the files by hand, and do not edit them there yourself.',
        ]
          .filter((part) => part !== '')
          .join('\n');
      }
    }

    if (failure !== null) {
      // A falha vira instrução, não só relato: o orquestrador é quem decide se
      // tenta outro agente ou para, e ele decide com esta linha e nada mais.
      const diagnosis = describeAgentFailure(failure);
      this.deps.logger.warn(`Delegação: ${summary.profile.name} falhou — ${failure}`);
      // E o usuário precisa ver: sem isto, o worker morre calado e a única
      // pista fica dentro do raciocínio do orquestrador.
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: t('Agent "{0}" failed: {1}.', summary.profile.name, diagnosis.summary),
      });
      throw new Error(
        `Agent "${summary.profile.name}" failed: ${failure}\n\n${diagnosis.advice}`,
      );
    }
    return report === ''
      ? `Agent "${summary.profile.name}" finished without a report.`
      : await this.fitReport(report, summary.profile.name, session.id);
  }

  /**
   * Ajusta o relatório do worker ao que cabe na conversa do orquestrador.
   *
   * Um pesquisador pode voltar com dezenas de milhares de caracteres. Despejar
   * isso no contexto do pai come a janela dele e leva à espiral de compressão —
   * ele resume, perde o fio, pergunta de novo. Então o relatório longo vai
   * inteiro para um arquivo e o que volta é começo, fim e o caminho: nada se
   * perde, e é o orquestrador quem decide se precisa ler o miolo.
   */
  private async fitReport(report: string, agentName: string, sessionId: string): Promise<string> {
    if (report.length <= MAX_REPORT_CHARS) {
      return report;
    }

    const folder = this.deps.workspace.folder?.uri;
    const head = report.slice(0, Math.floor(MAX_REPORT_CHARS * 0.6));
    const tail = report.slice(-Math.floor(MAX_REPORT_CHARS * 0.3));

    if (folder === undefined) {
      return `${head}\n\n[... ${String(report.length - head.length - tail.length)} characters omitted ...]\n\n${tail}`;
    }

    const target = vscode.Uri.joinPath(folder, '.prometheon', 'reports', `${sessionId}.md`);
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, '.prometheon', 'reports'));
      await vscode.workspace.fs.writeFile(target, Buffer.from(report, 'utf8'));
    } catch (error) {
      this.deps.logger.warn(`Delegação: não consegui salvar o relatório completo (${String(error)}).`);
      return `${head}\n\n[... truncated ...]\n\n${tail}`;
    }

    return [
      head,
      `[... ${String(report.length - head.length - tail.length)} characters omitted. The full report from "${agentName}" is at ${target.fsPath} — read it if you need the middle ...]`,
      tail,
    ].join('\n\n');
  }

  /**
   * Esforço que vale para o próximo run: o do composer quando alguém escolheu,
   * senão o padrão do agente principal. `undefined` deixa a decisão com o CLI.
   */
  private effortForRun(): EffortLevel | undefined {
    return this.sessionEffort ?? this.mainAgentProfile?.profile.effort;
  }

  /**
   * Escolhe o esforço desta sessão. Escolher o mesmo valor que o agente já tem
   * volta ao padrão dele — assim o composer não vira um segundo lugar onde a
   * configuração do agente fica presa.
   */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.sessionEffort = effort === this.mainAgentProfile?.profile.effort ? null : effort;
    await this.publish();
  }

  systemPromptForMainAgent(): string {
    const summary = this.mainAgentProfile;
    if (summary === undefined) {
      return '';
    }
    const base = this.systemPromptFor(summary);
    // Só o principal recebe a cartilha de delegação, e só quando o modo pede:
    // um worker que soubesse delegar abriria recursão, e num modo sem equipe a
    // instrução falaria de uma ferramenta que ele não tem.
    const team = this.delegatableAgents();
    return this.workMode === 'agent-team' && team.length > 0
      ? [base, orchestrationInstruction(team.map((member) => this.rosterEntry(member)))]
          .filter((part) => part !== '')
          .join('\n\n')
      : base;
  }

  /** Instruções permanentes de um agente: papel, skills, grafo e prompt dele. */
  private systemPromptFor(summary: AgentProfileSummary): string {
    const { profile, customRole } = summary;
    const selection = selectSkills(profile, customRole, this.skillCatalog.skills);
    if (selection.missing.length > 0) {
      // Aviso, não erro: a skill pode chegar depois, e recusar o run inteiro
      // por causa de um nome que sobrou numa lista seria desproporcional.
      this.deps.logger.warn(
        `Agente ${profile.id}: skills não encontradas — ${selection.missing.join(', ')}.`,
      );
    }

    const parts: string[] = [];
    if (customRole !== null) {
      parts.push(`You are acting as "${customRole.label}": ${customRole.description}`);
      if (customRole.systemPrompt !== undefined) {
        parts.push(customRole.systemPrompt);
      }
    }
    const index = buildSkillIndex(selection);
    if (index !== '') {
      parts.push(index);
    }
    const graph = this.graphInstructions();
    if (graph !== '') {
      parts.push(graph);
    }
    if (profile.systemPrompt !== undefined) {
      parts.push(profile.systemPrompt);
    }
    return parts.join('\n\n');
  }

  /**
   * O que todo agente precisa saber sobre o grafo do projeto.
   *
   * Entra no prompt de qualquer agente, e não numa skill que ele talvez escolha:
   * consultar o grafo antes de varrer arquivo por arquivo só acontece se ele
   * souber que o grafo existe. Só é dito quando existe mesmo — anunciar um grafo
   * ausente faria o agente perder tempo com um comando que vai falhar.
   */
  private graphInstructions(): string {
    if (!this.graphConfig.enabled || !this.graphStatus.exists) {
      return '';
    }

    const lines = [
      `This project has a knowledge graph at ${this.graphConfig.outputDir}/.`,
      'For questions about the codebase, query it before reading files one by one:',
      '`graphify query "<question>"` returns a scoped subgraph, `graphify path "<A>" "<B>"` shows how two things relate, and `graphify explain "<concept>"` focuses on one concept.',
    ];

    // Quem reconstrói o grafo depende do gatilho configurado. Mandar o agente
    // reconstruir quando um hook já faz isso no commit produziria rebuilds
    // redundantes — e um grafo reconstruído no meio de uma tarefa incompleta.
    if (this.graphConfig.rebuildOn === 'commit') {
      lines.push(
        'Do not rebuild the graph by hand: a Git hook rebuilds it on commit, so it stays in sync with the code it describes.',
      );
    } else if (this.graphConfig.rebuildOn === 'run' && this.graphConfig.rebuildCommand !== '') {
      lines.push(
        `After changing code, rebuild the graph with: ${this.graphConfig.rebuildCommand}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Relê o catálogo de modelos: o que vem com a extensão mais o
   * `~/.prometheon/models.json` de quem não quis esperar por uma versão nova.
   */
  async refreshModels(): Promise<void> {
    try {
      this.deps.modelCatalog.invalidate();
      this.models = await this.deps.modelCatalog.list();
    } catch (error) {
      this.deps.logger.error(`Falha ao ler o catálogo de modelos: ${serializeError(error).message}`);
      this.models = [];
    }
  }

  /** Skills e papéis do projeto mudaram em disco: relê os dois e republica. */
  private async onProjectContentChanged(): Promise<void> {
    await this.refreshSkills();
    await this.refreshCustomRoles();
    await this.refreshAgentProfiles();
    await this.publish();
  }

  /**
   * Autonomia com que o run vai de fato acontecer.
   *
   * É sempre a mais restritiva entre três: a escolhida no composer, a do Agent
   * Profile e o teto das skills que ele carrega. Uma skill que lida com segredo
   * declara `manual` e prende o agente aí — é o que faz a declaração valer
   * alguma coisa em vez de ser só metadado bonito no frontmatter.
   */
  effectiveAutonomyForRun(): Autonomy {
    const summary = this.mainAgentProfile;
    if (summary === undefined) {
      return this.autonomy;
    }
    // Delegar só existe no modo de equipe; fora dele o índice não anuncia o que
    // este run não tem como entregar a ninguém.
    const selection = selectSkills(
      summary.profile,
      summary.customRole,
      this.skillCatalog.skills,
      this.workMode === 'agent-team',
    );
    const fromProfile = effectiveAutonomy(summary.profile, selection.loadable);
    const ceiling: Autonomy = fromProfile === 'bypass-temporary' ? 'bypass' : fromProfile;

    const order: readonly Autonomy[] = ['manual', 'auto', 'bypass'];
    const chosen = order.indexOf(this.autonomy);
    const allowed = order.indexOf(ceiling);
    return order[Math.min(chosen === -1 ? 0 : chosen, allowed === -1 ? 0 : allowed)] ?? 'manual';
  }

  /**
   * Abre o `SKILL.md` no editor.
   *
   * A webview manda o nome, nunca o caminho: ela não lê disco, e um caminho
   * vindo dela seria abertura arbitrária de arquivo. Quem resolve é o catálogo.
   */
  /**
   * Cria a skill no escopo pedido e abre o SKILL.md: o arquivo é a skill, e o
   * lugar de escrevê-la é o editor, não um formulário.
   */
  async createSkill(name: string, scope: 'project' | 'machine'): Promise<void> {
    try {
      const file = await this.deps.skills.createSkill(name, scope);
      const document = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(document, { preview: false });
      await this.refreshSkills();
      await this.publish();
    } catch (error) {
      const serialized = serializeError(error);
      this.deps.bus.emit('notification', { level: 'warning', message: serialized.message });
    }
  }

  async openSkill(name: string): Promise<void> {
    const skill = await this.deps.skills.find(name);
    if (skill === undefined) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: `No skill named "${name}" is available here.`,
      });
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(skill.path));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.reportFailure('Não foi possível abrir a skill', error);
    }
  }

  /** Relê o catálogo de skills do disco. */
  async refreshSkills(): Promise<void> {
    try {
      this.deps.skills.invalidate();
      this.skillCatalog = await this.deps.skills.status();
    } catch (error) {
      this.deps.logger.error(`Falha ao ler o catálogo de skills: ${serializeError(error).message}`);
      this.skillCatalog = EMPTY_SKILL_CATALOG;
    }
  }

  async createAgentProfile(draft: AgentProfileDraft): Promise<void> {
    try {
      const profile = await this.deps.agentProfiles.create(draft);
      await this.refreshAgentProfiles();
      await this.publish();
      this.deps.bus.emit('notification', {
        level: 'info',
        message: `Agent profile "${profile.name}" created.`,
      });
    } catch (error) {
      this.reportFailure('Não foi possível criar o Agent Profile', error);
    }
  }

  async updateAgentProfile(id: string, draft: AgentProfileDraft): Promise<void> {
    try {
      await this.deps.agentProfiles.update(id, draft);
      await this.refreshAgentProfiles();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível salvar o Agent Profile', error);
    }
  }

  async setAgentProfileEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      await this.deps.agentProfiles.setEnabled(id, enabled);
      await this.refreshAgentProfiles();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível alterar o Agent Profile', error);
    }
  }

  /** Remoção é destrutiva: confirma no diálogo modal do VS Code. */
  async removeAgentProfile(id: string): Promise<void> {
    try {
      const profile = await this.deps.agentProfiles.require(id);
      const confirm = 'Remove agent';
      const answer = await vscode.window.showWarningMessage(
        `Remove the agent profile "${profile.name}"?`,
        {
          modal: true,
          detail: 'The provider account and its sign-in are not touched.',
        },
        confirm,
      );
      if (answer !== confirm) {
        return;
      }
      await this.deps.agentProfiles.remove(id);
      await this.refreshAgentProfiles();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível remover o Agent Profile', error);
    }
  }

  // ---------- Grafo e política de commit ----------

  /**
   * Relê grafo e política de commit do `prometheon.yaml`.
   *
   * As duas seções andam juntas porque o commit é o gatilho do rebuild: mudar
   * uma sem reler a outra deixaria o painel mostrando um hook que já não
   * corresponde ao que está gravado.
   */
  async refreshProjectPolicies(config?: WorkspaceConfig | null): Promise<void> {
    const resolved = config ?? (await this.deps.workspace.readConfig());
    const fallback = defaultConfig(this.deps.workspace.folder?.name ?? 'Prometheon');
    this.graphConfig = resolved?.knowledge.graphify ?? fallback.knowledge.graphify;
    this.gitConfig = resolved?.git ?? fallback.git;

    try {
      this.graphStatus = await this.deps.graph.status(this.graphConfig);
    } catch (error) {
      this.deps.logger.error(`Falha ao ler o grafo: ${serializeError(error).message}`);
    }
    try {
      this.gitStatus = await this.deps.gitPolicy.status(this.gitConfig);
    } catch (error) {
      this.deps.logger.error(`Falha ao ler a política de commit: ${serializeError(error).message}`);
    }
  }

  /**
   * Grava chat padrão e orquestração no `prometheon.yaml` e reflete no estado
   * vivo na mesma hora: a configuração do projeto tem precedência, e um valor
   * recém-gravado que só valesse no próximo reload pareceria botão quebrado.
   */
  async updateWorkspaceConfig(patch: WorkspacePatch): Promise<void> {
    const configUri = this.deps.workspace.configUri;
    if (configUri === null) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: t('Initialize the Prometheon workspace before changing its settings.'),
      });
      return;
    }

    try {
      await this.deps.settings.updateWorkspace(configUri, patch);
      if (patch.defaultType !== undefined) {
        await this.setChatType(patch.defaultType);
      }
      if (patch.workMode !== undefined) {
        await this.setWorkMode(patch.workMode);
      }
      if (patch.autonomy !== undefined) {
        await this.setAutonomy(patch.autonomy);
      }
      if (patch.mainAgent !== undefined) {
        await this.setMainAgent(patch.mainAgent);
      }
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível salvar a configuração do workspace', error);
    }
  }

  async updateGraph(patch: GraphPatch): Promise<void> {
    const configUri = this.deps.workspace.configUri;
    if (configUri === null) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Initialize the Prometheon workspace before configuring the graph.',
      });
      return;
    }

    try {
      await this.deps.settings.updateGraph(configUri, patch);
      await this.refreshProjectPolicies();
      // Mudar o comando de rebuild ou o gate muda o hook: se ele já está
      // instalado, reescrevemos na hora. O que a interface mostra e o que o Git
      // executa não podem divergir por causa de um botão que ninguém apertou.
      await this.rewriteInstalledHooks();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível salvar a configuração do grafo', error);
    }
  }

  async rebuildGraph(): Promise<void> {
    try {
      await this.deps.graph.rebuild(this.graphConfig);
    } catch (error) {
      this.reportFailure('Não foi possível reconstruir o grafo', error);
    }
  }

  /**
   * Gera os scripts de rebuild dentro de `.prometheon/scripts/`, aponta o
   * comando do yaml para o da plataforma e abre o script no editor — o
   * template é ponto de partida; o corpus certo é decisão do projeto.
   */
  async createGraphScript(): Promise<void> {
    const configUri = this.deps.workspace.configUri;
    if (configUri === null) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Initialize the Prometheon workspace before configuring the graph.',
      });
      return;
    }
    try {
      const { command, open } = await this.deps.graph.createRebuildScript(this.graphConfig);
      await this.deps.settings.updateGraph(configUri, { rebuildCommand: command });
      await this.refreshProjectPolicies();
      await this.rewriteInstalledHooks();
      const document = await vscode.workspace.openTextDocument(open);
      await vscode.window.showTextDocument(document, { preview: false });
      this.deps.bus.emit('notification', {
        level: 'info',
        message: t('Rebuild script created in .prometheon/scripts/ — adjust it to this project corpus.'),
      });
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível criar o script de rebuild', error);
    }
  }

  async updateGitPolicy(patch: GitPatch): Promise<void> {
    const configUri = this.deps.workspace.configUri;
    if (configUri === null) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: 'Initialize the Prometheon workspace before configuring commit policy.',
      });
      return;
    }

    try {
      await this.deps.settings.updateGit(configUri, patch);
      await this.refreshProjectPolicies();
      await this.rewriteInstalledHooks();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível salvar a política de commit', error);
    }
  }

  /**
   * Instala os hooks nesta máquina.
   *
   * Um hook escrito à mão nunca é sobrescrito em silêncio: quando existe um sem
   * a nossa marca, o usuário confirma antes. Apagar trabalho que a interface não
   * mostra seria a pior forma de "configurar" alguma coisa.
   */
  async installGitHooks(): Promise<void> {
    try {
      await this.deps.gitPolicy.installHooks(this.gitConfig, this.graphConfig);
    } catch (error) {
      if (!(error instanceof HookConflictError)) {
        this.reportFailure('Não foi possível instalar os hooks', error);
        return;
      }
      const replace = 'Replace';
      const answer = await vscode.window.showWarningMessage(
        t('These hooks already exist and were not written by Prometheon: {0}', error.hooks.join(', ')),
        { modal: true, detail: t('Replacing overwrites the current content of these files.') },
        replace,
      );
      if (answer !== replace) {
        return;
      }
      try {
        await this.deps.gitPolicy.installHooks(this.gitConfig, this.graphConfig, {
          overwrite: true,
        });
      } catch (retryError) {
        this.reportFailure('Não foi possível instalar os hooks', retryError);
        return;
      }
    }

    await this.refreshProjectPolicies();
    await this.publish();
    this.deps.bus.emit('notification', {
      level: 'info',
      message: 'Git hooks installed for this machine.',
    });
  }

  async uninstallGitHooks(): Promise<void> {
    try {
      await this.deps.gitPolicy.uninstallHooks();
      await this.refreshProjectPolicies();
      await this.publish();
      this.deps.bus.emit('notification', {
        level: 'info',
        message: 'Git hooks disabled on this machine. The files were kept.',
      });
    } catch (error) {
      this.reportFailure('Não foi possível desativar os hooks', error);
    }
  }

  /** Regrava os hooks quando já estão instalados; caso contrário, não faz nada. */
  private async rewriteInstalledHooks(): Promise<void> {
    if (!this.gitStatus.hooksInstalled) {
      return;
    }
    try {
      await this.deps.gitPolicy.installHooks(this.gitConfig, this.graphConfig, {
        overwrite: true,
      });
    } catch (error) {
      this.deps.logger.warn(`Não foi possível regravar os hooks: ${serializeError(error).message}`);
    }
  }

  // ---------- MCP ----------

  async refreshMcp(): Promise<void> {
    try {
      this.mcpStatus = await this.deps.mcp.status();
    } catch (error) {
      this.deps.logger.error(`Falha ao ler o .mcp.json: ${serializeError(error).message}`);
      this.mcpStatus = {
        available: false,
        exists: false,
        file: null,
        servers: [],
        problems: [],
        message: 'Could not read .mcp.json.',
      };
    }
  }

  async saveMcpServer(server: McpServerDraft): Promise<void> {
    try {
      await this.deps.mcp.save(server);
      await this.refreshMcp();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível salvar o servidor MCP', error);
    }
  }

  /**
   * Escolhe outro `.mcp.json` e mescla as entradas. A leitura do disco acontece
   * aqui: a webview só pede. Nome já existente vira aviso, nunca sobrescrita.
   */
  async importMcpServers(): Promise<void> {
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Import MCP servers',
        title: 'Choose an .mcp.json to import',
        filters: { 'MCP configuration': ['json'] },
      });
      const source = picked?.[0];
      if (source === undefined) {
        return;
      }

      const result = await this.deps.mcp.importFrom(source);
      await this.refreshMcp();
      await this.publish();

      const parts = [`${result.imported.length} MCP server(s) imported.`];
      if (result.conflicts.length > 0) {
        parts.push(
          `Skipped because the name already exists: ${result.conflicts.join(', ')}. Rename or edit them instead.`,
        );
      }
      if (result.problems.length > 0) {
        parts.push(`${result.problems.length} entry(ies) could not be read.`);
      }
      this.deps.bus.emit('notification', {
        level: result.conflicts.length > 0 || result.problems.length > 0 ? 'warning' : 'info',
        message: parts.join(' '),
      });
    } catch (error) {
      this.reportFailure('Não foi possível importar servidores MCP', error);
    }
  }

  /**
   * Sonda os servidores habilitados: http/sse é uma requisição com prazo
   * curto — qualquer resposta HTTP conta como alcançável —, e stdio é a
   * existência do comando no PATH. Nada roda o servidor de verdade: o teste
   * responde "dá para falar com ele?", não "ele funciona?".
   */
  async probeMcpServers(): Promise<void> {
    const servers = this.mcpStatus.servers.filter((server) => server.enabled);
    const results: Record<string, McpProbeStatus> = {};
    await Promise.all(
      servers.map(async (server) => {
        results[server.name] = await probeMcpServer(server);
      }),
    );
    this.mcpProbes = results;
    await this.publish();
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    try {
      await this.deps.mcp.setEnabled(name, enabled);
      await this.refreshMcp();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível alterar o servidor MCP', error);
    }
  }

  async removeMcpServer(name: string): Promise<void> {
    try {
      const confirm = 'Remove server';
      const answer = await vscode.window.showWarningMessage(
        `Remove the MCP server "${name}"?`,
        { modal: true, detail: 'It is removed from .mcp.json. The rest of the file is kept.' },
        confirm,
      );
      if (answer !== confirm) {
        return;
      }
      await this.deps.mcp.remove(name);
      await this.refreshMcp();
      await this.publish();
    } catch (error) {
      this.reportFailure('Não foi possível remover o servidor MCP', error);
    }
  }

  /**
   * Erro de uma ação do painel: log em português para quem mantém, mensagem já
   * pronta em inglês para quem usa. Nada de stack trace na interface.
   */
  private reportFailure(context: string, error: unknown): void {
    const serialized = serializeError(error);
    this.deps.logger.error(`${context}: ${serialized.message}`);
    this.deps.bus.emit('notification', { level: 'error', message: serialized.message });
  }

  async loginAccount(profileId: string): Promise<void> {
    await this.deps.profiles.login(profileId);
    this.deps.bus.emit('notification', {
      level: 'info',
      message: t('Finish the sign-in in the terminal. The account connects here by itself.'),
    });
    this.watchLogin(profileId);
  }

  /**
   * Espera o OAuth do CLI concluir e reflete sozinho.
   *
   * O login roda num terminal que não é nosso: ninguém avisa quando a sessão
   * nasce. O vigia relê o estado a cada poucos segundos até a conta aparecer
   * autenticada — e aí o painel vira "Conectado" sem ninguém reabrir nada.
   * Um probe só é agendado quando o anterior terminou, então um `auth status`
   * lento nunca empilha consultas.
   */
  private watchLogin(profileId: string): void {
    this.stopLoginWatch();
    // Dez minutos cobrem navegador lento e dupla verificação; depois disso,
    // parar de consultar o CLI é gentileza com quem desistiu no meio.
    this.loginWatch = { profileId, timer: null, deadline: Date.now() + 10 * 60_000 };
    this.scheduleLoginProbe();
  }

  private scheduleLoginProbe(): void {
    const watch = this.loginWatch;
    if (watch === null) {
      return;
    }
    watch.timer = setTimeout(() => {
      void this.probeLogin();
    }, 4_000);
  }

  private async probeLogin(): Promise<void> {
    const watch = this.loginWatch;
    if (watch === null) {
      return;
    }
    if (Date.now() > watch.deadline) {
      this.stopLoginWatch();
      return;
    }
    await this.refreshAccounts();
    const account = this.accounts.find((item) => item.profileId === watch.profileId);
    if (account?.authenticated === true) {
      this.stopLoginWatch();
      this.deps.bus.emit('notification', {
        level: 'info',
        message: t('Account "{0}" is signed in.', account.name),
      });
    } else {
      this.scheduleLoginProbe();
    }
    await this.publish();
  }

  private stopLoginWatch(): void {
    if (this.loginWatch !== null && this.loginWatch.timer !== null) {
      clearTimeout(this.loginWatch.timer);
    }
    this.loginWatch = null;
  }

  /**
   * Sai da conta. A confirmação acontece no diálogo da própria interface,
   * antes de a mensagem chegar aqui — repetir a pergunta num modal do editor
   * seria perguntar duas vezes a mesma coisa.
   */
  async logoutAccount(profileId: string): Promise<void> {
    await this.deps.profiles.logout(profileId);
    await this.refreshAccounts();
    await this.publish();
  }

  /**
   * Remove o perfil da lista. As credenciais em disco não são tocadas, e a
   * confirmação — com o caminho preservado e os agentes que ficarão órfãos —
   * é o diálogo da interface quem faz.
   */
  async removeAccount(profileId: string): Promise<void> {
    await this.deps.profiles.remove(profileId);
    await this.refreshAccounts();
    await this.publish();
  }

  // ---------- Atividade ----------

  private setActivity(phase: ActivityStatus['phase'], label: string): void {
    const agent = this.agents.find((item) => item.id === this.mainAgentId);
    const account = this.accounts.find((item) => item.profileId === this.usageProfileId());
    const detail = [
      // Perfil principal aparece pelo próprio nome; adaptador cru, pelo dele.
      this.mainAgentProfile?.profile.name ?? agent?.displayName ?? this.mainAgentId,
      account === undefined ? null : `${account.providerName} · ${account.name}`,
      WORK_MODE_LABELS[this.workMode],
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');

    this.activity = {
      phase,
      label,
      detail,
      startedAt: this.activity.phase === 'idle' ? Date.now() : this.activity.startedAt,
      // A contagem pertence ao run, não à fase: trocar de fase não a zera.
      ...(this.activity.usage === undefined ? {} : { usage: this.activity.usage }),
    };
  }

  /** Traduz o estado do agente para o que a interface mostra acima do chat. */
  private trackActivity(status: ActiveAgentSummary['status']): void {
    switch (status) {
      case 'starting':
        this.setActivity('sending', 'Starting…');
        break;
      case 'working':
        this.setActivity('working', 'Working…');
        break;
      case 'waiting':
      case 'blocked':
        this.setActivity('waiting', 'Waiting for approval…');
        break;
      default:
        this.activity = IDLE_ACTIVITY;
    }
  }

  /**
   * Perfil ao qual o uso é creditado. Enquanto os agentes não têm binding com
   * um Provider Profile, cai no primeiro perfil conhecido — ou num balde local.
   */
  private usageProfileId(): string {
    // A conta do perfil principal, quando há um: é nela que o run gasta.
    const main = this.mainAgentProfile;
    if (main !== undefined) {
      return main.profile.providerProfileId;
    }
    return this.accounts[0]?.profileId ?? 'local';
  }

  // ---------- Ditado ----------

  /**
   * Começa a ouvir. Sem motor registrado nada é gravado: a interface é avisada
   * do motivo, em vez de ficar com um botão que não faz nada.
   */
  async startDictation(): Promise<void> {
    this.deps.logger.info('Ditado: pedido de início recebido da interface.');

    if (!(await this.refreshSpeechStatus())) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: this.speechStatus.detail ?? NO_SPEECH_ENGINE,
      });
      await this.publish();
      return;
    }
    try {
      await this.deps.speech.start();
    } catch (error) {
      const serialized = serializeError(error);
      this.deps.logger.info(`Ditado não iniciado: ${serialized.message}`);
      this.deps.bus.emit('notification', { level: 'warning', message: serialized.message });
    }
    await this.refreshSpeechStatus();
    await this.publish();
  }

  /** Encerra a captura e entrega o texto à webview, que o insere no rascunho. */
  async stopDictation(): Promise<void> {
    try {
      const transcript = await this.deps.speech.stop();
      if (transcript !== null) {
        this.deps.bus.emit('speech.transcript', transcript);
      }
    } catch (error) {
      const serialized = serializeError(error);
      this.deps.logger.error(`Falha ao transcrever: ${serialized.message}`);
      this.deps.bus.emit('notification', { level: 'error', message: serialized.message });
    }
    await this.refreshSpeechStatus();
    await this.publish();
  }

  async cancelDictation(): Promise<void> {
    await this.deps.speech.cancel();
    await this.refreshSpeechStatus();
    await this.publish();
  }

  /** Reavalia disponibilidade e estado do motor. Devolve se dá para ditar. */
  private async refreshSpeechStatus(): Promise<boolean> {
    const available = await this.deps.speech.isAvailable();
    // O motivo do próprio motor vem primeiro: ele sabe o que faltou. A frase
    // genérica só vale quando não há motor nenhum registrado.
    const reason = this.deps.speech.unavailableReason();
    this.speechStatus = {
      available,
      state: this.deps.speech.state,
      ...(available ? {} : { detail: reason ?? NO_SPEECH_ENGINE }),
    };

    if (!available) {
      this.deps.logger.info(`Ditado indisponível: ${reason ?? NO_SPEECH_ENGINE}`);
    }

    return available;
  }

  // ---------- Hub ----------

  /**
   * Entra no Prometheon Hub.
   *
   * Ninguém digita URL: em branco, a configuração `prometheon.hub.url` significa
   * o Hub oficial — o botão vai direto ao navegador, como no GitHub ou no
   * Claude. A configuração fica para quem hospeda o próprio Hub.
   */
  async connectHub(options?: { readonly interactive?: boolean }): Promise<void> {
    const interactive = options?.interactive ?? true;
    const configured = vscode.workspace
      .getConfiguration('prometheon')
      .get<string>('hub.url', '');

    try {
      const parsed = parseHubUrl(resolveHubUrl(configured));
      if (interactive) {
        // A reconexão silenciosa não anuncia "connecting": sem credencial ela
        // termina em nada, e o badge não deve piscar a cada abertura do editor.
        this.hubStatus = { state: 'connecting' };
        this.deps.bus.emit('hub.status', this.hubStatus);
      }
      await this.deps.hub.connect({ url: parsed.toString() }, { interactive });
      this.hubStatus = this.deps.hub.getStatus();
    } catch (error) {
      const serialized = serializeError(error);
      this.hubStatus = { state: 'local-only', detail: serialized.message };
      this.deps.bus.emit('notification', { level: 'warning', message: serialized.message });
      this.deps.logger.info(`Hub não conectado: ${serialized.message}`);
    }

    this.deps.bus.emit('hub.status', this.hubStatus);
    // Conectou: os projetos já podem ser lidos, e sem eles o Web Chat não tem
    // onde procurar conversa.
    await this.refreshWebProjects();
    await this.publish();
  }

  /**
   * Retoma a sessão do Hub na ativação, sem incomodar: só quando existe
   * credencial guardada, e nunca abrindo navegador. Quem nunca entrou não vê
   * nada; quem já entrou volta conectado, como espera de qualquer login.
   */
  async resumeHubSession(): Promise<void> {
    if (!(await this.deps.hub.hasStoredCredential())) {
      return;
    }
    await this.connectHub({ interactive: false });
  }

  /**
   * Sai do Hub nesta máquina.
   *
   * Pede confirmação porque entrar de novo custa o device flow inteiro — e
   * porque a frase precisa dizer o que **não** acontece: o dispositivo continua
   * autorizado do lado do Hub até ser revogado na conta.
   */
  async signOutHub(): Promise<void> {
    const confirm = t('Sign out');
    const choice = await vscode.window.showWarningMessage(
      t('Sign out of Prometheon Hub on this machine?'),
      {
        modal: true,
        detail: t(
          'The device credential is erased here. The device stays authorized in the Hub until you revoke it in your account.',
        ),
      },
      confirm,
    );

    if (choice !== confirm) {
      return;
    }

    await this.deps.hub.signOut();
    this.hubStatus = this.deps.hub.getStatus();
    this.webProjects = [];
    this.deps.webChat.setProject(null);
    // A conversa aberta era do Hub; sem credencial ela não pode mais ser lida.
    if (this.chatType === 'web') {
      this.conversationId = null;
      this.messages = [];
    }
    this.deps.bus.emit('hub.status', this.hubStatus);
    await this.publish();
  }

  // ---------- Diagnóstico ----------

  /** Relatório sem dados sensíveis: nenhum token, caminho de segredo ou payload. */
  async buildDiagnostics(): Promise<string> {
    // Relê o estado do workspace para não reportar informação obsoleta.
    await this.refreshWorkspaceStatus();

    const lines = [
      '# Prometheon — Diagnostics',
      '',
      `- Extension version: ${this.deps.extensionVersion}`,
      `- VS Code: ${vscode.version}`,
      `- Chat type: ${this.chatType}`,
      `- Work mode: ${this.workMode}`,
      `- Autonomy: ${this.autonomy}`,
      `- Bypass: ${this.bypass === null ? 'inactive' : `${this.bypass.scope} / ${this.bypass.duration} (session only)`}`,
      `- Main agent: ${this.mainAgentId}`,
      `- Registered adapters: ${this.agents.map((agent) => `${agent.id} (${agent.transport}, ${agent.available ? 'available' : 'unavailable'})`).join(', ') || 'none'}`,
      `- Active agents: ${this.activeAgents.length}`,
      `- Hub status: ${HUB_STATE_LABELS[this.hubStatus.state]}`,
      `- Hub authenticated: ${this.deps.hub.isAuthenticated() ? 'yes' : 'no'}`,
      '',
      '## Workspace',
      '',
      `- Folder: ${this.workspaceStatus.folderName ?? 'none open'}`,
      `- Configured (.prometheon/prometheon.yaml): ${this.workspaceStatus.configured ? 'yes' : 'no'}`,
      `- Git repository detected: ${this.workspaceStatus.hasGit ? 'yes' : 'no'}`,
      `- External workspace folder: ${this.workspaceStatus.externalFolder ?? 'none'}`,
      `- Setup skipped: ${this.workspaceStatus.skipped ? 'yes' : 'no'}`,
      '',
      '## Conversation',
      '',
      `- Active conversation: ${this.conversationId ?? 'none'}`,
      `- Messages in conversation: ${this.messages.length}`,
      `- Run in progress: ${this.busy ? (this.currentRunId ?? 'yes') : 'no'}`,
      '',
      'Credentials and message contents are never included in this report.',
      '',
    ];
    return lines.join('\n');
  }

  // ---------- Internos ----------

  private async ensureConversation(): Promise<string> {
    // No Web a conversa mora no Hub, e o id da conversa local não existe lá.
    const web = this.chatType === 'web';
    const chat = web ? this.deps.webChat : this.deps.localChat;
    const existingId = this.conversationId ?? (web ? null : this.deps.local.getActiveConversationId());

    if (existingId !== null) {
      try {
        this.messages = await chat.getMessages(existingId);
        this.conversationId = existingId;
        return existingId;
      } catch {
        // Conversa referenciada não existe mais: cria uma nova abaixo.
      }
    }
    const conversation = await chat.createConversation({ chatType: web ? 'web' : 'local' });
    this.conversationId = conversation.id;
    this.conversationTitle = conversation.title;
    this.messages = conversation.messages;
    return conversation.id;
  }

  private resolveAgentId(candidate: string): string {
    if (this.deps.registry.has(candidate)) {
      return candidate;
    }
    // Perfil de agente também é um principal válido — "Claudio Main" no yaml
    // do projeto sobrevive ao reload em vez de cair no adaptador padrão.
    if (this.agentProfiles.some((summary) => summary.profile.id === candidate)) {
      return candidate;
    }
    // Ninguém escolheu ainda: o orquestrador embutido assume. Cair no adaptador
    // cru perderia nome, papel e prompt logo na primeira conversa — que é
    // justamente quando a diferença entre "um CLI" e "o Prometheon" aparece.
    if (this.agentProfiles.some((summary) => summary.profile.id === DEFAULT_MAIN_AGENT_ID)) {
      return DEFAULT_MAIN_AGENT_ID;
    }
    return this.deps.registry.main.id;
  }

  /**
   * Atualiza a lista de agentes ativos.
   *
   * A chave é a **sessão**, mas o principal é dobrado numa linha só: cada
   * mensagem abre uma sessão nova do mesmo agente, e listá-las todas
   * transformava a lista num histórico de perguntas. Os workers continuam um
   * por sessão — dois deles rodando em paralelo são dois agentes de verdade.
   */
  private upsertActiveAgent(agent: ActiveAgentSummary): void {
    const enriched = this.describeActiveAgent(agent);
    const index =
      enriched.role === 'main'
        ? this.activeAgents.findIndex((item) => item.role === 'main')
        : this.activeAgents.findIndex((item) => item.sessionId === enriched.sessionId);
    if (index === -1) {
      this.activeAgents = [...this.activeAgents, enriched];
      return;
    }
    const next = [...this.activeAgents];
    next[index] = enriched;
    this.activeAgents = next;
  }

  /**
   * Completa o que o adaptador não sabe: quem é o agente no Prometheon (o
   * perfil e a função dele), por qual motor e modelo ele roda. O adaptador
   * conhece só a si mesmo.
   */
  private describeActiveAgent(agent: ActiveAgentSummary): ActiveAgentSummary {
    const summary = agent.role === 'main' ? this.mainAgentProfile : undefined;
    if (summary === undefined) {
      return { ...agent, engine: agent.displayName };
    }
    const roleLabel =
      summary.customRole?.label ?? AGENT_ROLE_LABELS[summary.profile.role];
    const model = this.reportedModel ?? summary.profile.model ?? '';
    return {
      ...agent,
      displayName: summary.profile.name,
      roleLabel,
      engine: summary.providerName ?? agent.displayName,
      ...(model === '' ? {} : { model: modelWithoutWindow(model) }),
    };
  }

  /**
   * Fecha o ciclo de um run: o principal fica ocioso e o que terminou sai da
   * lista. Uma sessão terminada continuar como "trabalhando" é pior do que não
   * mostrar nada — é dizer que há trabalho acontecendo quando não há.
   *
   * O worker que **ainda está rodando** fica. Delegar não bloqueia mais o turno
   * de quem delegou, então o fim do run principal deixou de significar o fim do
   * trabalho: tirá-lo daqui esconderia justamente o agente que a pessoa quer
   * acompanhar enquanto espera.
   */
  private settleActiveAgents(): void {
    this.activeAgents = this.activeAgents
      .filter((agent) => agent.role === 'main' || isRunning(agent.status))
      .map((agent) =>
        agent.role === 'main' ? { ...agent, status: 'idle' as const, task: null } : agent,
      );
  }

  private async persistOrchestration(patch: {
    workMode?: WorkMode;
    autonomy?: Autonomy;
    mainAgent?: string;
  }): Promise<void> {
    const configUri = this.deps.workspace.configUri;
    if (configUri === null) {
      return;
    }
    // `bypass` é descartado de propósito: não é configuração.
    const autonomy = patch.autonomy === 'bypass' ? undefined : patch.autonomy;
    await this.deps.settings.updateOrchestration(configUri, {
      ...(patch.workMode === undefined ? {} : { workMode: patch.workMode }),
      ...(autonomy === undefined ? {} : { autonomy }),
      ...(patch.mainAgent === undefined ? {} : { mainAgent: patch.mainAgent }),
    });
  }

  private async requestBypassGrant(): Promise<BypassGrant | null> {
    const proceed = 'Continue';
    const acknowledged = await vscode.window.showWarningMessage(
      BYPASS_CONFIRMATION_MESSAGE,
      {
        modal: true,
        detail:
          'You will choose a scope and a duration. Bypass is never saved: it expires when the extension restarts or when you switch workspace.',
      },
      proceed,
    );
    if (acknowledged !== proceed) {
      return null;
    }

    const scope = await vscode.window.showQuickPick(
      BYPASS_SCOPES.map((value) => ({ label: BYPASS_SCOPE_LABELS[value], value })),
      { title: 'Bypass scope', placeHolder: 'Where may agents act without approval?' },
    );
    if (scope === undefined) {
      return null;
    }

    const duration = await vscode.window.showQuickPick(
      BYPASS_DURATIONS.map((value) => ({ label: BYPASS_DURATION_LABELS[value], value })),
      { title: 'Bypass duration', placeHolder: 'For how long?' },
    );
    if (duration === undefined) {
      return null;
    }

    const enable = 'Enable bypass';
    const confirmed = await vscode.window.showWarningMessage(
      `Enable bypass for "${scope.label}" during "${duration.label}"?`,
      { modal: true, detail: 'Project policies and the Plan work mode still apply.' },
      enable,
    );
    if (confirmed !== enable) {
      return null;
    }

    return {
      scope: scope.value satisfies BypassScope,
      duration: duration.value satisfies BypassDuration,
      grantedAt: Date.now(),
      workspaceKey: this.deps.workspace.workspaceKey,
    };
  }

  private async expireOneTaskBypass(): Promise<void> {
    if (this.bypass?.duration === 'one-task') {
      await this.disableBypass('Bypass expired: it was granted for one task.');
    }
  }

  private async syncBypassContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'prometheon.bypassActive',
      this.bypass !== null,
    );
  }

  private async onWorkspaceChanged(): Promise<void> {
    const key = this.deps.workspace.workspaceKey;
    if (this.bypass !== null && this.bypass.workspaceKey !== key) {
      await this.disableBypass('Bypass cancelled: the workspace changed.');
    }
    await this.refreshWorkspaceStatus();
    await this.refreshMcp();
    // O `prometheon.yaml` também muda por fora do painel — alguém editando o
    // arquivo, ou um `git pull` trazendo a política do time. O watcher que
    // dispara isto é o mesmo, e o painel precisa refletir o arquivo, não o que
    // ele próprio gravou por último.
    this.deps.graph.invalidate();
    await this.refreshProjectPolicies();
    await this.publish();
  }

  private async refreshWorkspaceStatus(): Promise<void> {
    this.workspaceStatus = await this.deps.workspace.status();
  }

  private async askWorkspaceChoice(): Promise<WorkspaceSetupChoice | undefined> {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'Initialize in current workspace',
          detail: 'Creates .prometheon/ in the open folder.',
          choice: 'current' as const,
        },
        {
          label: 'Choose Prometheon workspace folder',
          detail: 'Point to an existing Prometheon folder.',
          choice: 'external' as const,
        },
        {
          label: 'Continue without shared workspace',
          detail: 'Local Chat keeps working; nothing is written to disk.',
          choice: 'skip' as const,
        },
      ],
      { title: 'Set up Prometheon for this workspace' },
    );
    return picked?.choice;
  }

  private async openSettingsEditor(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:prometheon.prometheon-code',
    );
  }

  private async publish(): Promise<void> {
    if (this.conversationId !== null) {
      // As mensagens vêm do serviço do chat aberto: no Web elas moram no Hub, e
      // pedi-las ao histórico local devolveria uma conversa vazia.
      const service = this.chatType === 'web' ? this.deps.webChat : this.deps.localChat;
      try {
        this.messages = await service.getMessages(this.conversationId);
      } catch {
        this.messages = [];
      }
    }
    await this.refreshSessions();
    this.deps.bus.emit('state.changed', this.snapshot);
  }

  /**
   * Lista as sessões do tipo de chat selecionado, da mais recente para a mais
   * antiga. Sem Hub, o Web Chat simplesmente não tem sessões para mostrar.
   */
  private async refreshSessions(): Promise<void> {
    const service = this.chatType === 'web' ? this.deps.webChat : this.deps.localChat;
    let sessions: readonly ConversationSummary[] = [];
    try {
      sessions = await service.listConversations();
    } catch (error) {
      this.deps.logger.info(`Sessões indisponíveis: ${serializeError(error).message}`);
    }
    this.sessions = [...sessions]
      .filter((session) => session.chatType === this.chatType)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const current = this.sessions.find((session) => session.id === this.conversationId);
    if (current !== undefined) {
      this.conversationTitle = current.title;
    }
  }

  dispose(): void {
    this.stopLoginWatch();
    this.delegationServer?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/**
 * A resposta corresponde ao que foi perguntado: uma entrada por pergunta, na
 * mesma ordem, com rótulos que estavam entre as opções e escolha única onde a
 * pergunta é de escolha única. Texto livre é a única resposta que pode não
 * constar da lista — foi o usuário quem escreveu.
 */
function matchesRequest(
  request: AgentQuestionRequest,
  answers: readonly AgentQuestionAnswer[],
): boolean {
  if (answers.length !== request.questions.length) {
    return false;
  }
  return request.questions.every((question, index) => {
    const answer = answers[index];
    if (answer === undefined || answer.header !== question.header) {
      return false;
    }
    const labels = question.options.map((option) => option.label);
    if (answer.selected.some((choice) => !labels.includes(choice))) {
      return false;
    }
    const values = answerValues(answer);
    if (values.length === 0) {
      return false;
    }
    return question.multiSelect || values.length === 1;
  });
}

const IMAGE_EXTENSIONS: Record<string, ImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Mime derivado da extensão, restrito à lista de formatos aceitos. */
function imageMimeType(fsPath: string): ImageMimeType | null {
  const extension = fsPath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = IMAGE_EXTENSIONS[extension];
  return mimeType !== undefined && IMAGE_MIME_TYPES.includes(mimeType) ? mimeType : null;
}

function baseName(fsPath: string): string {
  return fsPath.split(/[\\/]/).pop() ?? fsPath;
}

/**
 * Cartilha do orquestrador, somada ao prompt dele no modo de equipe.
 *
 * Ela existe porque o modelo não adivinha que tem uma equipe: sem instrução, o
 * CLI faz tudo sozinho e a ferramenta fica parada. O texto diz **quando**
 * delegar (trabalho que um especialista faz melhor) e **como** (uma tarefa
 * autocontida por chamada), e insiste no ponto que mais quebra na prática: o
 * worker não vê a conversa, então a tarefa precisa carregar o contexto.
 */
/**
 * Quantos agentes podem trabalhar ao mesmo tempo nesta máquina, por padrão.
 *
 * Seis é o número dos estudos: com profundidade 1 e três filhos por pai, o
 * pior caso cabe folgado; subir isso sem olhar a memória da máquina é como
 * abrir seis editores e esperar que nenhum trave.
 */
/**
 * Nome de agente como ele chega da ferramenta: sem o papel entre parênteses,
 * sem aspas e sem diferença de caixa ou de espaço.
 */
export function normalizeAgentName(value: string): string {
  return value
    .replace(/\([^)]*\)\s*$/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Quanto `prometheon_collect` espera por um relatório que ainda não chegou.
 *
 * Delegar não espera nada — o worker roda solto e o relatório volta pela
 * conversa, como no `delegate_task` do Hermes e no `ao spawn`. Esta janela é só
 * a cortesia de quem veio buscar um trabalho quase pronto: mais que isto e o
 * cliente MCP corta a chamada.
 */
const DELEGATION_INLINE_WAIT_MS = 30 * 1000;

/** Delegação em andamento, esperando quem venha buscar. */
interface PendingDelegation {
  readonly ticket: string;
  readonly agent: string;
  /** A tarefa, para o orquestrador reconhecer o que já mandou fazer. */
  readonly task: string;
  readonly mode: DelegationMode;
  readonly startedAt: number;
  readonly work: Promise<string>;
}

/** Resultado de uma promessa, quando ela chega dentro do prazo. */
type Settled = { readonly report: string } | { readonly failure: string };

/**
 * Espera a promessa até o prazo. `null` quer dizer "ainda não" — e nunca
 * derruba nada: uma rejeição vira `failure`, para quem chamou decidir.
 */
async function settleWithin(work: Promise<string>, ms: number): Promise<Settled | null> {
  return Promise.race([
    work.then(
      (report): Settled => ({ report }),
      (error: unknown): Settled => ({
        failure: error instanceof Error ? error.message : String(error),
      }),
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Mensagem escrita durante um run, guardada com o que a acompanhava. */
interface QueuedMessage {
  readonly content: string;
  readonly drafts: readonly DraftAttachment[];
  readonly author: 'user' | 'system';
}

/** O agente está em execução — não terminou, não falhou, não foi parado. */
export function isRunning(status: ActiveAgentStatus): boolean {
  return (
    status === 'starting' || status === 'working' || status === 'waiting' || status === 'blocked'
  );
}

const DEFAULT_GLOBAL_CONCURRENCY = 6;

/**
 * Delegações que um único pedido do usuário pode disparar.
 *
 * É o freio mecânico contra o modelo que entra em laço de delegar — o teto de
 * simultâneos não pega esse caso, porque delegar em série, mil vezes, nunca
 * passa de um worker por vez. Quando estoura, a recusa manda concluir com o
 * que já tem.
 */
const MAX_DELEGATIONS_PER_RUN = 12;

/**
 * Tamanho do relatório que ainda cabe na conversa do orquestrador. Acima
 * disto, o texto inteiro vai para arquivo e volta um resumo com o caminho.
 */
const MAX_REPORT_CHARS = 24_000;

/** Um agente delegável como o orquestrador o lê no prompt. */
export interface DelegationRoster {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  /** Quantas tarefas ele aceita ao mesmo tempo. */
  readonly slots: number;
}

/**
 * Cartilha do orquestrador, com a equipe dele dentro.
 *
 * A lista vai **no prompt**, e não atrás de uma ferramenta: um orquestrador que
 * precisa perguntar quem existe antes de cada tarefa gasta uma ida e volta para
 * descobrir o que já era para ele saber — e, quando não pergunta, faz o
 * trabalho sozinho. `prometheon_list_agents` continua existindo para reconferir
 * quando algo muda no meio da sessão; deixou de ser o primeiro passo obrigatório.
 */
export function orchestrationInstruction(agents: readonly DelegationRoster[]): string {
  const roster = agents
    .map(
      (agent) =>
        `- agent: "${agent.name}"\n  role: ${agent.role}\n  use it for: ${agent.description}\n  can run: ${String(agent.slots)} task(s) at a time`,
    )
    .join('\n');

  return [
    'You are the orchestrator of a Prometheon agent team. This is your team right now:',
    '',
    roster,
    '',
    'Delegate with `prometheon_delegate`, passing the name exactly as written above. You do not need to look the team up first — it is right here. Use `prometheon_list_agents` only to re-check after something changes.',
    'Two kinds of work, and the difference matters. Research, reading, analysis and review come back as text: delegate with mode "report" and write the answer yourself — assembling the conclusions is your job. Anything that changes files goes with mode "changes": the agent gets an isolated copy of the repository on its own branch, and you do not edit those files yourself.',
    'When the work is code, you coordinate and do not implement. Split it so that no two agents touch the same function: each one works in a copy of its own and cannot see the others, so overlapping edits meet only at merge time, where they become a conflict for you to resolve.',
    'Your default is to coordinate, not to do. The user picked Agent Team, which is the instruction: work with substance — research, reading through a codebase, tests, review, implementation — goes to a worker, even when you could do it yourself. Nobody has to ask you to delegate.',
    'Do it yourself only when the user tells you to, or when there is no real work in it: a greeting, a question about this conversation, or something you can answer in a line from what you already know. If you decide to keep a substantial task, say in one line that you did and why — never take the work back in silence.',
    'The agent you delegate to does not see this conversation. Put everything it needs in the task, and say exactly what you want back.',
    'To run agents in parallel, make the delegate calls in the same turn instead of waiting for each report. Mind the "can run" limit above: a second task to an agent already at its limit is refused.',
    'Delegating never blocks: it answers with a ticket, not a report, and that is the normal outcome. End your turn telling the user what you delegated. Never sleep, poll, or run shell commands to wait for an agent — when every one of them finishes, their reports come back to you automatically and you continue from there.',
    'One task per call, and the judgement stays with you — you decide what to accept, what to redo, and what to answer.',
  ].join('\n');
}

/** Campo opcional só entra no objeto quando tem valor — nada de `undefined`. */
function optionalText<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Prazo das sondas MCP: rede curta e comando local mais curto ainda. */
const MCP_PROBE_TIMEOUT_MS = 4_000;

const runCommand = promisify(execFile);

/**
 * Sonda um servidor MCP sem executá-lo. HTTP/SSE: uma requisição com prazo —
 * qualquer status de resposta prova que há alguém do outro lado. stdio: o
 * comando precisa existir no PATH; rodá-lo de verdade seria caro e barulhento.
 */
async function probeMcpServer(server: McpServerSummary): Promise<McpProbeStatus> {
  if (server.transport === 'stdio') {
    if (server.command === undefined || server.command === '') {
      return 'missing';
    }
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
      await runCommand(finder, [server.command], { timeout: MCP_PROBE_TIMEOUT_MS });
      return 'ok';
    } catch {
      return 'missing';
    }
  }

  if (server.url === undefined || server.url === '') {
    return 'missing';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, MCP_PROBE_TIMEOUT_MS);
  try {
    await fetch(server.url, { method: 'GET', signal: controller.signal });
    return 'ok';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
