import type { ChatMessage, ConversationSummary, ImageAttachment } from '../../chat/types';
import { IMAGE_MIME_TYPES, type ImageMimeType } from '../../chat/types';
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
  type ChatType,
} from '../../core/types';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  type DraftAttachment,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from '../messages';

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
  sessionTitle: element<HTMLSpanElement>('session-title'),
  toggleSessions: element<HTMLButtonElement>('toggle-sessions'),
  newSession: element<HTMLButtonElement>('new-session'),
  sessionsPopover: element<HTMLDivElement>('sessions-popover'),
  segments: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-chat-type]')),
  sessionSearch: element<HTMLInputElement>('session-search'),
  sessionList: element<HTMLUListElement>('session-list'),
  sessionEmpty: element<HTMLParagraphElement>('session-empty'),
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
  activity: element<HTMLDivElement>('activity'),
  activityLabel: element<HTMLSpanElement>('activity-label'),
  activityDetail: element<HTMLSpanElement>('activity-detail'),
  activityElapsed: element<HTMLSpanElement>('activity-elapsed'),
  openAccounts: element<HTMLButtonElement>('open-accounts'),
  accountsModal: element<HTMLDivElement>('accounts-modal'),
  accountsBody: element<HTMLDivElement>('accounts-body'),
  closeAccounts: element<HTMLButtonElement>('close-accounts'),
  addAccount: element<HTMLButtonElement>('add-account'),
  composerCard: element<HTMLDivElement>('composer-card'),
  attachments: element<HTMLDivElement>('attachments'),
  attachImage: element<HTMLButtonElement>('attach-image'),
  input: element<HTMLTextAreaElement>('composer-input'),
  iconTemplates: element<HTMLTemplateElement>('icon-templates'),
  dictate: element<HTMLButtonElement>('dictate'),
  clearChat: element<HTMLButtonElement>('clear-chat'),
  stopRun: element<HTMLButtonElement>('stop-run'),
  sendMessage: element<HTMLButtonElement>('send-message'),
  lightbox: element<HTMLDivElement>('lightbox'),
  lightboxImage: element<HTMLImageElement>('lightbox-image'),
  lightboxCaption: element<HTMLSpanElement>('lightbox-caption'),
  lightboxClose: element<HTMLButtonElement>('lightbox-close'),
};

let state: PrometheonViewState | null = null;
let currentRunId: string | null = null;
/** Nó de texto de cada mensagem, para aplicar deltas sem redesenhar a lista. */
const contentNodes = new Map<string, HTMLElement>();
/** Imagens do rascunho atual; só saem daqui quando a mensagem é enviada. */
let drafts: DraftAttachment[] = [];

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

/** Idade curta, no formato do histórico: "now", "1m", "3h", "2d". */
function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) {
    return 'now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dataUrl(attachment: DraftAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

// ---------- Menus do composer ----------

interface MenuOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly icon: string;
}

/** Clona um ícone declarado no `<template>` do HTML. */
function icon(name: string): SVGElement | null {
  const found = dom.iconTemplates.content.querySelector<SVGElement>(`[data-icon="${name}"]`);
  return found === null ? null : (found.cloneNode(true) as SVGElement);
}

/**
 * Menu de escolha única no estilo do composer: ícone, nome, descrição e a marca
 * no item ativo. Substitui o `<select>` nativo, que não mostra a descrição de
 * cada opção — justamente o que ajuda a escolher modo e autonomia.
 */
