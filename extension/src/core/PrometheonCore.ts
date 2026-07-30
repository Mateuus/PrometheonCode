import * as vscode from 'vscode';
import type { AgentProfileService } from '../agents/AgentProfileService';
import type { AgentRegistry } from '../agents/AgentRegistry';
import type { LocalChatService } from '../chat/LocalChatService';
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
import type { ProviderProfileService } from '../providers/ProviderProfileService';
import type { UsageTracker } from '../providers/UsageTracker';
import type { LocalStateStore } from '../storage/LocalStateStore';
import type { SettingsStore } from '../storage/SettingsStore';
import type { McpConfigStore } from '../workspace/McpConfigStore';
import type { WorkspaceInitializer } from '../workspace/WorkspaceInitializer';
import type { WorkspaceService } from '../workspace/WorkspaceService';
import { HubNotConfiguredError, serializeError } from '../utils/errors';
import { newId } from '../utils/ids';
import { parseHubUrl } from '../hub/HubClient';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  type AgentProfileDraft,
  type DraftAttachment,
  type WebviewToExtensionMessage,
  type WorkspaceSetupChoice,
} from '../views/messages';
import type { EventBus } from './EventBus';
import type { PrometheonViewState } from './state';
import {
  AUTONOMY_DESCRIPTIONS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  BYPASS_CONFIRMATION_MESSAGE,
  BYPASS_DURATIONS,
  BYPASS_DURATION_LABELS,
  BYPASS_SCOPES,
  BYPASS_SCOPE_LABELS,
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
  type AgentProfileSummary,
  type HubConnectionStatus,
  type McpServerDraft,
  type McpStatus,
  type ProviderOption,
  type SpeechStatus,
  type WorkMode,
  type WorkspaceStatus,
} from './types';

/** Motivo mostrado na interface enquanto nenhum motor de voz está registrado. */
const NO_SPEECH_ENGINE = 'No speech engine configured yet.';

const IDLE_ACTIVITY: ActivityStatus = { phase: 'idle', label: '', startedAt: null };

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
  readonly mcp: McpConfigStore;
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
  private hubStatus: HubConnectionStatus = { state: 'local-only' };
  private speechStatus: SpeechStatus = {
    available: false,
    state: 'idle',
    detail: NO_SPEECH_ENGINE,
  };
  private accounts: readonly AccountSummary[] = [];
  private agentProfiles: readonly AgentProfileSummary[] = [];
  private mcpStatus: McpStatus = {
    available: false,
    exists: false,
    file: null,
    servers: [],
    problems: [],
    message: 'MCP servers are configured in .mcp.json at the root of the open folder.',
  };
  private activity: ActivityStatus = IDLE_ACTIVITY;
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
    await this.refreshSpeechStatus();
    await this.refreshAccounts();
    await this.refreshMcp();
    this.workspaceStatus = await this.deps.workspace.status();
    await this.ensureConversation();
    await this.publish();
  }

  get snapshot(): PrometheonViewState {
    return {
      extensionVersion: this.deps.extensionVersion,
      chatType: this.chatType,
      workMode: this.workMode,
      autonomy: this.autonomy,
      bypass: this.bypass,
      mainAgentId: this.mainAgentId,
      agents: this.agents,
      activeAgents: this.activeAgents,
      hub: this.hubStatus,
      speech: this.speechStatus,
      accounts: this.accounts,
      providers: this.providerOptions,
      agentProfiles: this.agentProfiles,
      mcp: this.mcpStatus,
      activity: this.activity,
      workspace: this.workspaceStatus,
      conversationId: this.conversationId,
      conversationTitle: this.conversationTitle,
      messages: this.messages,
      sessions: this.sessions,
      busy: this.busy,
    };
  }

  get isBypassActive(): boolean {
    return this.bypass !== null;
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
      case 'chat.attachImages':
        await this.attachImages();
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
      case 'settings.setWorkMode':
        await this.setWorkMode(message.payload.mode);
        return;
      case 'settings.setAutonomy':
        await this.setAutonomy(message.payload.autonomy);
        return;
      case 'settings.selectMainAgent':
        await this.setMainAgent(message.payload.agentId);
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
      case 'hub.connect.request':
        await this.connectHub();
        return;
    }
  }

  // ---------- Chat ----------

  async send(content: string, drafts: readonly DraftAttachment[] = []): Promise<void> {
    if (this.chatType === 'web') {
      // O contrato do Web Chat já falha por si; aqui só evitamos iniciar o run.
      this.deps.bus.emit('chat.error', serializeError(new HubNotConfiguredError()));
      return;
    }
    if (this.busy) {
      return;
    }

    const attachments = drafts.map<ImageAttachment>((draft) => ({ id: newId('att'), ...draft }));
    const conversationId = await this.ensureConversation();
    this.busy = true;
    this.setActivity('sending', 'Sending…');
    await this.publish();

    try {
      for await (const event of this.deps.localChat.sendMessage({
        conversationId,
        content,
        ...(attachments.length === 0 ? {} : { attachments }),
        workMode: this.workMode,
        autonomy: this.autonomy,
        mainAgentId: this.mainAgentId,
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
        if (event.type === 'message.completed' && event.usage !== undefined) {
          // O uso é contabilizado no perfil que executou, não no agente.
          await this.deps.usage.record(this.usageProfileId(), event.usage);
          await this.refreshAccounts();
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
      this.busy = false;
      this.currentRunId = null;
      this.activity = IDLE_ACTIVITY;
      this.deps.bus.emit('activity.changed', this.activity);
      await this.expireOneTaskBypass();
      await this.publish();
    }
  }

  async cancel(runId: string): Promise<void> {
    await this.deps.localChat.cancel(runId);
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
    const session = (await this.deps.localChat.listConversations()).find(
      (item) => item.id === conversationId,
    );
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
    await this.publish();
  }

  async setChatType(chatType: ChatType): Promise<void> {
    this.chatType = chatType;
    await this.deps.local.setChatType(chatType);

    if (chatType === 'web') {
      // Mostra o estado real do Hub sem tentar conectar nem simular conexão.
      this.hubStatus = this.deps.hub.getStatus();
      this.deps.bus.emit('hub.status', this.hubStatus);
    }
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
  async createAccount(name: string, providerId: string): Promise<void> {
    try {
      const profile = await this.deps.profiles.create({ name, providerId });
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

  // ---------- Agent Profiles ----------

  /**
   * Relê os agentes e resolve o binding contra as contas conhecidas. Um agente
   * cuja conta sumiu ganha um aviso: nunca é reapontado para outro perfil.
   */
  async refreshAgentProfiles(): Promise<void> {
    try {
      this.agentProfiles = await this.deps.agentProfiles.summaries(this.accounts);
    } catch (error) {
      this.deps.logger.error(`Falha ao ler os Agent Profiles: ${serializeError(error).message}`);
      this.agentProfiles = [];
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
    this.speechStatus = {
      available,
      state: this.deps.speech.state,
      ...(available ? {} : { detail: NO_SPEECH_ENGINE }),
    };
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
    const existingId = this.conversationId ?? this.deps.local.getActiveConversationId();
    if (existingId !== null) {
      try {
        this.messages = await this.deps.localChat.getMessages(existingId);
        this.conversationId = existingId;
        return existingId;
      } catch {
        // Conversa referenciada não existe mais: cria uma nova abaixo.
      }
    }
    const conversation = await this.deps.localChat.createConversation({ chatType: 'local' });
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
      try {
        this.messages = await this.deps.localChat.getMessages(this.conversationId);
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
