import * as vscode from 'vscode';
import { AgentProfileService } from './agents/AgentProfileService';
import { AgentProfileStore } from './agents/AgentProfileStore';
import { AgentRegistry } from './agents/AgentRegistry';
import { ClaudeCodeAgentAdapter } from './agents/ClaudeCodeAgentAdapter';
import { MockAgentAdapter } from './agents/MockAgentAdapter';
import { LocalChatService } from './chat/LocalChatService';
import { WebChatService } from './chat/WebChatService';
import { registerCommands } from './commands';
import { CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID } from './constants';
import { PrometheonCore } from './core/PrometheonCore';
import { EventBus } from './core/EventBus';
import { DisabledHubClient } from './hub/DisabledHubClient';
import { initializeLanguage } from './i18n';
import { LiveHubClient } from './hub/LiveHubClient';
import { Logger } from './logger';
import { PermissionService } from './permissions/PermissionService';
import { SpeechService } from './speech/SpeechService';
import { ClaudeCodeAdapter } from './providers/ClaudeCodeAdapter';
import { ProviderProfileService } from './providers/ProviderProfileService';
import { ProviderProfileStore } from './providers/ProviderProfileStore';
import { UsageTracker } from './providers/UsageTracker';
import { LocalStateStore } from './storage/LocalStateStore';
import { SecretStore } from './storage/SecretStore';
import { SettingsStore } from './storage/SettingsStore';
import { McpConfigStore } from './workspace/McpConfigStore';
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
  readonly speech: SpeechService;
  readonly profiles: ProviderProfileService;
  readonly agentProfiles: AgentProfileService;
  readonly mcp: McpConfigStore;
  readonly usage: UsageTracker;
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

  // Idioma antes de tudo: qualquer texto criado daqui para baixo já sai
  // traduzido, inclusive o HTML da webview.
  initializeLanguage(
    context.extensionPath,
    vscode.workspace.getConfiguration('prometheon').get<string>('language'),
  );

  const localState = new LocalStateStore(context);
  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsStore(logger);
  const workspace = new WorkspaceService(settings, localState);
  const permissions = new PermissionService(logger);
  const initializer = new WorkspaceInitializer(settings, permissions, logger);
  // Nenhum motor de voz registrado ainda: a interface mostra o microfone
  // desabilitado com o motivo, e o serviço aceita um provider quando existir.
  const speech = new SpeechService(logger);

  // Contas locais dos CLIs. O Claude Code é o primeiro adaptador; os demais
  // entram no mesmo registro sem tocar no núcleo.
  const profileStore = new ProviderProfileStore(logger);
  const profiles = new ProviderProfileService(profileStore, logger);
  profiles.register(new ClaudeCodeAdapter(logger));
  const usage = new UsageTracker(localState);

  // Agent Profiles vivem em `~/.prometheon/agent-profiles.json` e sempre
  // apontam para uma dessas contas; MCP é configuração do projeto.
  const agentProfiles = new AgentProfileService(new AgentProfileStore(logger), profiles, logger);
  const mcp = new McpConfigStore(workspace, logger);

  const registry = new AgentRegistry();

  // O mock é registrado primeiro **de propósito**: o registro promove a
  // principal o primeiro que chega, e o principal precisa ser algo que sempre
  // responde. Sem CLI instalado ou sem conta configurada, o Claude Code recusa
  // de saída — e o painel ficaria mudo na primeira mensagem, num erro que
  // parece defeito do Prometheon e é ausência de uma dependência externa.
  registry.register(new MockAgentAdapter());

  const claudeCode = new ClaudeCodeAgentAdapter(logger, async () => {
    // O primeiro perfil habilitado do Claude Code. A escolha é previsível e não
    // depende de estado guardado noutro lugar que possa divergir.
    const available = await profiles.list();

    return available.find((profile) => profile.providerId === 'claude-code' && profile.enabled);
  });

  registry.register(claudeCode);

  // A promoção acontece fora do caminho de ativação: descobrir se o CLI existe
  // custa um processo, e a extensão não deve demorar a abrir por causa disso.
  // Até a resposta chegar, o mock atende — e quem tem o CLI instalado nem vê a
  // troca, que leva alguns milissegundos.
  void claudeCode
    .isAvailable()
    .then((available) => {
      if (available) {
        registry.setMain(claudeCode.id);
        logger.info('Claude Code disponível: agente principal.');
        return;
      }

      logger.info('Claude Code indisponível (CLI ausente ou sem conta): seguindo com o mock.');
    })
    .catch((error: unknown) => {
      logger.error(error instanceof Error ? error : String(error));
    });

  // Com uma URL configurada, a extensão fala com o Hub de verdade; sem ela,
  // continua estritamente local. A escolha é do usuário, e é explícita.
  const configuredHubUrl = vscode.workspace
    .getConfiguration('prometheon')
    .get<string>('hub.url', '')
    .trim();
  const hub =
    configuredHubUrl === '' ? new DisabledHubClient() : new LiveHubClient(secrets, logger, extensionVersion);
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
    speech,
    profiles,
    agentProfiles,
    mcp,
    usage,
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
    bus.on('attachments.added', (attachments) =>
      provider.post({ type: 'attachments.added', payload: { attachments } }),
    ),
    bus.on('activity.changed', (payload) => provider.post({ type: 'activity', payload })),
    bus.on('language.changed', () => {
      provider.refresh();
      provider.post({ type: 'state.snapshot', payload: core.snapshot });
    }),
    bus.on('question.ask', (payload) => provider.post({ type: 'question.ask', payload })),
    bus.on('question.close', (requestId) =>
      provider.post({ type: 'question.close', payload: { requestId } }),
    ),
    bus.on('speech.transcript', (text) =>
      provider.post({ type: 'speech.transcript', payload: { text } }),
    ),
    bus.on('notification', (payload) => provider.post({ type: 'notification', payload })),
  );

  // O mesmo provider atende os dois locais: Activity Bar e Secondary Side Bar
  // (onde fica o chat nativo do VS Code). Ver PrometheonViewProvider.
  // `retainContextWhenHidden` mantém o rascunho — texto e imagens ainda não
  // enviadas — quando o painel é escondido; sem isso a webview é destruída.
  const viewOptions = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, viewOptions),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_SECONDARY_ID, provider, viewOptions),
    ...registerCommands({ core, provider, logger, secrets, local: localState, profiles, agentProfiles }),
  );

  await core.initialize();
  logger.info(`Prometheon ${extensionVersion} ativo.`);

  return {
    core,
    registry,
    localChat,
    webChat,
    permissions,
    speech,
    profiles,
    agentProfiles,
    mcp,
    usage,
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