class OptionMenu {
  private readonly iconSlot: HTMLElement;
  private readonly labelSlot: HTMLElement;
  private readonly itemsSlot: HTMLElement;
  private options: readonly MenuOption[] = [];
  private selected = '';

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly menu: HTMLDivElement,
    private readonly onSelect: (value: string) => void,
  ) {
    this.iconSlot = this.slot(button, 'icon');
    this.labelSlot = this.slot(button, 'label');
    this.itemsSlot = this.slot(menu, 'items');

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    menu.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  get isOpen(): boolean {
    return !this.menu.hidden;
  }

  update(options: readonly MenuOption[], selected: string): void {
    this.options = options;
    this.selected = selected;

    const current = options.find((option) => option.value === selected);
    this.iconSlot.replaceChildren(...nodes(icon(current?.icon ?? 'agent')));
    this.labelSlot.textContent = current?.label ?? selected;
    this.button.title = current?.description ?? '';
    if (this.isOpen) {
      this.renderItems();
    }
  }

  open(): void {
    closeAllMenus(this);
    this.renderItems();
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.menu.querySelector<HTMLButtonElement>('.menu-item.active')?.focus();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }

  setDisabled(disabled: boolean): void {
    this.button.disabled = disabled;
    if (disabled) {
      this.close();
    }
  }

  private renderItems(): void {
    this.itemsSlot.replaceChildren(...this.options.map((option) => this.renderItem(option)));
  }

  private renderItem(option: MenuOption): HTMLElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitemradio');
    const active = option.value === this.selected;
    item.classList.toggle('active', active);
    item.setAttribute('aria-checked', String(active));

    const glyph = document.createElement('span');
    glyph.className = 'menu-item-icon';
    glyph.append(...nodes(icon(option.icon)));

    const text = document.createElement('span');
    text.className = 'menu-item-text';

    const label = document.createElement('span');
    label.className = 'menu-item-label';
    label.textContent = option.label;
    text.append(label);

    if (option.description !== undefined) {
      const description = document.createElement('span');
      description.className = 'menu-item-description';
      description.textContent = option.description;
      text.append(description);
    }

    const check = document.createElement('span');
    check.className = 'menu-item-check';
    if (active) {
      check.append(...nodes(icon('check')));
    }

    item.append(glyph, text, check);
    item.addEventListener('click', () => {
      this.close();
      this.button.focus();
      if (option.value !== this.selected) {
        this.onSelect(option.value);
      }
    });
    return item;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>('.menu-item'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(current + step + items.length) % items.length];
    next?.focus();
  }

  private slot(root: HTMLElement, name: string): HTMLElement {
    const found = root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
    if (found === null) {
      throw new Error(`Slot ausente no template: [data-slot="${name}"]`);
    }
    return found;
  }
}

function nodes(node: Node | null): Node[] {
  return node === null ? [] : [node];
}

const menus = {
  workMode: new OptionMenu(
    element<HTMLButtonElement>('work-mode-button'),
    element<HTMLDivElement>('work-mode-menu'),
    (value) => {
      const mode = WORK_MODES.find((candidate) => candidate === value);
      if (mode !== undefined) {
        post({ type: 'settings.setWorkMode', payload: { mode } });
      }
    },
  ),
  autonomy: new OptionMenu(
    element<HTMLButtonElement>('autonomy-button'),
    element<HTMLDivElement>('autonomy-menu'),
    (value) => {
      const autonomy = AUTONOMY_LEVELS.find((candidate) => candidate === value);
      if (autonomy !== undefined) {
        post({ type: 'settings.setAutonomy', payload: { autonomy } });
      }
    },
  ),
  mainAgent: new OptionMenu(
    element<HTMLButtonElement>('main-agent-button'),
    element<HTMLDivElement>('main-agent-menu'),
    (agentId) => post({ type: 'settings.selectMainAgent', payload: { agentId } }),
  ),
};

function closeAllMenus(except?: OptionMenu): void {
  for (const menu of Object.values(menus)) {
    if (menu !== except) {
      menu.close();
    }
  }
}

// ---------- Visualizador de imagem ----------

function openLightbox(attachment: DraftAttachment): void {
  dom.lightboxImage.src = dataUrl(attachment);
  dom.lightboxImage.alt = attachment.name;
  dom.lightboxCaption.textContent = `${attachment.name} · ${formatSize(attachment.byteSize)}`;
  dom.lightbox.hidden = false;
  dom.lightboxClose.focus();
}

function closeLightbox(): void {
  dom.lightbox.hidden = true;
  dom.lightboxImage.removeAttribute('src');
}

/** Miniatura quadrada, usada nas mensagens já enviadas. */
function renderThumbnail(attachment: DraftAttachment): HTMLElement {
  const item = document.createElement('div');
  item.className = 'thumb';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'thumb-open';
  button.title = `${attachment.name} · ${describe(attachment)}`;
  button.setAttribute('aria-label', `Open ${attachment.name}`);
  button.addEventListener('click', () => openLightbox(attachment));

  const image = document.createElement('img');
  image.src = dataUrl(attachment);
  image.alt = attachment.name;
  button.append(image);
  item.append(button);
  return item;
}

