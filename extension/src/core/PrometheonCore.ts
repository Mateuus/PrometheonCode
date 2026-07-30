import * as vscode from 'vscode';
import type { AgentRegistry } from '../agents/AgentRegistry';
import type { LocalChatService } from '../chat/LocalChatService';
import type { WebChatService } from '../chat/WebChatService';
import type { ChatMessage } from '../chat/types';
import type { HubClient } from '../hub/types';
import type { Logger } from '../logger';
import type { PermissionService } from '../permissions/PermissionService';
import type { LocalStateStore } from '../storage/LocalStateStore';
import type { SettingsStore } from '../storage/SettingsStore';
import type { WorkspaceInitializer } from '../workspace/WorkspaceInitializer';
import type { WorkspaceService } from '../workspace/WorkspaceService';
import { HubNotConfiguredError, serializeError } from '../utils/errors';
import { parseHubUrl } from '../hub/HubClient';
import type { WebviewToExtensionMessage, WorkspaceSetupChoice } from '../views/messages';
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
  type HubConnectionStatus,
  type WorkMode,
  type WorkspaceStatus,
} from './types';

export interface PrometheonCoreDeps {
  readonly extensionVersion: string;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly registry: AgentRegistry;
  readonly localChat: LocalChatService;
  readonly webChat: WebChatService;
  readonly hub: HubClient;
  readonly permissions: PermissionService;
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
  private messages: readonly ChatMessage[] = [];
  private busy = false;
  private currentRunId: string | null = null;
  private hubStatus: HubConnectionStatus = { state: 'local-only' };
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
      workspace: this.workspaceStatus,
      conversationId: this.conversationId,
      messages: this.messages,
      busy: this.busy,
    };
  }

  get isBypassActive(): boolean {
    return this.bypass !== null;
  }

  async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ui.ready':
        await this.refreshWorkspaceStatus();
        await this.publish();
        return;
      case 'chat.send':
        await this.send(message.payload.content);
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
      case 'settings.open':
        await this.openSettings();
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

  async send(content: string): Promise<void> {
    if (this.chatType === 'web') {
      // O contrato do Web Chat já falha por si; aqui só evitamos iniciar o run.
      this.deps.bus.emit('chat.error', serializeError(new HubNotConfiguredError()));
      return;
    }
    if (this.busy) {
      return;
    }

    const conversationId = await this.ensureConversation();
    this.busy = true;
    await this.publish();

    try {
      for await (const event of this.deps.localChat.sendMessage({
        conversationId,
        content,
        workMode: this.workMode,
        autonomy: this.autonomy,
        mainAgentId: this.mainAgentId,
      })) {
        if (event.type === 'agent.status') {
          this.upsertActiveAgent(event.agent);
          this.deps.bus.emit('agents.updated', this.activeAgents);
          continue;
        }
        if (event.type === 'run.started') {
          this.currentRunId = event.runId;
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
    this.activeAgents = [];
    await this.setChatType('local');
    await this.publish();
  }

  async clearLocalChat(): Promise<void> {
    if (this.conversationId === null) {
      return;
    }
    await this.deps.localChat.clearConversation(this.conversationId);
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
    await this.publish();
  }

  async initializeWorkspace(): Promise<void> {
    await this.configureWorkspace('current');
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

  private async openSettings(): Promise<void> {
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
    this.deps.bus.emit('state.changed', this.snapshot);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
