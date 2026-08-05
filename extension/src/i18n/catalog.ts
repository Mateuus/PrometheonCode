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
  // Uma engrenagem só, e ela abre o painel do Prometheon. O editor de
  // configurações do VS Code virou um botão dentro da seção General.
  'header.settings': 'Settings',
  'header.untitled': 'Untitled',
  'header.renameConversation': 'Rename this conversation',
  'sessions.renameLabel': 'Rename {0}',
  'sessions.nameRequired': 'Give the conversation a name.',

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
  'menu.effort': 'Effort',

  // Esforço de raciocínio (a escala é comum; o nome de cada nível vem do CLI)
  'effort.low.description': 'Answers fast, thinks little. Good for lookups and small edits.',
  'effort.medium.description': 'The balance most tasks want.',
  'effort.high.description': 'Thinks longer before acting. Costs more tokens and time.',
  'effort.xhigh.description': 'For problems that need a plan before the first edit.',
  'effort.max.description': 'Everything it has. Slow and expensive — keep it for the hard ones.',
  'effort.ultracode.description':
    'Extra high plus orchestration: the agent breaks the work up and delegates.',
  'effort.default': 'Chosen by the CLI',
  'effort.defaultDescription': 'No effort flag is sent; the provider decides.',
  'effort.help':
    'How much the agent thinks before acting. The composer can raise or lower it for one session without changing this default.',

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
  'settings.graph': 'Graph',
  'settings.git': 'Git & Commits',
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
  'accounts.model': 'Model',
  'accounts.authMethod': 'Auth method',
  'accounts.email': 'Email',
  'accounts.organization': 'Organization',
  'accounts.plan': 'Plan',
  'accounts.status': 'Status',
  'accounts.signIn': 'Sign in',
  'accounts.signOut': 'Sign out',
  'accounts.rename': 'Rename',
  'accounts.renameSave': 'Save name',
  'accounts.renameRequired': 'Give the account a name.',
  'accounts.remove': 'Remove',
  'accounts.signOutConfirmTitle': 'Sign out of this account?',
  'accounts.signOutConfirmBody': 'The isolated configuration directory is kept.',
  'accounts.removeConfirmTitle': 'Remove account',
  'accounts.removeConfirmBody':
    'The sign-in files in {0} are kept. Delete that folder yourself to also drop the credentials.',
  'accounts.removeConfirmBound':
    '{0} agent profile(s) still point to this account and will stop until they are bound to another one.',
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

  // Conexão com o Hub, na seção General
  'hub.title': 'Prometheon Hub',
  'hub.description':
    'Signing in authorizes this device through your browser. Prometheon never asks for your password, and the credential stays in the editor secret storage.',
  'hub.signIn': 'Sign in to Prometheon Hub',
  'hub.signOut': 'Sign out of Hub',
  'hub.reconnect': 'Reconnect',

  // Formulários do modal de configuração
  'form.name': 'Name',
  'form.cancel': 'Cancel',
  'form.edit': 'Edit',
  'form.editItem': 'Edit {0}',
  'form.enable': 'Enable',
  'form.disable': 'Disable',
  'form.enabled': 'Enabled',
  'form.disabled': 'Disabled',
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
  'agents.emptyTitle': 'Assemble your agent team',
  'agents.emptyBody':
    'An agent is a role plus an account: the role says what it does, the account says how it runs.',
  'agents.new': 'New agent',
  'agents.groupByRole': 'Group by role',
  'agents.removeConfirmTitle': 'Remove agent',
  'agents.removeConfirmBody': 'The agent profile is deleted. The account it points to is not touched.',
  'roles.manager': 'Roles',
  'roles.openPrompt': 'Open prompt in the editor',
  'roles.promptFileWins': 'When the prompt file exists, it wins over this text.',
  'roles.promptNeedsId': 'Create the role first — the prompt file is named after it.',
  'agents.promptNeedsId': 'Create the agent first — the prompt file is named after it.',
  'prompt.createFile': 'Create prompt file',
  'prompt.fileInCharge': 'The prompt file is in charge — edit it in the editor.',
  'roles.empty': 'No named role yet. Create one to reuse a specialty across agents.',
  'roles.removeConfirmBody':
    'Agents using this role start warning that it is missing; none of them is repointed.',
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
  // Onde o agente é guardado: no repositório da equipe ou só nesta máquina.
  'agents.scope': 'Where it lives',
  'agents.scopeMachine': 'This machine',
  'agents.scopeProject': 'This project',
  'agents.scopeMachineHint': 'Only you have this agent. Nothing is written to the repository.',
  'agents.scopeProjectHint':
    'Saved in .prometheon/agents/, which goes to git — everyone who clones gets this agent. The account stays yours: each machine picks its own.',
  'agents.scopeHint':
    'An agent describes how the work gets done here, so it belongs with the code. What never travels is the account behind it.',
  'agents.allowedHint': 'Comma separated. Empty means the provider default.',
  'agents.deniedHint': 'Comma separated.',
  'agents.maxSessionsField': 'Max concurrent sessions',
  'agents.between': 'Between 1 and {0}.',
  'agents.create': 'Create agent',
  'agents.save': 'Save agent',
  'agents.nameRequired': 'Give the agent profile a name.',
  'agents.accountRequired': 'Pick the account this agent runs through.',
  'agents.sessionsRange': 'Max concurrent sessions must be between 1 and {0}.',

  // Ajuda contextual dos campos do agente. A dica curta embaixo do controle diz
  // como preencher; o `?` explica o que o campo significa e o que ele custa.
  'help.about': 'About {0}',
  'agents.nameHelp':
    'Shown in the agent list and when the orchestrator delegates. It also derives the profile id at creation; renaming later keeps the original id.',
  'agents.accountHelp':
    'Each agent has its own CLI sign-in, isolated from the others. If the bound account is unavailable this agent simply does not run — Prometheon never borrows another one.',
  'agents.roleHelp':
    'The part this agent plays in a team run. The orchestrator delegates instead of implementing; the others receive a task and execute it. Custom leaves the behavior to the system prompt.',
  'agents.modelHelp':
    'The model id handed to the CLI, exactly as typed. Prometheon keeps no model list, so a wrong id only fails when the agent runs.',
  'agents.systemPromptHelp':
    'Standing instructions added to every session of this agent. The project rules and the task itself come on top of them.',
  'agents.autonomyHelp':
    'How far this agent goes before it stops and asks. Bypass is temporary by design: it lives in memory only, and restarting the extension or switching workspace drops it back to Manual.',
  'agents.contextHelp':
    'How much this agent gets to see: the task alone, the repository plus the Prometheon Brain, or the knowledge shared through the Hub.',
  'agents.allowedHelp':
    'Restricts this agent to these tools. Empty means whatever the provider allows by default.',
  'agents.deniedHelp':
    'Tools this agent may never use, even when they also appear in the allowed list. Denied always wins.',
  'agents.maxSessionsHelp':
    'How many tasks this agent runs at the same time. Each session is a separate CLI process, with its own context and its own cost, so four means four processes on this machine. Keep it at 1 when the tasks touch the same files.',
  'agents.enabledHelp':
    'A disabled agent keeps its configuration but is not offered for delegation and starts no new session.',

  // Papéis nomeados: os que a equipe cria além dos sete embutidos.
  'roles.new': 'New role',
  'roles.newOption': 'New role…',
  'roles.newOptionDescription': 'Name a specialty of your own and reuse it in other agents.',
  'roles.edit': 'Edit role',
  'roles.remove': 'Remove role',
  'roles.create': 'Create role',
  'roles.save': 'Save role',
  'roles.description': 'Description',
  'roles.basedOn': 'Based on',
  'roles.sharedThrough': 'Shared through',
  'roles.labelHelp': 'How this role appears in the Role list of every agent profile.',
  'roles.descriptionHelp':
    'One line saying what this role does. It is what the orchestrator reads when deciding whom to delegate to.',
  'roles.basedOnHelp':
    'Which built-in role this one behaves like when work is delegated. A test specialty is still a tester.',
  'roles.scopeHelp':
    'Where this role is stored, and therefore who else gets it. Team roles need a connected Hub; project roles travel with the repository.',
  'roles.skillsHelp':
    'Skills every agent with this role starts with. Each agent can still add its own.',
  'roles.promptHelp':
    'Added to the system prompt of every agent with this role, before the prompt of the agent itself.',
  'roles.labelRequired': 'Give the role a name.',
  'roles.descriptionRequired': 'Describe in one line what this role does.',
  'roles.pickRole': 'Pick the role this agent plays.',
  'roles.roleHelp':
    'The part this agent plays in a team run. The orchestrator delegates instead of implementing; the others receive a task and execute it. A named role of your own carries its own skills.',
  'roleScope.machine': 'This machine',
  'roleScope.project.description':
    'Lives in .prometheon/agents/roles.yaml and reaches the team through Git.',
  'roleScope.hub.description': 'Shared through the Hub with everyone in the organization.',
  'roleScope.machine.description': 'Yours only. Never leaves this computer.',

  // Skills
  'skills.field': 'Skills',
  'skills.empty': 'No skill found yet. Add one under .prometheon/skills/ and refresh.',
  'skills.available': '{0} skills available in this workspace.',
  'skills.help':
    'Procedures this agent may load during a run. Only the name and the trigger line stay in the prompt; the body is read when the agent asks for it.',
  'skills.unsupported': '{0} — does not run on this platform.',
  'mcp.test': 'Test servers',
  'mcp.reachable': 'Reachable',
  'mcp.unreachable': 'Unreachable',
  'mcp.commandMissing': 'Command not found',
  'mcp.removeConfirmTitle': 'Remove MCP server',
  'mcp.removeConfirmBody':
    'The entry is removed from .mcp.json. Other tools that read the same file lose it too.',
  'graph.createScript': 'Create rebuild script',
  'graph.scriptCreated':
    'Rebuild script created in .prometheon/scripts/ — adjust it to this project corpus.',
  'workspace.settings': 'Workspace settings',
  'workspace.setupTitle': 'Set up the shared workspace',
  'workspace.setupBody':
    'Skills, roles and the commit policy live in .prometheon/ and reach the whole team through Git.',
  'workspace.gitDetected': 'Git repository detected',
  'workspace.gitMissing': 'No Git repository',
  'workspace.hubProject': 'Prometheon Hub project',
  'workspace.hubConnect': 'Connect to the Hub to bind this workspace to a team project.',
  'workspace.projectHint':
    'Web Chat conversations live inside this project; team context is read from it.',
  'workspace.dialogNote':
    'Changes apply as you pick them and are written to .prometheon/prometheon.yaml — the file the whole team shares.',
  'workspace.defaultChat': 'Default chat',
  'workspace.chatLocalHint': 'Conversations stay on this machine.',
  'workspace.chatWebHint': 'Conversations live in the Hub project.',
  'workspace.bypassNote':
    'Bypass is never a persisted default: it stays local, temporary and per session.',
  'skills.new': 'New skill',
  'skills.create': 'Create skill',
  'skills.machineOnly': 'Only on this machine',
  'skills.nameHint':
    'Lowercase, numbers and dashes. Project skills live in .prometheon/skills/ and travel with the repository.',
  'skills.invalidName':
    'Skill names use lowercase letters, numbers and dashes — it is also the folder name.',
  'skills.needsFolder': 'Open a folder (or configure the workspace) before creating a project skill.',
  'skills.select': 'Select skills…',
  'skills.pickerAvailable': 'Available',
  'skills.filter': 'Filter skills…',
  'skills.noneEnabled': 'No skill enabled.',
  'skills.noneAvailable': 'Nothing else available.',
  'skills.notInCatalog': 'Not in the catalog',
  'skills.clickToRemove': 'Click to remove.',
  'form.done': 'Done',

  // Seção Skills: catálogo de leitura. Editar uma skill é editar o SKILL.md.
  'skills.section': 'Skills',
  'skills.sectionDescription':
    'A skill is a procedure an agent follows. Only the name and the trigger line stay in the prompt; the body is read when the agent needs it.',
  'skills.roots': 'Read from: {0}',
  'skills.unreadable': '{0} skills could not be read',
  'skills.refresh': 'Refresh',
  'skills.risk': 'Risk',
  'skills.body': 'Body',
  'skills.bodyTokens': '~{0} tokens',
  'skills.version': 'Version',
  'skills.license': 'License',
  'skills.author': 'Author',
  'skills.supportFiles': 'Support files',
  'skills.requiresMcp': 'Requires MCP',
  'skills.wrongPlatform': 'This skill declares {0} and does not run here.',
  'skills.capsAutonomy':
    'This skill caps the agent at Manual: it asks for approval even in Auto or Bypass.',
  'skills.open': 'Open SKILL.md',
  'skillScope.project': 'Project',
  'skillScope.machine': 'This machine',
  'skillScope.compatible': 'Compatible folder',
  'skillRisk.none': 'No risk',
  'skillRisk.low': 'Low risk',
  'skillRisk.medium': 'Medium risk',
  'skillRisk.high': 'High risk',

  // Modelos: a lista vem do provedor da conta vinculada e é conveniência —
  // texto livre continua valendo, porque o provedor lança modelo sem avisar.
  'models.freeText': 'Free text: the CLI validates it when the agent runs.',
  'models.known': '{0} models known for this provider.',
  'models.customHelp':
    'The model id handed to the CLI, exactly as typed. A wrong id only fails when the agent runs.',
  'models.pickFromList': 'Pick from the list',
  'models.cliDefaultDescription': 'Whatever the CLI already uses for this account.',
  'models.other': 'Other…',
  'models.otherDescription': 'Type a model id the list does not have yet.',
  'models.hint': 'The account only holds the sign-in. The model is this agent’s choice.',
  'models.help':
    'The model id handed to the CLI. The list comes from the provider of the bound account and is a convenience — pick Other… to type an id it does not have yet, or edit models.json to add it for good.',
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
  'web.noProject': 'No project available for this account in the Hub.',
  'context.team': 'Team',
  'context.isolated.description': 'Only the task and the files handed to the agent.',
  'context.project.description': 'Repository context and the Prometheon Brain.',
  'context.team.description': 'Authorized Hub context and shared knowledge.',
  'workspace.description':
    'The shared Prometheon workspace lives in .prometheon/ inside the open folder. Local Chat works without it.',
  'workspace.folder': 'Folder',
  'workspace.noFolder': 'None open',
  'workspace.git': 'Git repository',
  'workspace.detected': 'Detected',
  'workspace.notDetected': 'Not detected',
  'workspace.external': 'External folder',
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
  // Painel de ações, contexto e histórico
  'composer.add': 'Add to the message',
  'composer.actions': 'Actions',
  'commands.filter': 'Filter actions…',
  'commands.noMatch': 'No action matches this search.',
  'commands.upload': 'Upload from computer',
  'commands.uploadHint': 'Attach images to the message.',
  'commands.addContext': 'Add context',
  'commands.addContextHint': 'Mention a file from this project.',
  'commands.compact': 'Compact conversation',
  'commands.compactHint': 'Ask the agent to summarize and continue from the summary.',
  'commands.autoCompact': 'Auto-compact',
  'commands.autoCompactHint': 'Compact on its own when the window is nearly full.',
  'commands.on': 'On',
  'commands.off': 'Off',
  'commands.clearConversation': 'Clear conversation',
  'commands.clearConversationHint': 'Erase the messages and keep the session.',
  'commands.inUse': 'In use',
  'commands.accountUsage': 'Account & usage',
  'commands.noAccount': 'No account yet.',
  'commands.accountsHint': 'CLI sign-ins available on this machine.',
  'commands.agentsHint': 'Agent Profiles and their bindings.',
  'commands.usageTotal': '{0} today · {1} total · {2} runs',
  'commands.usageFooter': 'All accounts: {0} tokens across {1} runs. Counted by Prometheon on this machine, not by the provider.',
  'context.window': 'Context window',
  'context.used': 'Context window · {0}% used',
  'context.numbers': '{0} of {1} tokens · {2}',
  'context.estimate': 'Estimated from the last call. Compacting starts a shorter conversation.',
  'context.compactNow': 'Compact now',
  'sessions.delete': 'Delete this session',
  'sessions.deleteNamed': 'Delete {0}',
  'sessions.deleteConfirm': 'Delete?',
  'general.openVsCodeSettings': 'Open VS Code settings',
  'accounts.namePlaceholder': 'e.g. Personal, Work, Client X',

  'usage.tooltip': '{0} input tokens · {1} output tokens',

  // Seção Graph — o grafo de conhecimento do projeto
  'graph.note':
    'A knowledge graph of this project, generated from the code and committed with it. Agents query it instead of reading file by file.',
  'graph.unavailable':
    'The project graph lives inside the open folder. Open a folder to configure it.',
  'graph.found': 'Found in {0}/ · rebuilt {1}',
  'graph.missing': 'Not found in {0}/',
  'graph.cli': 'graphify CLI',
  'graph.cliMissing': 'Not found on PATH',
  'graph.hook': 'Commit hook',
  'graph.hookInstalled': 'Installed',
  'graph.hookMissing': 'Not installed',
  'graph.enabled': 'Let agents query the project graph',
  'graph.enabledHelp':
    'Every agent is told the graph exists, where it is, and which commands read it. Without this they fall back to reading files one by one.',
  'graph.folder': 'Graph folder',
  'graph.folderHint': 'Relative to the project root.',
  'graph.command': 'Rebuild command',
  'graph.commandHint':
    'Runs from the project root, in a shell. There is no default: the wrong command can rebuild the graph from a different corpus than the one your project curates.',
  'graph.trigger': 'When to rebuild',
  'graph.triggerHelp':
    'On commit is the safest: the commit is the only verifiable statement that the work is good, and it keeps one rebuild per commit instead of many per task.',
  'graph.triggerCommit': 'On commit (recommended)',
  'graph.triggerCommitDescription':
    'A Git hook rebuilds the graph when the commit touches code, so graph and code land together.',
  'graph.triggerManualDescription':
    'Nobody rebuilds it for you. Use the button below when you want to.',
  'graph.triggerRun': 'After each run',
  'graph.triggerRunDescription':
    'Rebuilds when an agent finishes. Costs one rebuild per run, and the graph can be rebuilt mid-task.',
  'graph.gate': 'Gate command',
  'graph.gatePlaceholder': 'optional — e.g. npm test',
  'graph.gateHint':
    'The commit only proceeds when this command exits 0. Leave empty to skip the gate.',
  'graph.gateHelp':
    'A command, never an agent saying it finished: the agent that wrote the code is the worst judge of whether it works.',
  'graph.hygiene': 'Block the commit when the hygiene check fails',
  'graph.hygieneHelp':
    'If the rebuild reports a hygiene failure — a machine path or a sensitive file inside the graph — the commit stops. Tracking a leak down later costs far more than stopping now.',
  'graph.needsHooks':
    'Rebuild on commit needs the Git hooks installed on this machine. They are not installed yet.',
  'graph.needsCommand': 'Set the rebuild command before choosing an automatic trigger.',
  'graph.rebuildNow': 'Rebuild now',
  'graph.costCommit':
    'Every commit that touches code waits for this command to finish. Time it before rolling this out to the team — a rebuild of a couple of minutes gets the hook disabled.',
  'graph.costRun': 'Every run that changes code waits for this command to finish.',
  'graph.ageNow': 'just now',
  'graph.ageMinutes': '{0} min ago',
  'graph.ageHour': '1 hour ago',
  'graph.ageHours': '{0} hours ago',
  'graph.ageDay': '1 day ago',
  'graph.ageDays': '{0} days ago',

  // Seção Git & Commits — política de commit e os hooks que a garantem
  'git.note':
    'Commit policy for this project. It is stored in .prometheon/prometheon.yaml, so whoever clones the repository gets the same rules.',
  'git.unavailable': 'Commit policy belongs to a project. Open a folder to configure it.',
  'git.coAuthored': 'Allow AI co-authorship in commits',
  'git.coAuthoredHelp':
    'Off by default. With this off, the installed hook strips Co-Authored-By trailers and tool signatures from every commit message — asking the model not to add them only reduces the noise.',
  'git.style': 'Commit message format',
  'git.styleConventional': 'Conventional Commits',
  'git.styleConventionalDescription':
    'type(scope): subject — for example, feat(extension): add the graph section.',
  'git.styleFree': 'Free form',
  'git.styleFreeDescription':
    'No required format. The agent follows whatever the repository already does.',
  'git.language': 'Commit message language',
  'git.languageHint': 'Independent of the panel language.',
  'git.scopes': 'Accepted scopes',
  'git.scopesPlaceholder': 'e.g. extension, hub, docs',
  'git.scopesHint': 'Comma separated. Leave empty to accept any scope.',
  'git.hooks': 'Hooks',
  'git.hooksNote':
    'The files are versioned so the whole team gets them, but pointing Git at them is per machine — each person installs it once.',
  'git.hooksPathUnset': 'Not set (Git uses .git/hooks)',
  'git.hooksForeign':
    'Git is currently using hooks from {0}. Installing points it at .githooks instead.',
  'git.install': 'Install Git hooks',
  'git.uninstall': 'Disable hooks on this machine',
  'git.configureGraph': 'Configure the graph',
  // Console por agente
  'agents.main': 'Main',
  'agents.openConsole': 'Open this agent’s console',
  'agents.noTools': 'This agent has not run any tool yet.',
  'agents.unnamed': 'Agent',
  // Conversa direta com um worker, na aba dele.
  'agents.talkPlaceholder': 'Message {0}…  (Enter to send)',
  'agents.talkWaiting': 'Waiting for the current turn to end',
  'agents.talkNoImages': 'Images only go to the main conversation.',
  // Fila de mensagens escritas durante um run.
  'queued.discard': 'Discard this message',
  'queued.now': 'Send now',
  // Contagem do diff de uma edição, acima do bloco vermelho e verde.
  'step.diffCounts': '{0} removed, {1} added',
  'queued.nowHint': 'Interrupt the current run and send what is waiting',
  // Vários workers ao mesmo tempo entram dobrados numa linha só.
  'agents.bundle': '{0} delegated agents',
  'agents.bundleHide': 'Hide delegated agents',
  'agents.bundleWorking': '{0} working',

  // Saída das ferramentas no chat
  'step.output': '{0} tool output',
  'step.outputLines': '{0} tool output ({1} lines)',
  'step.outputTruncated': 'Showing the first {0} KB.',
  'step.openOutput': 'Open full output',

  'projectConfig.missing':
    'These settings are stored in .prometheon/prometheon.yaml, which does not exist yet.',
} as const satisfies Record<string, string>;

export type WebviewStringKey = keyof typeof WEBVIEW_STRINGS;

/** Dicionário já traduzido, do jeito que a webview consome. */
export type WebviewStrings = Record<WebviewStringKey, string>;