/** Faixa do anexo no composer: miniatura, nome, dimensões e o botão de remover. */
function renderAttachmentChip(attachment: DraftAttachment, onRemove: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'chip';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'chip-open';
  open.title = `${attachment.name} · ${describe(attachment)}`;
  open.setAttribute('aria-label', `Open ${attachment.name}`);
  open.addEventListener('click', () => openLightbox(attachment));

  const image = document.createElement('img');
  image.src = dataUrl(attachment);
  image.alt = '';

  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = attachment.name;

  const meta = document.createElement('span');
  meta.className = 'chip-meta';
  meta.textContent = describe(attachment);

  open.append(image, name, meta);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'chip-remove';
  remove.textContent = '×';
  remove.title = 'Remove image';
  remove.setAttribute('aria-label', `Remove ${attachment.name}`);
  remove.addEventListener('click', onRemove);

  item.append(open, remove);
  return item;
}

/** Dimensões quando conhecidas — é o que identifica um print —, senão o peso. */
function describe(attachment: DraftAttachment): string {
  return attachment.width !== undefined && attachment.height !== undefined
    ? `${attachment.width}×${attachment.height}`
    : formatSize(attachment.byteSize);
}

// ---------- Anexos do rascunho ----------

function renderDrafts(): void {
  dom.attachments.hidden = drafts.length === 0;
  dom.attachments.replaceChildren(
    ...drafts.map((attachment, index) =>
      renderAttachmentChip(attachment, () => {
        drafts = drafts.filter((_item, position) => position !== index);
        renderDrafts();
      }),
    ),
  );
  dom.attachImage.disabled = drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE;
  updateSendState();
}

function addDrafts(attachments: readonly DraftAttachment[]): void {
  const room = MAX_ATTACHMENTS_PER_MESSAGE - drafts.length;
  if (room <= 0) {
    showNotification(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`, 'warning');
    return;
  }
  const accepted = attachments.slice(0, room);
  if (accepted.length < attachments.length) {
    showNotification(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} images per message.`, 'warning');
  }
  drafts = [...drafts, ...accepted];
  renderDrafts();
}

function toBase64(bytes: Uint8Array): string {
  // Em blocos para não estourar o limite de argumentos de String.fromCharCode.
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function isImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

async function readFileAsAttachment(file: File): Promise<DraftAttachment | null> {
  if (!isImageMimeType(file.type)) {
    showNotification(`Unsupported image format: ${file.name || file.type}`, 'warning');
    return null;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showNotification(
      `Image is larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`,
      'warning',
    );
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    name: file.name === '' ? `pasted-image.${file.type.split('/')[1] ?? 'png'}` : file.name,
    mimeType: file.type,
    data: toBase64(bytes),
    byteSize: bytes.byteLength,
    ...(await measure(file)),
  };
}

/** Dimensões da imagem. Se ela não decodificar, o anexo segue sem elas. */
async function measure(blob: Blob): Promise<{ width?: number; height?: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}

async function acceptFiles(files: readonly File[]): Promise<void> {
  const parsed = await Promise.all(files.map((file) => readFileAsAttachment(file)));
  const accepted = parsed.filter((item): item is DraftAttachment => item !== null);
  if (accepted.length > 0) {
    addDrafts(accepted);
  }
}

// ---------- Atividade ----------

let elapsedTimer = 0;

/** Barra acima do composer: o que o agente faz agora e com qual conta. */
function renderActivity(activity: PrometheonViewState['activity']): void {
  const running = activity.phase !== 'idle';
  dom.activity.hidden = !running;
  dom.activityLabel.textContent = activity.label;
  dom.activityDetail.textContent = activity.detail ?? '';
  dom.activity.className = `activity phase-${activity.phase}`;

  window.clearInterval(elapsedTimer);
  if (!running || activity.startedAt === null) {
    dom.activityElapsed.textContent = '';
    return;
  }
  const startedAt = activity.startedAt;
  const tick = (): void => {
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    dom.activityElapsed.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  tick();
  elapsedTimer = window.setInterval(tick, 1000);
}

// ---------- Contas e uso ----------

function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  return count < 1_000_000 ? `${(count / 1000).toFixed(1)}k` : `${(count / 1_000_000).toFixed(1)}M`;
}

function openAccounts(): void {
  // Desenha já com o que temos e pede a releitura: consultar o `auth status` de
  // cada CLI leva tempo, e abrir num painel vazio pareceria erro.
  renderAccounts(state?.accounts ?? []);
  dom.accountsModal.hidden = false;
  dom.closeAccounts.focus();
  post({ type: 'accounts.refresh' });
}

function closeAccounts(): void {
  dom.accountsModal.hidden = true;
}

function renderAccounts(accounts: PrometheonViewState['accounts']): void {
  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'accounts-empty';
    empty.textContent =
      'No account yet. Add one to give an agent its own CLI sign-in, isolated from the others.';
    dom.accountsBody.replaceChildren(empty);
    return;
  }
  dom.accountsBody.replaceChildren(...accounts.map(renderAccount));
}

