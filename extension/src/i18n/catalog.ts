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
} as const satisfies Record<string, string>;

export type WebviewStringKey = keyof typeof WEBVIEW_STRINGS;

/** Dicionário já traduzido, do jeito que a webview consome. */
export type WebviewStrings = Record<WebviewStringKey, string>;
