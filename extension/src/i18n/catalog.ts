/**
 * Catálogo de textos da webview.
 *
 * A webview não alcança `vscode.l10n` — ela roda num iframe sem acesso à API da
 * extensão. Por isso o texto é resolvido aqui, no processo da extensão, e
 * entregue já traduzido junto do HTML (ver `webviewStrings` em `./index`).
 *
 * O valor de cada chave é o texto em **inglês**, que também é a chave de
 * tradução usada nos bundles de `l10n/`. Assim o inglês continua sendo a fonte:
 * traduzir é acrescentar entradas nos bundles, sem tocar no código.
 */
export const WEBVIEW_STRINGS = {
  // Cabeçalho
  'header.sessions': 'Sessions',
  'header.newChat': 'New chat',
  'header.settings': 'Open settings',
  'header.accounts': 'Accounts and usage',
  'header.untitled': 'Untitled',

  // Histórico de sessões
  'sessions.local': 'Local',
  'sessions.web': 'Web',
  'sessions.search': 'Search sessions…',
  'sessions.empty': 'No sessions yet.',
  'sessions.noMatch': 'No session matches this search.',
  'sessions.webNeedsHub': 'Web sessions need a connected Hub.',

  // Composer
  'composer.placeholder': 'Ask Prometheon…  (Enter to send · paste to attach an image)',
  'composer.attach': 'Attach image',
  'composer.send': 'Send',
  'composer.clear': 'Clear',
  'composer.clearTitle': 'Clear this local conversation',
  'composer.stop': 'Stop',
  'composer.removeImage': 'Remove image',

  // Ditado
  'speech.idle': 'Dictate — tap or hold Ctrl+D to record',
  'speech.listening': 'Listening… tap Ctrl+D to stop',
  'speech.transcribing': 'Transcribing…',
  'speech.unavailable': 'Dictation unavailable.',

  // Seletores do composer
  'menu.workMode': 'Work mode',
  'menu.autonomy': 'Autonomy',
  'menu.mainAgent': 'Main agent',

  // Modos de trabalho e autonomia (espelham core/types.ts, que fica em inglês)
  'workMode.plan': 'Plan',
  'workMode.edit': 'Edit',
  'workMode.agentTeam': 'Agent Team',
  'workMode.plan.description': 'Analysis and planning only.',
  'workMode.edit.description': 'A single agent may edit inside the allowed scope.',
  'workMode.agentTeam.description': 'The main agent may delegate work to workers.',
  'autonomy.manual': 'Manual',
  'autonomy.auto': 'Auto',
  'autonomy.bypass': 'Bypass permissions',
  'autonomy.manual.description': 'Ask for approval on relevant actions.',
  'autonomy.auto.description': 'Approve safe actions and pause on risky ones.',
  'autonomy.bypass.description': 'No interactive approval inside the authorized scope.',

  // Conversa
  'chat.you': 'You',
  'chat.empty': 'No messages yet. Ask something to see the mesh respond.',
  'chat.imagePreview': 'Image preview',
  'chat.close': 'Close',

  // Modal de configuração
  'settings.title': 'Settings',
  'settings.general': 'General',
  'settings.accounts': 'Accounts',
  'settings.agents': 'Agents',
  'settings.workspace': 'Workspace',
  'settings.mcp': 'MCP',

  // Idioma da interface
  'language.field': 'Interface language',
  'language.hint':
    'Applies to this panel. Menus and commands contributed to VS Code follow the editor language.',
  'language.auto': 'Follow VS Code',
  'language.en': 'English',
  'language.ptbr': 'Português (Brasil)',
  'language.es': 'Español',
  'language.auto.description': 'Use the display language of the editor.',
  'language.en.description': 'Source language of the interface.',
  'language.ptbr.description': 'Interface in Brazilian Portuguese.',
  'language.es.description': 'Interface in Spanish.',

  // Perguntas do agente
  'question.title': 'Question from the agent',
  'question.other': 'Other',
  'question.customPlaceholder': 'Type your answer…',
  'question.submit': 'Submit answers',
  'question.cancelHint': 'Esc to cancel',
  'question.step': 'Asked',
  'question.cancelled': 'Cancelled',
  'question.mismatch': 'The answer did not match the question and was discarded.',

  // Agentes ativos
  'agents.title': 'Active Agents',
  'agents.stop': 'Stop',

  // Contas e uso
  'accounts.title': 'Accounts & Usage',
  'accounts.add': 'Add account',
  'accounts.empty':
    'No account yet. Add one to give an agent its own CLI sign-in, isolated from the others.',
  'accounts.signedIn': 'Signed in',
  'accounts.signedOut': 'Signed out',
  'accounts.cliMissing': 'CLI missing',
  'accounts.provider': 'Provider',
  'accounts.authMethod': 'Auth method',
  'accounts.email': 'Email',
  'accounts.organization': 'Organization',
  'accounts.plan': 'Plan',
  'accounts.status': 'Status',
  'accounts.signIn': 'Sign in',
  'accounts.signInAgain': 'Sign in again',
  'accounts.signOut': 'Sign out',
  'accounts.remove': 'Remove',
  'accounts.note':
    'Token counts are measured by Prometheon on this machine. Subscription limits live in each provider account and are not read from here.',

  // Uso de tokens
  'usage.title': 'Tokens measured locally',
  'usage.today': 'Today',
  'usage.last7Days': 'Last 7 days',
  'usage.allTime': 'All time',

  // Configuração do workspace
  'setup.title': 'Set up Prometheon for this workspace',
  'setup.current': 'Initialize in current workspace',
  'setup.external': 'Choose Prometheon workspace folder',
  'setup.skip': 'Continue without shared workspace',

  // Web Chat
  'web.title': 'Web Chat',
  'web.description':
    'Web Chat keeps conversations and approved context synchronized through Prometheon Hub. Connect a Hub to continue.',
  'web.connect': 'Connect to Prometheon Hub',

  // Formulários do modal de configuração
  'form.name': 'Name',
  'form.cancel': 'Cancel',
  'form.edit': 'Edit',
  'form.editItem': 'Edit {0}',
  'form.enable': 'Enable',
  'form.disable': 'Disable',
  'form.enabled': 'Enabled',
  'form.disabled': 'Disabled',
  'form.yes': 'Yes',
  'form.no': 'No',
  'form.none': 'None',
  'accounts.description':
    'Each account is a separate CLI sign-in with its own configuration directory. Signing in always happens through the official CLI flow.',
  'accounts.emptyList':
    'No account yet. Create one to give an agent its own CLI sign-in, isolated from the others.',
  'accounts.new': 'New account',
  'accounts.noProvider': 'No provider adapter is available yet.',
  'accounts.nameHint': 'A name to tell this account apart from the others.',
  'accounts.isolatedThrough': 'Isolated through {0}',
  'accounts.create': 'Create account',
  'accounts.nameRequired': 'Give the account a name before creating it.',
  'usage.runs': '{0} · {1} runs',
  'agents.profiles': 'Agent Profiles',
  'agents.profilesDescription':
    'Every agent runs through one account. Prometheon never falls back to another one when the bound account is unavailable.',
  'agents.needsAccount':
    'An agent profile needs an account. Create one first, then come back here.',
  'agents.goToAccounts': 'Go to Accounts',
  'agents.emptyProfiles': 'No agent profile yet.',
  'agents.newProfile': 'New agent profile',
  'agents.unknownProvider': 'unknown provider',
  'agents.model': 'Model',
  'agents.modelDefault': 'Chosen by the CLI',
  'agents.context': 'Context',
  'agents.maxSessions': 'Max sessions',
  'agents.allowedTools': 'Allowed tools',
  'agents.deniedTools': 'Denied tools',
  'agents.account': 'Account',
  'agents.signedIn': '{0} · signed in',
  'agents.notSignedIn': '{0} · not signed in',
  'agents.accountHint': 'The account this agent runs through. It is required.',
  'agents.role': 'Role',
  'agents.modelPlaceholder': 'Leave empty to use the CLI default',
  'agents.modelHint':
    'Free text: Prometheon does not list models. The CLI validates it when the agent runs.',
  'agents.systemPrompt': 'System prompt',
  'agents.systemPromptPlaceholder': 'How this agent should behave.',
  'agents.contextStrategy': 'Context strategy',
  'agents.allowedHint': 'Comma separated. Empty means the provider default.',
  'agents.deniedHint': 'Comma separated.',
  'agents.maxSessionsField': 'Max concurrent sessions',
  'agents.between': 'Between 1 and {0}.',
  'agents.create': 'Create agent',
  'agents.save': 'Save agent',
  'agents.nameRequired': 'Give the agent profile a name.',
  'agents.accountRequired': 'Pick the account this agent runs through.',
  'agents.sessionsRange': 'Max concurrent sessions must be between 1 and {0}.',
  'role.orchestrator': 'Orchestrator',
  'role.planner': 'Planner',
  'role.implementer': 'Implementer',
  'role.reviewer': 'Reviewer',
  'role.researcher': 'Researcher',
  'role.tester': 'Tester',
  'role.custom': 'Custom',
  'role.orchestrator.description': 'Leads the work and delegates to the other agents.',
  'role.planner.description': 'Breaks the task down before anything is edited.',
  'role.implementer.description': 'Writes and changes code inside the allowed scope.',
  'role.reviewer.description': 'Reads the diff and reports risks.',
  'role.researcher.description': 'Explores the codebase and gathers context.',
  'role.tester.description': 'Runs and writes tests for the change.',
  'role.custom.description': 'A role you define through the system prompt.',
  'agentAutonomy.bypass': 'Bypass (temporary)',
  'agentAutonomy.bypass.description': 'No interactive approval; never persisted across restarts.',
  'context.isolated': 'Isolated',
  'context.project': 'Project',
  'context.team': 'Team',
  'context.isolated.description': 'Only the task and the files handed to the agent.',
  'context.project.description': 'Repository context and the Prometheon Brain.',
  'context.team.description': 'Authorized Hub context and shared knowledge.',
  'workspace.description':
    'The shared Prometheon workspace lives in .prometheon/ inside the open folder. Local Chat works without it.',
  'workspace.folder': 'Folder',
  'workspace.noFolder': 'None open',
  'workspace.configured': 'Configured',
  'workspace.git': 'Git repository',
  'workspace.detected': 'Detected',
  'workspace.notDetected': 'Not detected',
  'workspace.external': 'External folder',
  'workspace.skipped': 'Setup skipped',
  'mcp.title': 'MCP servers',
  'mcp.description':
    'Model Context Protocol servers of this project, read from .mcp.json — the same file Claude Code, Cursor and VS Code use.',
  'mcp.secretNote':
    'This file lives at the root of the project and usually goes into Git. Keep tokens out of it: put the value in an environment variable and reference it by name, like ${GITHUB_TOKEN}.',
  'mcp.unavailable':
    'MCP servers are configured in .mcp.json at the root of the open folder. Open a folder to configure them.',
  'mcp.goToWorkspace': 'Go to Workspace',
  'mcp.notCreated': '{0} (not created yet)',
  'mcp.empty': 'No MCP server configured yet.',
  'mcp.add': 'Add server',
  'mcp.import': 'Import from .mcp.json',
  'mcp.transport': 'Transport',
  'mcp.command': 'Command',
  'mcp.arguments': 'Arguments',
  'mcp.url': 'URL',
  'mcp.environment': 'Environment',
  'mcp.headers': 'Headers',
  'mcp.preserved': 'Kept as is',
  'mcp.new': 'New MCP server',
  'mcp.save': 'Save server',
  'mcp.nameHint': 'Letters, digits, dot, dash and underscore. It is the key inside .mcp.json.',
  'mcp.renameHint': 'To rename a server, remove it and add it again.',
  'mcp.argsHint': 'One argument per line.',
  'mcp.envHint': 'KEY=value, one per line. Reference secrets by variable name, never by value.',
  'mcp.urlHint': 'Must start with http:// or https://.',
  'mcp.headersHint':
    'Header=value, one per line. Reference secrets by variable name, never by value.',
  'mcp.nameRequired': 'Give the MCP server a name.',
  'mcp.commandRequired': 'A stdio server needs a command.',
  'mcp.urlRequired': 'A {0} server needs a URL.',
  'mcp.transport.stdio': 'stdio (local process)',
  'mcp.transport.stdio.description':
    'Prometheon starts a local command and talks to it over stdio.',
  'mcp.transport.http.description': 'Connects to an MCP server over HTTP.',
  'mcp.transport.sse.description': 'Connects to an MCP server over server-sent events.',
  'attachments.max': 'At most {0} images per message.',
  'attachments.unsupported': 'Unsupported image format: {0}',
  'attachments.tooLarge': 'Image is larger than {0} MB.',
  'working.envisioning': 'Envisioning',
  'working.thinking': 'Thinking',
  'working.working': 'Working',
  'working.composing': 'Composing',
  'working.reasoning': 'Reasoning',
  'chat.thoughtFor': 'Thought for {0}',
  'agents.available': 'Available · {0}',
  'agents.unavailable': 'Unavailable · {0}',

  // Hub e painel de agentes ativos
  'hub.localOnly': 'Local only',
  'hub.disconnected': 'Disconnected',
  'hub.connecting': 'Connecting',
  'hub.connected': 'Connected',
  'hub.error': 'Error',
  'agentRole.main': 'main',
  'agentRole.worker': 'worker',
  'agentStatus.idle': 'idle',
  'agentStatus.starting': 'starting',
  'agentStatus.working': 'working',
  'agentStatus.waiting': 'waiting',
  'agentStatus.blocked': 'blocked',
  'agentStatus.completed': 'completed',
  'agentStatus.stopped': 'stopped',

  // Rótulos de acessibilidade
  'a11y.chatType': 'Chat type',
  'a11y.message': 'Message',
  'attachments.remove': 'Remove {0}',
  'attachments.open': 'Open {0}',
  'usage.tooltip': '{0} input tokens · {1} output tokens',
} as const satisfies Record<string, string>;

export type WebviewStringKey = keyof typeof WEBVIEW_STRINGS;

/** Dicionário já traduzido, do jeito que a webview consome. */
export type WebviewStrings = Record<WebviewStringKey, string>;