function renderAccount(account: PrometheonViewState['accounts'][number]): HTMLElement {
  const card = document.createElement('section');
  card.className = `account ${account.authenticated ? 'signed-in' : 'signed-out'}`;

  const header = document.createElement('header');
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = account.name;

  const state = document.createElement('span');
  state.className = 'account-state';
  state.textContent = account.authenticated
    ? 'Signed in'
    : account.cliInstalled
      ? 'Signed out'
      : 'CLI missing';

  header.append(name, state);
  card.append(header);

  const rows: [string, string][] = [
    ['Provider', account.cliVersion === undefined ? account.providerName : `${account.providerName} ${account.cliVersion}`],
  ];
  if (account.authMethod !== undefined) {
    rows.push(['Auth method', account.authMethod]);
  }
  if (account.accountLabel !== undefined) {
    rows.push(['Email', account.accountLabel]);
  }
  if (account.organization !== undefined) {
    rows.push(['Organization', account.organization]);
  }
  if (account.plan !== undefined) {
    rows.push(['Plan', account.plan]);
  }
  if (account.message !== undefined && !account.authenticated) {
    rows.push(['Status', account.message]);
  }
  card.append(definitionList(rows));

  const usage = document.createElement('div');
  usage.className = 'usage';
  const title = document.createElement('span');
  title.className = 'usage-title';
  title.textContent = 'Tokens measured locally';
  usage.append(title);
  usage.append(
    definitionList([
      ['Today', tokenPair(account.usage.today)],
      ['Last 7 days', tokenPair(account.usage.last7Days)],
      ['All time', `${tokenPair(account.usage.total)} · ${account.usage.runs} runs`],
    ]),
  );
  card.append(usage);

  const directory = document.createElement('code');
  directory.className = 'account-directory';
  directory.textContent = account.configDirectory;
  directory.title = account.configDirectory;
  card.append(directory);

  const actions = document.createElement('div');
  actions.className = 'account-actions';
  actions.append(
    accountButton(account.authenticated ? 'Sign in again' : 'Sign in', () =>
      post({ type: 'accounts.login', payload: { profileId: account.profileId } }),
    ),
    accountButton('Sign out', () =>
      post({ type: 'accounts.logout', payload: { profileId: account.profileId } }),
    ),
    accountButton('Remove', () =>
      post({ type: 'accounts.remove', payload: { profileId: account.profileId } }),
    ),
  );
  card.append(actions);
  return card;
}

function tokenPair(usage: { input: number; output: number }): string {
  return `↑ ${formatTokens(usage.input)} · ↓ ${formatTokens(usage.output)}`;
}

