import * as vscode from 'vscode';
import { AgentProfileService } from './agents/AgentProfileService';
import { AgentProfileStore } from './agents/AgentProfileStore';
import { AgentRoleService } from './agents/AgentRoleService';
import { AgentRoleStore } from './agents/AgentRoleStore';
import { SkillRegistry } from './skills/SkillRegistry';
import { ModelCatalog } from './providers/ModelCatalog';
import { AgentRegistry } from './agents/AgentRegistry';
import { ClaudeCodeAgentAdapter } from './agents/ClaudeCodeAgentAdapter';
import { CodexAgentAdapter } from './agents/CodexAgentAdapter';
import { MockAgentAdapter } from './agents/MockAgentAdapter';
import { LocalChatService } from './chat/LocalChatService';
import {
  ToolOutputContentProvider,
  ToolOutputStore,
  TOOL_OUTPUT_SCHEME,
} from './chat/ToolOutputStore';
import { WebChatService } from './chat/WebChatService';
import { registerCommands } from './commands';
import { CHAT_VIEW_ID, CHAT_VIEW_SECONDARY_ID } from './constants';
import { PrometheonCore } from './core/PrometheonCore';
import { EventBus } from './core/EventBus';
import { initializeLanguage } from './i18n';
import { LiveHubClient } from './hub/LiveHubClient';
import { Logger } from './logger';
import { PermissionService } from './permissions/PermissionService';
import { LocalWhisperProvider } from './speech/LocalWhisperProvider';
import { SpeechEnvironment } from './speech/SpeechEnvironment';
import { SpeechService } from './speech/SpeechService';
import { ClaudeCodeAdapter } from './providers/ClaudeCodeAdapter';
import { CodexAdapter } from './providers/CodexAdapter';
import { ProviderProfileService } from './providers/ProviderProfileService';
import { ProviderProfileStore } from './providers/ProviderProfileStore';
import { UsageTracker } from './providers/UsageTracker';
import { LocalStateStore } from './storage/LocalStateStore';
import { SecretStore } from './storage/SecretStore';
import { SettingsStore } from './storage/SettingsStore';
import { McpConfigStore } from './workspace/McpConfigStore';
import { GraphService } from './workspace/GraphService';
import { GitPolicyService } from './workspace/GitPolicyService';
import { WorkspaceInitializer } from './workspace/WorkspaceInitializer';
import { WorktreeService } from './workspace/WorktreeService';
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
  readonly agentRoles: AgentRoleService;
  readonly skills: SkillRegistry;
  readonly modelCatalog: ModelCatalog;
  readonly mcp: McpConfigStore;
  readonly usage: UsageTracker;
  readonly localState: LocalStateStore;
  readonly secrets: SecretStore;
  readonly settings: SettingsStore;
  readonly workspace: WorkspaceService;
  readonly initializer: WorkspaceInitializer;
  readonly worktrees: WorktreeService;
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
  const worktrees = new WorktreeService(logger);
  // Ditado por voz, inteiramente local: um processo Python com faster-whisper,
  // usando a GPU da máquina quando houver. O áudio não sai daqui.
  //
  // O ambiente Python é preparado no primeiro uso, não agora: são centenas de
  // megabytes, e quem nunca clicar no microfone não deve pagar por eles.
  const speech = new SpeechService(logger);
  const speechEnvironment = new SpeechEnvironment(context, logger);
  const speechProvider = new LocalWhisperProvider(
    {
      resolvePython: () => speechEnvironment.ensure(),
      canUse: () => speechEnvironment.canUse(),
      scriptPath: vscode.Uri.joinPath(
        context.extensionUri,
        'media',
        'speech',
        'prometheon_speech.py',
      ).fsPath,
      language: () =>
        vscode.workspace.getConfiguration('prometheon').get<string>('speech.language') ?? 'auto',
    },
    logger,
  );
  context.subscriptions.push(speechProvider);
  void speech.register(speechProvider);
  // O texto vai para a webview enquanto a pessoa fala, e não só no fim.
  speech.onPartial((text) => bus.emit('speech.partial', text));

  // Contas locais dos CLIs. O Claude Code é o primeiro adaptador; os demais
  // entram no mesmo registro sem tocar no núcleo.
  const profileStore = new ProviderProfileStore(logger);
  const profiles = new ProviderProfileService(profileStore, logger);
  profiles.register(new ClaudeCodeAdapter(logger));
  profiles.register(new CodexAdapter(logger));
  const usage = new UsageTracker(localState);

  // Agent Profiles vivem em `~/.prometheon/agent-profiles.json` e sempre
  // apontam para uma dessas contas; MCP é configuração do projeto.
  const agentProfiles = new AgentProfileService(new AgentProfileStore(logger), profiles, logger);
  const skills = new SkillRegistry(workspace, logger);
  const modelCatalog = new ModelCatalog(context.extensionUri, logger);
  const mcp = new McpConfigStore(workspace, logger);
  // Grafo e política de commit são do projeto, não desta máquina: os dois leem
  // o `prometheon.yaml` e escrevem artefatos que vão para o Git.
  const graph = new GraphService(workspace, logger);
  const gitPolicy = new GitPolicyService(workspace, logger);

  const registry = new AgentRegistry();

  // O mock existe **só para os testes**, que não podem depender de um binário
  // externo nem de uma conta configurada na máquina de quem roda a suíte. Ele
  // entra primeiro para virar o principal: o registro promove quem chega antes.
  //
  // Fora dos testes não é registrado. Um agente de mentira na lista convida a
  // ser escolhido por engano, e aí o Prometheon responde com texto inventado
  // sem tocar em arquivo nenhum — parecendo funcionar, que é a pior forma de
  // não funcionar.
  const testing = context.extensionMode === vscode.ExtensionMode.Test;

  if (testing) {
    registry.register(new MockAgentAdapter());
  }

  const claudeCode = new ClaudeCodeAgentAdapter(logger, async () => {
    // O primeiro perfil habilitado do Claude Code. A escolha é previsível e não
    // depende de estado guardado noutro lugar que possa divergir.
    const available = await profiles.list();

    return available.find((profile) => profile.providerId === 'claude-code' && profile.enabled);
  });

  registry.register(claudeCode);

  // Mesmo desenho do Claude Code: o agente pega o primeiro perfil habilitado
  // do provedor, e a conta escolhida por ele é a que executa.
  registry.register(
    new CodexAgentAdapter(logger, async () => {
      const available = await profiles.list();

      return available.find((profile) => profile.providerId === 'codex-cli' && profile.enabled);
    }),
  );

  // O cliente do Hub existe sempre — conectar é decisão do usuário, tomada no
  // botão de entrar, não na configuração. Sem credencial guardada a extensão
  // continua estritamente local e nenhuma conexão é aberta.
  const hub = new LiveHubClient(secrets, logger, extensionVersion);
  // A saída integral das ferramentas fica no armazenamento da extensão para
  // este workspace: fora do projeto do usuário, fora do Git, e apagada sozinha
  // depois de uma semana.
  const toolOutputs = new ToolOutputStore(context.storageUri, logger);
  void toolOutputs.prune();

  const localChat = new LocalChatService(localState, registry, logger, toolOutputs);
  const webChat = new WebChatService(hub);
  // Depende do Hub, então nasce depois dele: o escopo de equipe é o próprio
  // Hub, e sem conexão o serviço oferece apenas projeto e máquina.
  const agentRoles = new AgentRoleService(new AgentRoleStore(workspace, logger), hub, logger);

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
    agentRoles,
    skills,
    modelCatalog,
    mcp,
    graph,
    gitPolicy,
    toolOutputs,
    usage,
    local: localState,
    settings,
    workspace,
    initializer,
    worktrees,
  });

  const provider = new PrometheonViewProvider(context.extensionUri, core, logger);
  const statusBar = new BypassStatusBar();

  context.subscriptions.push(logger, bus, workspace, core, provider, statusBar);

  // Esquema próprio para a saída das ferramentas. O provider só lê, então o
  // editor abre a aba somente leitura sem depender de ninguém passar um flag.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      TOOL_OUTPUT_SCHEME,
      new ToolOutputContentProvider(toolOutputs),
    ),
  );

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
    bus.on('composer.insert', (payload) => provider.post({ type: 'composer.insert', payload })),
    bus.on('speech.transcript', (text) =>
      provider.post({ type: 'speech.transcript', payload: { text } }),
    ),
    bus.on('speech.partial', (text) =>
      provider.post({ type: 'speech.partial', payload: { text } }),
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
  // Fora do caminho da ativação: retomar a sessão do Hub toca a rede, e a
  // janela não deve esperar por isso. O resultado chega pelo `hub.status`.
  void core.resumeHubSession();
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
    agentRoles,
    skills,
    modelCatalog,
    mcp,
    usage,
    localState,
    secrets,
    settings,
    workspace,
    initializer,
    worktrees,
  };
}

export function deactivate(): void {
  // Tudo é descartado por context.subscriptions. O bypass morre com o processo,
  // que é exatamente o comportamento exigido: ele nunca sobrevive a um reinício.
}
