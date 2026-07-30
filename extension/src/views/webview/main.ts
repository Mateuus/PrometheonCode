import type { ChatMessage } from '../../chat/types';
import type { PrometheonViewState } from '../../core/state';
import {
  AUTONOMY_DESCRIPTIONS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  HUB_STATE_LABELS,
  WORK_MODES,
  WORK_MODE_DESCRIPTIONS,
  WORK_MODE_LABELS,
  type ActiveAgentSummary,
} from '../../core/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../messages';

declare const acquireVsCodeApi: () => {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

/** Estado leve preservado quando a view é escondida e reconstruída. */
interface PersistedUi {
  readonly draft: string;
  readonly agentsOpen: boolean;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Elemento ausente no template: #${id}`);
  }
  return found as T;
}

const dom = {
  tabs: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-chat-type]')),
  hubBadge: element<HTMLSpanElement>('hub-badge'),
  openSettings: element<HTMLButtonElement>('open-settings'),
  bypassBanner: element<HTMLDivElement>('bypass-banner'),
  setupPanel: element<HTMLElement>('setup-panel'),
  setupDescription: element<HTMLParagraphElement>('setup-description'),
  setupButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-setup]')),
  webPanel: element<HTMLElement>('web-panel'),
  connectHub: element<HTMLButtonElement>('connect-hub'),
  messages: element<HTMLElement>('messages'),
  emptyState: element<HTMLDivElement>('empty-state'),
  agentsSection: element<HTMLDetailsElement>('agents-section'),
  agentsCount: element<HTMLSpanElement>('agents-count'),
  agentsList: element<HTMLUListElement>('agents-list'),
  thinking: element<HTMLDivElement>('thinking'),
  input: element<HTMLTextAreaElement>('composer-input'),
  workMode: element<HTMLSelectElement>('work-mode'),
  autonomy: element<HTMLSelectElement>('autonomy'),
  mainAgent: element<HTMLSelectElement>('main-agent'),
  clearChat: element<HTMLButtonElement>('clear-chat'),
  stopRun: element<HTMLButtonElement>('stop-run'),
  sendMessage: element<HTMLButtonElement>('send-message'),
};

let state: PrometheonViewState | null = null;
let currentRunId: string | null = null;
/** Nó de texto de cada mensagem, para aplicar deltas sem redesenhar a lista. */
const contentNodes = new Map<string, HTMLElement>();

function restoreUi(): void {
  const persisted = api.getState();
  if (typeof persisted === 'object' && persisted !== null) {
    const { draft, agentsOpen } = persisted as Partial<PersistedUi>;
    if (typeof draft === 'string') {
      dom.input.value = draft;
      autoGrow();
    }
    if (typeof agentsOpen === 'boolean') {
      dom.agentsSection.open = agentsOpen;
    }
  }
}

function persistUi(): void {
  const ui: PersistedUi = { draft: dom.input.value, agentsOpen: dom.agentsSection.open };
  api.setState(ui);
}

function post(message: WebviewToExtensionMessage): void {
  api.postMessage(message);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fillSelect(
  select: HTMLSelectElement,
  options: readonly { value: string; label: string; title?: string }[],
  selected: string,
): void {
  select.replaceChildren();
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    if (option.title !== undefined) {
      node.title = option.title;
    }
    select.append(node);
  }
  select.value = selected;
}