function definitionList(rows: readonly [string, string][]): HTMLElement {
  const list = document.createElement('dl');
  list.className = 'facts';
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

function accountButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// ---------- Ditado ----------

/** Abaixo disto o Ctrl+D (ou o clique) conta como toque, e não como segurar. */
const HOLD_THRESHOLD_MS = 350;

const dictation = {
  /** Verdadeiro entre o início do gesto e a decisão entre toque e segurar. */
  pending: false,
  holdTimer: 0,
  /** Segurando: soltar encerra a gravação. */
  holding: false,
};

function speechAvailable(): boolean {
  return state?.speech.available === true;
}

function isListening(): boolean {
  return state?.speech.state === 'listening';
}

function startDictation(): void {
  if (!speechAvailable() || isListening()) {
    return;
  }
  post({ type: 'speech.start' });
}

function stopDictation(): void {
  if (!isListening()) {
    return;
  }
  post({ type: 'speech.stop' });
}

/**
 * Toque alterna, segurar grava enquanto o gesto durar — o mesmo gesto vale para
 * o botão e para o atalho, por isso a decisão fica num lugar só.
 */
function beginDictationGesture(): void {
  if (dictation.pending || dictation.holding) {
    return;
  }
  if (!speechAvailable()) {
    // Sem motor, o clique ainda avisa o motivo em vez de não fazer nada.
    post({ type: 'speech.start' });
    return;
  }
  if (isListening()) {
    stopDictation();
    return;
  }

  dictation.pending = true;
  startDictation();
  dictation.holdTimer = window.setTimeout(() => {
    if (dictation.pending) {
      dictation.pending = false;
      dictation.holding = true;
    }
  }, HOLD_THRESHOLD_MS);
}

function endDictationGesture(): void {
  window.clearTimeout(dictation.holdTimer);
  if (dictation.holding) {
    dictation.holding = false;
    stopDictation();
    return;
  }
  // Gesto curto: virou toque, e a gravação continua até o próximo toque.
  dictation.pending = false;
}

function renderDictation(speech: PrometheonViewState['speech']): void {
  const listening = speech.state === 'listening';
  const transcribing = speech.state === 'transcribing';
  dom.dictate.classList.toggle('listening', listening);
  dom.dictate.classList.toggle('transcribing', transcribing);
  dom.dictate.setAttribute('aria-pressed', String(listening));
  dom.dictate.disabled = state?.chatType === 'web' || transcribing;
  dom.dictate.title = !speech.available
    ? (speech.detail ?? 'Dictation unavailable.')
    : listening
      ? 'Listening… tap Ctrl+D to stop'
      : transcribing
        ? 'Transcribing…'
        : 'Dictate — tap or hold Ctrl+D to record';
}

/** Insere o texto ditado onde está o cursor, sem apagar o que já foi escrito. */
function insertTranscript(text: string): void {
  const input = dom.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const spacer = before === '' || before.endsWith(' ') || before.endsWith('\n') ? '' : ' ';
  input.value = `${before}${spacer}${text}${after}`;
  const caret = start + spacer.length + text.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  autoGrow();
  updateSendState();
  persistUi();
}

// ---------- Histórico de sessões ----------

function isPopoverOpen(): boolean {
  return !dom.sessionsPopover.hidden;
}

function openPopover(): void {
  dom.sessionsPopover.hidden = false;
  dom.toggleSessions.setAttribute('aria-expanded', 'true');
  dom.sessionSearch.value = '';
  renderSessions();
  dom.sessionSearch.focus();
}

function closePopover(): void {
  dom.sessionsPopover.hidden = true;
  dom.toggleSessions.setAttribute('aria-expanded', 'false');
}

function renderSessions(): void {
  const sessions = state?.sessions ?? [];
  const query = dom.sessionSearch.value.trim().toLowerCase();
  const visible =
    query === ''
      ? sessions
      : sessions.filter((session) => session.title.toLowerCase().includes(query));

  dom.sessionEmpty.hidden = visible.length > 0;
  dom.sessionEmpty.textContent =
    sessions.length === 0
      ? state?.chatType === 'web'
        ? 'Web sessions need a connected Hub.'
        : 'No sessions yet.'
      : 'No session matches this search.';

  dom.sessionList.replaceChildren(...visible.map(renderSessionItem));
}

function renderSessionItem(session: ConversationSummary): HTMLElement {
  const item = document.createElement('li');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session';
  button.setAttribute('role', 'option');
  const active = session.id === state?.conversationId;
  button.classList.toggle('active', active);
  button.setAttribute('aria-selected', String(active));

  const title = document.createElement('span');
  title.className = 'session-name';
  title.textContent = session.title;

  const age = document.createElement('span');
  age.className = 'session-age';
  age.textContent = formatAge(session.updatedAt);

  button.append(title, age);
  button.addEventListener('click', () => {
    closePopover();
    if (!active) {
      post({ type: 'chat.openSession', payload: { conversationId: session.id } });
    }
  });

  item.append(button);
  return item;
}

// ---------- Mensagens ----------

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

  if (message.usage !== undefined) {
    header.append(usageBadge(message.usage));
  }

  const body = document.createElement('div');
  body.className = 'content';
  body.textContent = message.content;

  item.append(header, body);

  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    const gallery = document.createElement('div');
    gallery.className = 'attachments message-attachments';
    gallery.append(...attachments.map((attachment) => renderThumbnail(attachment)));
    item.append(gallery);
  }

  contentNodes.set(message.id, body);
  return item;
}

