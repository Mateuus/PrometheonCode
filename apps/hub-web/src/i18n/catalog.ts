/**
 * Catálogo de textos do Hub Web.
 *
 * Mesmo desenho da extensão (`extension/src/i18n/catalog.ts`): a chave é
 * estruturada e o valor é o texto **em inglês**, que também é a chave usada nos
 * bundles de tradução em `messages/`. O inglês continua sendo a fonte — traduzir
 * é acrescentar entradas nos bundles, sem tocar no código.
 *
 * Marcadores de interpolação usam `{nome}` e precisam ser preservados nas
 * traduções; `src/i18n/i18n.test.ts` reprova o contrário.
 */
export const CATALOG = {
  // ---------------------------------------------------------------- produto
  'app.name': 'Prometheon Hub',
  'app.tagline': 'Your agent team, coordinated across the whole organization.',
  'app.description':
    'Prometheon connects the VS Code extension, local agents and your team around a single shared brain.',

  // ------------------------------------------------------------- navegação
  'nav.skipToContent': 'Skip to content',
  'nav.primary': 'Primary navigation',
  'nav.dashboard': 'Dashboard',
  'nav.projects': 'Projects',
  'nav.members': 'Members',
  'nav.audit': 'Audit log',
  'nav.settings': 'Settings',
  'nav.account': 'Account',
  'nav.sessions': 'Sessions',
  'nav.administration': 'Administration',
  'nav.plans': 'Plans',
  'nav.organization': 'Organization',
  'nav.backToApp': 'Back to the app',
  'nav.breadcrumb': 'Breadcrumb',

  // ------------------------------------------------------------------ ações
  'action.signIn': 'Sign in',
  'action.signOut': 'Sign out',
  'action.signUp': 'Create account',
  'action.save': 'Save changes',
  'action.cancel': 'Cancel',
  'action.retry': 'Try again',
  'action.reload': 'Reload',
  'action.create': 'Create',
  'action.search': 'Search',
  'action.send': 'Send',
  'action.export': 'Export',
  'action.invite': 'Invite people',
  'action.acceptInvite': 'Accept invitation',
  'action.declineInvite': 'Decline',
  'action.openProject': 'Open project',
  'action.viewAll': 'View all',
  'action.requestAccess': 'Request access',
  'action.goBack': 'Go back',
  'action.goToDashboard': 'Go to dashboard',
  'action.revoke': 'Revoke',
  'action.revokeAll': 'Revoke every other session',
  'action.copy': 'Copy',
  'action.refresh': 'Refresh',
  'action.dismiss': 'Dismiss',

  // ------------------------------------------------------- estados de tela
  'state.loading.title': 'Loading…',
  'state.loading.description': 'Fetching data from the Hub.',
  'state.empty.title': 'Nothing here yet',
  'state.empty.description': 'When there is something to show, it appears here.',
  'state.error.title': 'Something went wrong',
  'state.error.description': 'The Hub answered with an error. Nothing was changed.',
  'state.error.requestId': 'Request ID: {requestId}',
  'state.offline.title': 'You are offline',
  'state.offline.description':
    'The Hub is unreachable. Screens keep working with the data already loaded.',
  'state.forbidden.title': 'You do not have access',
  'state.forbidden.description':
    'Your role in this organization does not allow this screen. Ask an owner for access.',
  'state.unauthorized.title': 'Your session expired',
  'state.unauthorized.description': 'Sign in again to continue.',
  'state.reconnecting.title': 'Reconnecting…',
  'state.reconnecting.description': 'Live updates paused. Retrying the connection.',
  'state.reconnecting.attempt': 'Attempt {attempt}',
  'state.stale.title': 'Showing data that may be out of date',
  'state.stale.description': 'Last updated {relativeTime}. Live updates are not arriving.',
  'state.notFound.title': 'Page not found',
  'state.notFound.description': 'The address you opened does not exist in the Hub.',

  // -------------------------------------------------------------- conexão
  'connection.online': 'Connected',
  'connection.offline': 'Offline',
  'connection.reconnecting': 'Reconnecting',
  'connection.status': 'Connection status',

  // ------------------------------------------------------------------ tema
  'theme.toggle': 'Switch theme',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',

  // --------------------------------------------------------------- idioma
  'locale.label': 'Language',
  'locale.change': 'Change language',

  // ------------------------------------------------------------ marketing
  'landing.heroTitle': 'One brain for every agent on your team',
  'landing.heroSubtitle':
    'Plan, review and ship with agents that share context, respect permissions and leave an audit trail.',
  'landing.ctaPrimary': 'Open the Hub',
  'landing.ctaSecondary': 'Create an account',
  'landing.feature.brain.title': 'Shared brain',
  'landing.feature.brain.description':
    'Knowledge proposals are reviewed by people before they become team memory.',
  'landing.feature.agents.title': 'Agents you can watch',
  'landing.feature.agents.description':
    'See who is running what, on which machine, and stop it from the browser.',
  'landing.feature.audit.title': 'Every critical action audited',
  'landing.feature.audit.description':
    'The Hub records who did what, when and from where — exportable for compliance.',
  'landing.note':
    'The browser talks to the Hub. A local agent only runs a task when an authorized Core is online and accepts the job.',

  // ----------------------------------------------------------------- login
  'auth.login.title': 'Sign in to Prometheon',
  'auth.login.subtitle': 'Use the account your organization invited.',
  'auth.login.noAccount': 'No account yet?',
  'auth.register.title': 'Create your account',
  'auth.register.subtitle': 'You can create an organization right after.',
  'auth.register.hasAccount': 'Already have an account?',
  'auth.field.name': 'Full name',
  'auth.field.email': 'Email',
  'auth.field.password': 'Password',
  'auth.field.passwordHint': 'At least 12 characters.',
  'auth.field.organizationName': 'Organization name',
  'auth.error.invalidCredentials': 'Email or password is incorrect.',
  'auth.error.emailTaken': 'This email is already registered.',
  'auth.error.generic': 'We could not complete the request. Try again.',
  'auth.error.invalidEmail': 'Enter a valid email address.',
  'auth.error.shortPassword': 'Use at least 12 characters.',
  'auth.error.requiredName': 'Tell us your name.',
  'auth.legal': 'By continuing you agree to the terms and the privacy policy.',
  'auth.signedInAs': 'Signed in as {email}',

  // --------------------------------------------------------------- convite
  'invite.title': 'You were invited to {organization}',
  'invite.subtitle': 'Accepting adds your account to this organization as {role}.',
  'invite.invalid.title': 'This invitation is not valid',
  'invite.invalid.description': 'It may have expired or already been used. Ask for a new one.',
  'invite.expiresAt': 'Expires {relativeTime}.',
  'invite.needsAccount': 'You need an account before accepting.',

  // ------------------------------------------------------------- dashboard
  'dashboard.title': 'Dashboard',
  'dashboard.subtitle': 'What your team and your agents are doing right now.',
  'dashboard.recentProjects': 'Recent projects',
  'dashboard.membersOnline': 'Members online',
  'dashboard.agentsWorking': 'Agents working',
  'dashboard.blockedTasks': 'Blocked tasks',
  'dashboard.pendingReviews': 'Reviews waiting',
  'dashboard.knowledgeProposals': 'Knowledge proposals',
  'dashboard.hubUsage': 'Hub usage',
  'dashboard.syncIncidents': 'Sync incidents',
  'dashboard.usage.messages': 'Messages this month',
  'dashboard.usage.tasks': 'Tasks executed',
  'dashboard.usage.storage': 'Knowledge storage',
  'dashboard.usage.ofLimit': '{used} of {limit}',
  'dashboard.noIncidents': 'No sync incidents in the last 24 hours.',
  'dashboard.empty.projects': 'No project yet. Create the first one to get started.',
  'dashboard.empty.agents': 'No agent is running right now.',
  'dashboard.empty.blocked': 'Nothing is blocked right now.',
  'dashboard.empty.reviews': 'No review is waiting for you.',
  'dashboard.empty.proposals': 'No knowledge proposal is pending.',

  // ---------------------------------------------------------- organizações
  'organizations.title': 'Your organizations',
  'organizations.subtitle': 'Pick where you want to work.',
  'organizations.empty': 'You do not belong to an organization yet.',
  'organizations.create': 'Create organization',
  'organizations.memberCount': '{count} members',
  'organizations.memberCount.one': '{count} member',
  'organizations.projectCount': '{count} projects',
  'organizations.projectCount.one': '{count} project',
  'organizations.switch': 'Switch organization',

  // -------------------------------------------------------------- projetos
  'projects.title': 'Projects',
  'projects.subtitle': 'Every repository connected to this organization.',
  'projects.empty': 'No project in this organization yet.',
  'projects.create': 'New project',
  'projects.repository': 'Repository',
  'projects.lastActivity': 'Last activity {relativeTime}',
  'projects.openTasks': '{count} open tasks',
  'projects.openTasks.one': '{count} open task',
  'projects.activeAgents': '{count} active agents',
  'projects.activeAgents.one': '{count} active agent',
  'projects.search': 'Search projects…',
  'projects.noMatch': 'No project matches this search.',

  // ------------------------------------------------------- abas do projeto
  'project.tab.overview': 'Overview',
  'project.tab.chat': 'Chat',
  'project.tab.tasks': 'Tasks',
  'project.tab.agents': 'Agents',
  'project.tab.brain': 'Brain',
  'project.tab.settings': 'Settings',
  'project.tabs': 'Project sections',
  'project.overview.title': 'Overview',
  'project.overview.health': 'Project health',
  'project.overview.recentActivity': 'Recent activity',
  'project.overview.emptyActivity': 'No activity recorded yet.',

  // ------------------------------------------------------------------ chat
  'chat.title': 'Chat',
  'chat.conversations': 'Conversations',
  'chat.newConversation': 'New conversation',
  'chat.search': 'Search conversations…',
  'chat.emptyConversations': 'No conversation yet.',
  'chat.emptyMessages': 'Send the first message to start this conversation.',
  'chat.placeholder': 'Message the Hub…',
  'chat.mainAgent': 'Main agent',
  'chat.mode': 'Mode',
  // Espelham os modos de trabalho da extensão, que ficam em inglês no código.
  'chat.mode.plan': 'Plan',
  'chat.mode.edit': 'Edit',
  'chat.mode.agentTeam': 'Agent Team',
  'chat.attachedContext': 'Attached context',
  'chat.relatedTasks': 'Related tasks',
  'chat.presence': 'Team presence',
  'chat.export': 'Export conversation',
  'chat.projectSelector': 'Project',
  'chat.localExecutionNotice':
    'The Hub queues the work. A local agent only runs it when an authorized Core is online and accepts the job.',
  'chat.noCoreOnline': 'No authorized Core is online. Messages are queued.',
  'chat.sentBy': 'Sent by {author}',

  // --------------------------------------------------------------- tarefas
  'tasks.title': 'Tasks',
  'tasks.empty': 'No task in this project.',
  'tasks.create': 'New task',
  'tasks.status.backlog': 'Backlog',
  'tasks.status.running': 'Running',
  'tasks.status.blocked': 'Blocked',
  'tasks.status.review': 'In review',
  'tasks.status.done': 'Done',
  'tasks.assignee': 'Assignee',
  'tasks.unassigned': 'Unassigned',
  'tasks.updated': 'Updated {relativeTime}',
  'tasks.blockedReason': 'Blocked: {reason}',
  'tasks.filter.all': 'All',

  // --------------------------------------------------------------- agentes
  'agents.title': 'Agents',
  'agents.empty': 'No agent registered for this project.',
  'agents.status.idle': 'Idle',
  'agents.status.working': 'Working',
  'agents.status.offline': 'Offline',
  'agents.status.paused': 'Paused',
  'agents.role.main': 'Main agent',
  'agents.role.worker': 'Worker',
  'agents.device': 'Device',
  'agents.currentTask': 'Current task',
  'agents.lastHeartbeat': 'Last heartbeat {relativeTime}',
  'agents.noHeartbeat': 'No heartbeat received.',

  // ---------------------------------------------------- cérebro / knowledge
  'brain.title': 'Brain',
  'brain.subtitle': 'What the team taught the agents about this project.',
  'brain.empty': 'This project has no knowledge entry yet.',
  'brain.proposals': 'Pending proposals',
  'brain.approved': 'Approved knowledge',
  'brain.status.proposed': 'Proposed',
  'brain.status.approved': 'Approved',
  'brain.status.rejected': 'Rejected',
  'brain.proposedBy': 'Proposed by {author}',
  'brain.review': 'Review',

  // ----------------------------------------------- configurações do projeto
  'projectSettings.title': 'Project settings',
  'projectSettings.general': 'General',
  'projectSettings.name': 'Project name',
  'projectSettings.description': 'Description',
  'projectSettings.repositoryUrl': 'Repository URL',
  'projectSettings.defaultBranch': 'Default branch',
  'projectSettings.dangerZone': 'Danger zone',
  'projectSettings.archive': 'Archive project',
  'projectSettings.archiveHint': 'Archiving keeps the history and stops every agent.',

  // --------------------------------------------------------------- membros
  'members.title': 'Members',
  'members.subtitle': 'Who belongs to this organization and what they can do.',
  'members.empty': 'This organization has no member besides you.',
  'members.role': 'Role',
  'members.role.owner': 'Owner',
  'members.role.admin': 'Admin',
  'members.role.maintainer': 'Maintainer',
  'members.role.developer': 'Developer',
  'members.role.reviewer': 'Reviewer',
  'members.role.viewer': 'Viewer',
  'members.status.active': 'Active',
  'members.status.invited': 'Invited',
  'members.status.suspended': 'Suspended',
  'members.joined': 'Joined {relativeTime}',
  'members.lastSeen': 'Last seen {relativeTime}',
  'members.online': 'Online',
  'members.offline': 'Offline',

  // ------------------------------------------------------------- auditoria
  'audit.title': 'Audit log',
  'audit.subtitle': 'Every critical action, with who did it and from where.',
  'audit.empty': 'No audited action in this period.',
  'audit.column.when': 'When',
  'audit.column.actor': 'Actor',
  'audit.column.action': 'Action',
  'audit.column.target': 'Target',
  'audit.column.ip': 'Origin',
  'audit.filter.period': 'Period',
  'audit.loadMore': 'Load more',

  // ---------------------------------------------------- conta e segurança
  'account.title': 'Account',
  'account.subtitle': 'Your profile and how you sign in.',
  'account.profile': 'Profile',
  'account.security': 'Security',
  'account.changePassword': 'Change password',
  'account.currentPassword': 'Current password',
  'account.newPassword': 'New password',
  'account.dangerZone': 'Danger zone',
  'account.deleteAccount': 'Delete account',
  'account.deleteHint': 'This removes your access. Organization data stays with the organization.',
  'sessions.title': 'Sessions',
  'sessions.subtitle': 'Devices and browsers signed in to your account.',
  'sessions.empty': 'No other session is open.',
  'sessions.current': 'This device',
  'sessions.device': 'Device',
  'sessions.lastActive': 'Last active {relativeTime}',
  'sessions.createdAt': 'Signed in {relativeTime}',
  'sessions.ipAddress': 'IP address',

  // ------------------------------------------------------- administração
  'admin.title': 'Administration',
  'admin.subtitle': 'Plans and limits offered by this Hub.',
  'admin.plans.title': 'Plans',
  'admin.plans.subtitle': 'One plan per tier. Limits apply to every organization on that tier.',
  'admin.plans.empty': 'No plan is configured.',
  'admin.plans.create': 'New plan',
  'admin.plans.free': 'Free',
  'admin.plans.priceFree': 'Free',
  'admin.plans.pricePerMonth': '{price} / month',
  'admin.plans.current': 'Current plan',
  'admin.plans.default': 'Default for new organizations',
  'admin.plans.limits': 'Limits',
  'admin.plans.limit.organizations': 'Organizations',
  'admin.plans.limit.members': 'Members per organization',
  'admin.plans.limit.projects': 'Projects per organization',
  'admin.plans.limit.agents': 'Concurrent agents',
  'admin.plans.limit.messages': 'Messages per month',
  'admin.plans.limit.storage': 'Knowledge storage',
  'admin.plans.limit.retention': 'Audit retention',
  'admin.plans.unlimited': 'Unlimited',
  'admin.plans.days': '{count} days',
  'admin.plans.days.one': '{count} day',
  'admin.plans.organizationsOnPlan': '{count} organizations on this plan',
  'admin.plans.organizationsOnPlan.one': '{count} organization on this plan',
  'admin.plans.statusActive': 'Active',
  'admin.plans.statusHidden': 'Hidden',

  // -------------------------------------------------------------- diversos
  'common.beta': 'Beta',
  'common.provisionalData': 'Sample data',
  'common.provisionalDataHint':
    'The Hub API is not connected yet, so these screens show sample data.',
  'common.relativeNow': 'just now',
  'common.never': 'never',
  'common.unknown': 'Unknown',
  'common.of': '{current} of {total}',
} as const;

export type MessageKey = keyof typeof CATALOG;

/** Todo texto em inglês do produto, que é a chave usada nos bundles. */
export const SOURCE_STRINGS: readonly string[] = Object.values(CATALOG);