/** Monta o elemento de uma mensagem. Conteúdo sempre via textContent. */
function renderMessage(message: ChatMessage): HTMLElement {
  const item = document.createElement('article');
  item.className = `message message-${message.author} status-${message.status}`;

  const header = document.createElement('header');
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent =
    message.author === 'user' ? 'You' : (message.agentName ?? capitalize(message.author));
  header.append(author);

  if (message.author === 'agent' && message.agentId !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'agent-badge';
    badge.textContent = message.agentId;
    header.append(badge);
  }

  const time = document.createElement('time');
  time.textContent = formatTime(message.timestamp);
  header.append(time);

  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = message.status === 'sent' ? '' : message.status;
  header.append(status);

  const body = document.createElement('div');
  body.className = 'content';
  body.textContent = message.content;

  item.append(header, body);
  contentNodes.set(message.id, body);
  return item;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderMessages(messages: readonly ChatMessage[]): void {
  contentNodes.clear();
  dom.messages.replaceChildren(...messages.map(renderMessage));
  dom.emptyState.hidden = messages.length > 0;
  scrollToEnd();
}

function renderAgents(agents: readonly ActiveAgentSummary[]): void {
  dom.agentsCount.textContent = String(agents.length);
  dom.agentsList.replaceChildren(
    ...agents.map((agent) => {
      const item = document.createElement('li');
      item.className = `agent agent-${agent.status}`;

      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = agent.displayName;

      const role = document.createElement('span');
      role.className = 'agent-role';
      role.textContent = agent.role;

      const status = document.createElement('span');
      status.className = 'agent-status';
      status.textContent = agent.status;

      const task = document.createElement('span');
      task.className = 'agent-task';
      task.textContent = agent.task ?? '';

      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'agent-stop';
      stop.textContent = 'Stop';
      stop.disabled = agent.status === 'completed' || agent.status === 'stopped';
      stop.addEventListener('click', () =>
        post({ type: 'agents.stop', payload: { sessionId: agent.sessionId } }),
      );

      item.append(name, role, status, task, stop);
      return item;
    }),
  );
}

function scrollToEnd(): void {
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

function autoGrow(): void {
  dom.input.style.height = 'auto';
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, 180)}px`;
}

function render(next: PrometheonViewState): void {
  state = next;
  const isWeb = next.chatType === 'web';

  for (const tab of dom.tabs) {
    const active = tab.dataset['chatType'] === next.chatType;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }

  dom.hubBadge.textContent = HUB_STATE_LABELS[next.hub.state];
  dom.hubBadge.className = `hub-badge hub-${next.hub.state}`;
  if (next.hub.detail !== undefined) {
    dom.hubBadge.title = next.hub.detail;
  }

  const needsSetup = !isWeb && !next.workspace.configured && !next.workspace.skipped;
  dom.setupPanel.hidden = !needsSetup;
  if (needsSetup) {
    dom.setupDescription.textContent =
      next.workspace.folderName === null
        ? 'Open a folder to create a shared Prometheon workspace. Local Chat already works without one.'
        : `"${next.workspace.folderName}" has no .prometheon/prometheon.yaml yet. Local Chat already works without it.`;
  }

  dom.webPanel.hidden = !isWeb;
  dom.messages.hidden = isWeb;
  dom.agentsSection.hidden = isWeb;

  if (isWeb) {
    dom.emptyState.hidden = true;
  } else {
    renderMessages(next.messages);
  }

  fillSelect(
    dom.workMode,
    WORK_MODES.map((mode) => ({
      value: mode,
      label: WORK_MODE_LABELS[mode],
      title: WORK_MODE_DESCRIPTIONS[mode],
    })),
    next.workMode,
  );
  fillSelect(
    dom.autonomy,
    AUTONOMY_LEVELS.map((level) => ({
      value: level,
      label: AUTONOMY_LABELS[level],
      title: AUTONOMY_DESCRIPTIONS[level],
    })),
    next.autonomy,
  );
  fillSelect(
    dom.mainAgent,
    next.agents.map((agent) => ({
      value: agent.id,
      label: agent.displayName,
      title: agent.available ? 'Available' : 'Unavailable',
    })),
    next.mainAgentId,
  );

  renderAgents(next.activeAgents);

  const bypass = next.bypass;
  dom.bypassBanner.hidden = bypass === null;
  if (bypass !== null) {
    dom.bypassBanner.textContent = `Bypass permissions active — scope: ${bypass.scope}, duration: ${bypass.duration}. Expires when the extension restarts.`;
  }

  dom.input.disabled = isWeb;
  dom.sendMessage.disabled = isWeb || next.busy;
  dom.clearChat.disabled = isWeb || next.messages.length === 0;
  dom.stopRun.hidden = !next.busy;
  dom.thinking.hidden = !next.busy;
  dom.messages.setAttribute('aria-busy', String(next.busy));
}

function applyChatEvent(event: Extract<ExtensionToWebviewMessage, { type: 'chat.event' }>): void {
  const payload = event.payload;
  switch (payload.type) {
    case 'run.started':
      currentRunId = payload.runId;
      dom.emptyState.hidden = true;
      dom.messages.append(renderMessage(payload.message));
      scrollToEnd();
      break;

    case 'message.created':
      dom.messages.append(renderMessage(payload.message));
      scrollToEnd();
      break;

    case 'message.delta': {
      const node = contentNodes.get(payload.messageId);
      if (node !== undefined) {
        node.textContent = `${node.textContent ?? ''}${payload.delta}`;
        scrollToEnd();
      }
      break;
    }

    case 'message.completed': {
      const node = contentNodes.get(payload.messageId);
      if (node !== undefined) {
        node.textContent = payload.content;
        node.closest('.message')?.classList.replace('status-streaming', 'status-sent');
      }
      currentRunId = null;
      break;
    }

    case 'run.cancelled': {
      const node = contentNodes.get(payload.messageId);
      node?.closest('.message')?.classList.add('cancelled');
      currentRunId = null;
      break;
    }

    case 'run.failed':
      currentRunId = null;
      break;

    case 'agent.status':
      break;
  }
}

function showNotification(text: string, level: 'info' | 'warning' | 'error'): void {
  const item = document.createElement('article');
  item.className = `message message-system status-sent notification-${level}`;
  const body = document.createElement('div');
  body.className = 'content';
  body.textContent = text;
  item.append(body);
  dom.messages.append(item);
  dom.emptyState.hidden = true;
  scrollToEnd();
}

function send(): void {
  const content = dom.input.value.trim();
  if (content === '' || state === null || state.chatType === 'web') {
    return;
  }
  post({ type: 'chat.send', payload: { content } });
  dom.input.value = '';
  autoGrow();
  persistUi();
}

dom.sendMessage.addEventListener('click', send);

dom.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

dom.input.addEventListener('input', () => {
  autoGrow();
  persistUi();
});

dom.stopRun.addEventListener('click', () => {
  if (currentRunId !== null) {
    post({ type: 'chat.cancel', payload: { runId: currentRunId } });
  }
});

dom.clearChat.addEventListener('click', () => post({ type: 'chat.clearLocal' }));
dom.openSettings.addEventListener('click', () => post({ type: 'settings.open' }));
dom.connectHub.addEventListener('click', () => post({ type: 'hub.connect.request' }));

dom.agentsSection.addEventListener('toggle', persistUi);

for (const tab of dom.tabs) {
  tab.addEventListener('click', () => {
    const chatType = tab.dataset['chatType'];
    if (chatType === 'local' || chatType === 'web') {
      post({ type: 'chat.selectType', payload: { chatType } });
    }
  });
}

for (const button of dom.setupButtons) {
  button.addEventListener('click', () => {
    const choice = button.dataset['setup'];
    if (choice === 'current' || choice === 'external' || choice === 'skip') {
      post({ type: 'workspace.initialize', payload: { choice } });
    }
  });
}

dom.workMode.addEventListener('change', () => {
  const mode = WORK_MODES.find((candidate) => candidate === dom.workMode.value);
  if (mode !== undefined) {
    post({ type: 'settings.setWorkMode', payload: { mode } });
  }
});

dom.autonomy.addEventListener('change', () => {
  const autonomy = AUTONOMY_LEVELS.find((candidate) => candidate === dom.autonomy.value);
  if (autonomy !== undefined) {
    post({ type: 'settings.setAutonomy', payload: { autonomy } });
  }
});

dom.mainAgent.addEventListener('change', () => {
  post({ type: 'settings.selectMainAgent', payload: { agentId: dom.mainAgent.value } });
});

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'state.snapshot':
      render(message.payload);
      break;
    case 'chat.event':
      applyChatEvent(message);
      break;
    case 'chat.error':
      showNotification(message.payload.message, 'error');
      break;
    case 'agents.updated':
      renderAgents(message.payload);
      break;
    case 'hub.status':
      dom.hubBadge.textContent = HUB_STATE_LABELS[message.payload.state];
      dom.hubBadge.className = `hub-badge hub-${message.payload.state}`;
      break;
    case 'notification':
      showNotification(message.payload.message, message.payload.level);
      break;
  }
});

restoreUi();
post({ type: 'ui.ready' });