/** Tokens da resposta, no cabeçalho da mensagem: `↑ entrada · ↓ saída`. */
function usageBadge(usage: { input: number; output: number }): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'usage-badge';
  badge.textContent = `↑ ${formatTokens(usage.input)} ↓ ${formatTokens(usage.output)}`;
  badge.title = `${usage.input} input tokens · ${usage.output} output tokens`;
  return badge;
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
      role.className = `agent-role agent-role-${agent.role}`;
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

/** O botão de enviar acompanha o rascunho: texto ou imagem já bastam. */
function updateSendState(): void {
  const isWeb = state?.chatType === 'web';
  const empty = dom.input.value.trim() === '' && drafts.length === 0;
  dom.sendMessage.disabled = isWeb || (state?.busy ?? false) || empty;
}

function render(next: PrometheonViewState): void {
  state = next;
  const isWeb = next.chatType === 'web';

  for (const segment of dom.segments) {
    const active = segment.dataset['chatType'] === next.chatType;
    segment.classList.toggle('active', active);
    segment.setAttribute('aria-selected', String(active));
  }

  dom.sessionTitle.textContent = next.conversationTitle;
  dom.sessionTitle.title = next.conversationTitle;
  if (isPopoverOpen()) {
    renderSessions();
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

  menus.workMode.update(
    WORK_MODES.map((mode) => ({
      value: mode,
      label: WORK_MODE_LABELS[mode],
      description: WORK_MODE_DESCRIPTIONS[mode],
      icon: mode,
    })),
    next.workMode,
  );
  menus.autonomy.update(
    AUTONOMY_LEVELS.map((level) => ({
      value: level,
      label: AUTONOMY_LABELS[level],
      description: AUTONOMY_DESCRIPTIONS[level],
      icon: level,
    })),
    next.autonomy,
  );
  menus.mainAgent.update(
    next.agents.map((agent) => ({
      value: agent.id,
      label: agent.displayName,
      description: agent.available
        ? `Available · ${agent.transport}`
        : `Unavailable · ${agent.transport}`,
      icon: 'agent',
    })),
    next.mainAgentId,
  );

  renderAgents(next.activeAgents);

  const bypass = next.bypass;
  dom.bypassBanner.hidden = bypass === null;
  if (bypass !== null) {
    dom.bypassBanner.textContent = `Bypass permissions active — scope: ${bypass.scope}, duration: ${bypass.duration}. Expires when the extension restarts.`;
  }

  renderActivity(next.activity);
  if (!dom.accountsModal.hidden) {
    renderAccounts(next.accounts);
  }
  renderDictation(next.speech);
  dom.input.disabled = isWeb;
  dom.attachImage.disabled = isWeb || drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE;
  menus.workMode.setDisabled(isWeb);
  menus.autonomy.setDisabled(isWeb);
  menus.mainAgent.setDisabled(isWeb);
  dom.clearChat.disabled = isWeb || next.messages.length === 0;
  dom.stopRun.hidden = !next.busy;
  dom.messages.setAttribute('aria-busy', String(next.busy));
  updateSendState();
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
        const message = node.closest('.message');
        message?.classList.replace('status-streaming', 'status-sent');
        if (payload.usage !== undefined) {
          message?.querySelector('header')?.append(usageBadge(payload.usage));
        }
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
  if (state === null || state.chatType === 'web') {
    return;
  }
  if (content === '' && drafts.length === 0) {
    return;
  }
  post({ type: 'chat.send', payload: { content, attachments: drafts } });
  drafts = [];
  renderDrafts();
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
  updateSendState();
  persistUi();
});

dom.input.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length === 0) {
    return;
  }
  // Só interceptamos quando há imagem: colar texto continua funcionando.
  event.preventDefault();
  void acceptFiles(files);
});

dom.composerCard.addEventListener('dragover', (event: DragEvent) => {
  event.preventDefault();
  dom.composerCard.classList.add('dropping');
});
dom.composerCard.addEventListener('dragleave', () =>
  dom.composerCard.classList.remove('dropping'),
);
dom.composerCard.addEventListener('drop', (event: DragEvent) => {
  dom.composerCard.classList.remove('dropping');
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void acceptFiles(files);
});

dom.attachImage.addEventListener('click', () => post({ type: 'chat.attachImages' }));

