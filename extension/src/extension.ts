import * as vscode from 'vscode';
import { AgentRegistry } from './agents/AgentRegistry';
import { MockAgentAdapter } from './agents/MockAgentAdapter';
import { LocalChatService } from './chat/LocalChatService';
import { WebChatService } from './chat/WebChatService';
import { registerCommands } from './commands';
import { CHAT_VIEW_ID } from './constants';
import { PrometheonCore } from './core/PrometheonCore';
import { EventBus } from './core/EventBus';
import { DisabledHubClient } from './hub/DisabledHubClient';
import { Logger } from './logger';
import { PermissionService } from './permissions/PermissionService';
import { LocalStateStore } from './storage/LocalStateStore';
import { SecretStore } from './storage/SecretStore';
import { SettingsStore } from './storage/SettingsStore';
import { WorkspaceInitializer } from './workspace/WorkspaceInitializer';
import { WorkspaceService } from './workspace/WorkspaceService';
import { PrometheonViewProvider } from './views/PrometheonViewProvider';
import { BypassStatusBar } from './views/BypassStatusBar';

/** Superfície exposta para os testes de integração. */
export interface PrometheonApi {
  readonly core: PrometheonCore;
  readonly registry: AgentRegistry;
  readonly localChat: LocalChatService;
  readonly webChat: WebChatService;
  readonly permissions: PermissionService;
  readonly localState: LocalStateStore;
  readonly secrets: SecretStore;
  readonly settings: SettingsStore;
  readonly workspace: WorkspaceService;
  readonly initializer: WorkspaceInitializer;
}

export async function activate(context: vscode.ExtensionContext): Promise<PrometheonApi> {
  const logger = new Logger();
  const bus = new EventBus();
  const extensionVersion = String(context.extension.packageJSON.version ?? '0.0.0');

  const localState = new LocalStateStore(context);
  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsStore(logger);
  const workspace = new WorkspaceService(settings, localState);
  const permissions = new PermissionService(logger);
  const initializer = new WorkspaceInitializer(settings, permissions, logger);

  const registry = new AgentRegistry();
  registry.register(new MockAgentAdapter());

  const hub = new DisabledHubClient();
  const localChat = new LocalChatService(localState, registry, logger);
  const webChat = new WebChatService(hub);

  const core = new PrometheonCore({
    extensionVersion,
    bus,
    logger,
    registry,
    localChat,
    webChat,
    hub,
    permissions,
    local: localState,
    settings,
    workspace,
    initializer,
  });

  const provider = new PrometheonViewProvider(context.extensionUri, core, logger);
  const statusBar = new BypassStatusBar();

  context.subscriptions.push(logger, bus, workspace, core, provider, statusBar);

  // Ponte única entre o barramento interno e a interface.
  context.subscriptions.push(
    bus.on('state.changed', (state) => {
      provider.post({ type: 'state.snapshot', payload: state });
      statusBar.render(state.bypass);
    }),
    bus.on('chat.event', (payload) => provider.post({ type: 'chat.event', payload })),
    bus.on('chat.error', (payload) => provider.post({ type: 'chat.error', payload })),
    bus.on('agents.updated', (payload) => provider.post({ type: 'agents.updated', payload })),
    bus.on('hub.status', (payload) => provider.post({ type: 'hub.status', payload })),
    bus.on('notification', (payload) => provider.post({ type: 'notification', payload })),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider),
    ...registerCommands({ core, provider, logger }),
  );

  await core.initialize();
  logger.info(`Prometheon ${extensionVersion} ativo.`);

  return {
    core,
    registry,
    localChat,
    webChat,
    permissions,
    localState,
    secrets,
    settings,
    workspace,
    initializer,
  };
}

export function deactivate(): void {
  // Tudo é descartado por context.subscriptions. O bypass morre com o processo,
  // que é exatamente o comportamento exigido: ele nunca sobrevive a um reinício.
}
