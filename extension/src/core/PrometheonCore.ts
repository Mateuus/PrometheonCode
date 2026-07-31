import * as vscode from 'vscode';
import type { AgentProfileService } from '../agents/AgentProfileService';
import type { AgentRegistry } from '../agents/AgentRegistry';
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
import { parseHubUrl } from '../hub/HubClient';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  type AgentProfileDraft,
  type CustomRoleDraft,
  type DraftAttachment,
  type GitPatch,
  type GraphPatch,
  type WebviewToExtensionMessage,
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
  WORK_MODE_LABELS,
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
  type AgentProfileSummary,
  type CustomAgentRole,
  type GitStatus,
  type GraphStatus,
  type HubConnectionStatus,
  type McpServerDraft,
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
  private conversationId: string | null = null;
  private conversationTitle: string = UNTITLED;
  private messages: readonly ChatMessage[] = [];
  private sessions: readonly ConversationSummary[] = [];
  private busy = false;
  private currentRunId: string | null = null;
  /** Pergunta aberta do agente; some quando é respondida ou o run acaba. */
  private pendingQuestion: AgentQuestionRequest | null = null;
  private hubStatus: HubConnectionStatus = { state: 'local-only' };
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
    await this.refreshMcp();
    await this.refreshProjectPolicies(config);
    this.workspaceStatus = await this.deps.workspace.status();
    await this.ensureConversation();
    await this.publish();
  }

  get snapshot(): PrometheonViewState {
    return {
      extensionVersion: this.deps.extensionVersion,
      language: languageChoice(),
      chatType: this.chatType,
      workMode: this.workMode,
      autonomy: this.autonomy,
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
      mcp: this.mcpStatus,
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
      case 'skills.refresh':
        await this.refreshSkills();
        await this.publish();
        return;
      case 'skills.open':
        await this.openSkill(message.payload.name);
        return;
      case 'mcp.refresh':
        await this.refreshMcp();
        await this.publish();
        return;
      case 'mcp.import':
        await this.importMcpServers();
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
      case 'graph.rebuild':
        await this.rebuildGraph();
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

  async send(content: string, drafts: readonly DraftAttachment[] = []): Promise<void> {
    if (this.busy) {
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
      for await (const event of chat.sendMessage({
        conversationId,
        content,
        ...(attachments.length === 0 ? {} : { attachments }),
        workMode: this.workMode,
        // A mais restritiva entre o composer, o perfil e o teto das skills
        // carregadas — uma skill que lida com segredo prende o run em manual.
        autonomy: this.effectiveAutonomyForRun(),
        mainAgentId: this.mainAgentId,
        ...(model === undefined || model === '' ? {} : { model }),
        ...(systemPrompt === '' ? {} : { systemPrompt }),
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
      this.activity = IDLE_ACTIVITY;
      this.deps.bus.emit('activity.changed', this.activity);
      await this.expireOneTaskBypass();
      await this.publish();
    }

    await this.maybeAutoCompact();
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
    if (!this.deps.registry.has(agentId)) {
      this.deps.bus.emit('notification', {
        level: 'warning',
        message: `Unknown agent: ${agentId}`,
      });
      return;
    }
    this.mainAgentId = agentId;
    this.deps.registry.setMain(agentId);
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

  systemPromptForMainAgent(): string {
    const summary = this.mainAgentProfile;
    if (summary === undefined) {
      return '';
    }

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
    // O login roda num terminal e termina quando o usuário quiser; o estado é
    // relido quando ele reabrir o painel de contas.
    this.deps.bus.emit('notification', {
      level: 'info',
      message: 'Finish the sign-in in the terminal, then refresh the accounts panel.',
    });
  }

  async logoutAccount(profileId: string): Promise<void> {
    const profile = await this.deps.profiles.require(profileId);
    const confirm = 'Sign out';
    const answer = await vscode.window.showWarningMessage(
      `Sign out of "${profile.name}"?`,
      { modal: true, detail: 'The isolated configuration directory is kept.' },
      confirm,
    );
    if (answer !== confirm) {
      return;
    }
    await this.deps.profiles.logout(profileId);
    await this.refreshAccounts();
    await this.publish();
  }

  /** Remove o perfil da lista. As credenciais em disco não são tocadas. */
  async removeAccount(profileId: string): Promise<void> {
    const profile = await this.deps.profiles.require(profileId);
    // Agentes vinculados não são reapontados para outra conta: eles passam a
    // avisar que o binding quebrou, e é isso que o diálogo antecipa.
    const bound = this.agentProfiles.filter(
      (summary) => summary.profile.providerProfileId === profileId,
    );
    const boundDetail =
      bound.length === 0
        ? ''
        : ` ${bound.length} agent profile(s) still point to it (${bound.map((summary) => summary.profile.name).join(', ')}) and will stop until you bind them to another account.`;
    const confirm = 'Remove profile';
    const answer = await vscode.window.showWarningMessage(
      `Remove the profile "${profile.name}" from Prometheon?`,
      {
        modal: true,
        detail: `The credentials in ${profile.configDirectory} are left untouched — delete that folder yourself if you also want to drop the sign-in.${boundDetail}`,
      },
      confirm,
    );
    if (answer !== confirm) {
      return;
    }
    await this.deps.profiles.remove(profileId);
    await this.refreshAccounts();
    await this.publish();
  }

  // ---------- Atividade ----------

  private setActivity(phase: ActivityStatus['phase'], label: string): void {
    const agent = this.agents.find((item) => item.id === this.mainAgentId);
    const account = this.accounts.find((item) => item.profileId === this.usageProfileId());
    const detail = [
      agent?.displayName ?? this.mainAgentId,
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

  async connectHub(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('prometheon');
    const configured = configuration.get<string>('hub.url', '').trim();

    const url =
      configured === ''
        ? await vscode.window.showInputBox({
            title: 'Connect to Prometheon Hub',
            prompt: 'Hub base URL. HTTPS is required outside localhost. Do not paste tokens here.',
            placeHolder: 'https://hub.example.com',
            ignoreFocusOut: true,
            validateInput: (value) => {
              try {
                parseHubUrl(value);
                return null;
              } catch (error) {
                return error instanceof Error ? error.message : 'URL inválida.';
              }
            },
          })
        : configured;

    if (url === undefined || url.trim() === '') {
      return;
    }

    try {
      const parsed = parseHubUrl(url);
      await configuration.update('hub.url', parsed.toString(), vscode.ConfigurationTarget.Global);
      this.hubStatus = { state: 'connecting' };
      this.deps.bus.emit('hub.status', this.hubStatus);
      await this.deps.hub.connect({ url: parsed.toString() });
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
   * Sai do Hub nesta máquina.
   *
   * Pede confirmação porque entrar de novo custa o device flow inteiro — e
   * porque a frase precisa dizer o que **não** acontece: o dispositivo continua
   * autorizado do lado do Hub até ser revogado na conta.
   */
  async signOutHub(): Promise<void> {
    const confirm = 'Sign out';
    const choice = await vscode.window.showWarningMessage(
      'Sign out of Prometheon Hub on this machine?',
      {
        modal: true,
        detail:
          'The device credential is erased here. The device stays authorized in the Hub until you revoke it in your account.',
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
    return this.deps.registry.has(candidate) ? candidate : this.deps.registry.main.id;
  }

  private upsertActiveAgent(agent: ActiveAgentSummary): void {
    const index = this.activeAgents.findIndex((item) => item.sessionId === agent.sessionId);
    if (index === -1) {
      this.activeAgents = [...this.activeAgents, agent];
      return;
    }
    const next = [...this.activeAgents];
    next[index] = agent;
    this.activeAgents = next;
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

/** Campo opcional só entra no objeto quando tem valor — nada de `undefined`. */
function optionalText<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