// Ditado pelo botão: pressionar começa o gesto, soltar decide toque ou segurar.
dom.dictate.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  beginDictationGesture();
});
dom.dictate.addEventListener('pointerup', endDictationGesture);
dom.dictate.addEventListener('pointercancel', endDictationGesture);
dom.dictate.addEventListener('pointerleave', () => {
  if (dictation.holding) {
    endDictationGesture();
  }
});

dom.stopRun.addEventListener('click', () => {
  if (currentRunId !== null) {
    post({ type: 'chat.cancel', payload: { runId: currentRunId } });
  }
});

dom.clearChat.addEventListener('click', () => post({ type: 'chat.clearLocal' }));
dom.openSettings.addEventListener('click', () => post({ type: 'settings.open' }));
dom.connectHub.addEventListener('click', () => post({ type: 'hub.connect.request' }));

dom.openAccounts.addEventListener('click', (event) => {
  event.stopPropagation();
  openAccounts();
});
dom.closeAccounts.addEventListener('click', closeAccounts);
dom.addAccount.addEventListener('click', () => post({ type: 'accounts.add' }));
dom.accountsModal.addEventListener('click', (event) => {
  if (event.target === dom.accountsModal) {
    closeAccounts();
  }
});

dom.newSession.addEventListener('click', () => {
  closePopover();
  post({ type: 'chat.newLocal' });
});

dom.toggleSessions.addEventListener('click', (event) => {
  event.stopPropagation();
  if (isPopoverOpen()) {
    closePopover();
  } else {
    openPopover();
  }
});

dom.sessionSearch.addEventListener('input', renderSessions);
dom.sessionsPopover.addEventListener('click', (event) => event.stopPropagation());

document.addEventListener('click', () => {
  closeAllMenus();
  if (isPopoverOpen()) {
    closePopover();
  }
});

// Ctrl+D dentro do painel é ditado. O atalho é tratado aqui, e não como
// keybinding do VS Code, para não sequestrar o Ctrl+D do editor.
document.addEventListener('keydown', (event) => {
  if (!(event.key === 'd' || event.key === 'D') || !event.ctrlKey || event.altKey) {
    return;
  }
  event.preventDefault();
  // `repeat` chega enquanto a tecla fica pressionada: é o sinal de "segurando".
  if (!event.repeat) {
    beginDictationGesture();
  }
});

document.addEventListener('keyup', (event) => {
  if (event.key === 'd' || event.key === 'D' || event.key === 'Control') {
    endDictationGesture();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (isListening()) {
    post({ type: 'speech.cancel' });
    return;
  }
  if (!dom.lightbox.hidden) {
    closeLightbox();
    return;
  }
  if (!dom.accountsModal.hidden) {
    closeAccounts();
    return;
  }
  closeAllMenus();
  if (isPopoverOpen()) {
    closePopover();
    dom.toggleSessions.focus();
  }
});

dom.lightboxClose.addEventListener('click', closeLightbox);
dom.lightbox.addEventListener('click', (event) => {
  // Clicar fora da imagem fecha; clicar nela, não.
  if (event.target !== dom.lightboxImage) {
    closeLightbox();
  }
});

dom.agentsSection.addEventListener('toggle', persistUi);

for (const segment of dom.segments) {
  segment.addEventListener('click', () => {
    const chatType = segment.dataset['chatType'];
    if (chatType === 'local' || chatType === 'web') {
      post({ type: 'chat.selectType', payload: { chatType: chatType satisfies ChatType } });
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
    case 'attachments.added':
      void draftsFromExtension(message.payload.attachments).then(addDrafts);
      break;
    case 'speech.transcript':
      insertTranscript(message.payload.text);
      break;
    case 'activity':
      renderActivity(message.payload);
      break;
    case 'accounts.open':
      openAccounts();
      break;
    case 'notification':
      showNotification(message.payload.message, message.payload.level);
      break;
  }
});

/**
 * Anexos escolhidos em disco chegam sem dimensões: o `id` fica do lado da
 * extensão e a medição acontece aqui, onde há decodificador de imagem.
 */
async function draftsFromExtension(
  attachments: readonly ImageAttachment[],
): Promise<DraftAttachment[]> {
  return Promise.all(
    attachments.map(async ({ id: _id, ...attachment }) => ({
      ...attachment,
      ...(await measure(toBlob(attachment))),
    })),
  );
}

function toBlob(attachment: DraftAttachment): Blob {
  const binary = atob(attachment.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: attachment.mimeType });
}

restoreUi();
renderDrafts();
post({ type: 'ui.ready' });
