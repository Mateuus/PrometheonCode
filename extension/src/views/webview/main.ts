import {
  MAX_CUSTOM_ANSWER_LENGTH,
  type AgentQuestion,
  type AgentQuestionAnswer,
  type AgentQuestionRequest,
} from '../../agents/questions';
import type {
  AgentStep,
  ChatMessage,
  ConversationSummary,
  ImageAttachment,
} from '../../chat/types';
import type { LanguageChoice } from '../../i18n/language';
import {
  IMAGE_MIME_TYPES,
  MAX_STEP_OUTPUT_CHARS,
  type ImageMimeType,
} from '../../chat/types';
import type { PrometheonViewState } from '../../core/state';
import {
  AGENT_AUTONOMY_MODES,
  AGENT_AUTONOMY_MODE_DESCRIPTIONS,
  AGENT_AUTONOMY_MODE_LABELS,
  AGENT_ROLES,
  AGENT_ROLE_DESCRIPTIONS,
  AGENT_ROLE_LABELS,
  AUTONOMY_DESCRIPTIONS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  CONTEXT_STRATEGIES,
  CONTEXT_STRATEGY_DESCRIPTIONS,
  CONTEXT_STRATEGY_LABELS,
  HUB_STATE_LABELS,
  MAX_CONCURRENT_SESSIONS,
  MAX_MODEL_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_MCP_COMMAND_LENGTH,
  MAX_MCP_NAME_LENGTH,
  MAX_MCP_URL_LENGTH,
  MCP_TRANSPORTS,
  MCP_TRANSPORT_DESCRIPTIONS,
  MCP_TRANSPORT_LABELS,
  WORK_MODES,
  WORK_MODE_DESCRIPTIONS,
  WORK_MODE_LABELS,
  type ActiveAgentSummary,
  type AgentAutonomyMode,
  type AgentProfileSummary,
  type AgentRole,
  type ChatType,
  type ContextStrategy,
  type McpKeyValue,
  type McpServerDraft,
  type McpServerSummary,
  type McpTransport,
} from '../../core/types';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  SETTINGS_SECTIONS,
  type AgentProfileDraft,
  type DraftAttachment,
  type ExtensionToWebviewMessage,
  type SettingsSection,
  type WebviewToExtensionMessage,
} from '../messages';

declare const acquireVsCodeApi: () => {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

/**
 * Dicionário do idioma ativo, entregue no HTML pela extensão e indexado pelo
 * texto em inglês. A webview não alcança `vscode.l10n`; o que não estiver aqui
 * aparece em inglês, que é a fonte.
 */
const STRINGS: Readonly<Record<string, string>> = (() => {
  try {
    const parsed: unknown = JSON.parse(document.body.dataset['strings'] ?? '{}');
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
})();

/** Texto da interface no idioma ativo. A chave é a própria frase em inglês. */
function s(english: string): string {
  return STRINGS[english] ?? english;
}

/**
 * Texto com valores no meio: os marcadores são `{0}`, `{1}`… como no
 * `vscode.l10n`. A tradução pode reordenar os marcadores sem tocar no código.
 */
function sf(english: string, ...values: readonly (string | number)[]): string {
  return s(english).replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? match : String(value);
  });
}

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
  working: element<HTMLDivElement>('working'),
  workingWord: element<HTMLSpanElement>('working-word'),
  workingElapsed: element<HTMLSpanElement>('working-elapsed'),
  agentsSection: element<HTMLDetailsElement>('agents-section'),
  agentsCount: element<HTMLSpanElement>('agents-count'),
  agentsList: element<HTMLUListElement>('agents-list'),
  activity: element<HTMLDivElement>('activity'),
  activityLabel: element<HTMLSpanElement>('activity-label'),
  activityDetail: element<HTMLSpanElement>('activity-detail'),
  activityElapsed: element<HTMLSpanElement>('activity-elapsed'),
  activityTokens: element<HTMLSpanElement>('activity-tokens'),
  workingTokens: element<HTMLSpanElement>('working-tokens'),
  openSettingsModal: element<HTMLButtonElement>('open-settings-modal'),
  settingsModal: element<HTMLDivElement>('settings-modal'),
  settingsNav: element<HTMLElement>('settings-nav'),
  settingsPane: element<HTMLDivElement>('settings-pane'),
  closeSettings: element<HTMLButtonElement>('close-settings'),
  composerCard: element<HTMLDivElement>('composer-card'),
  attachments: element<HTMLDivElement>('attachments'),
  attachImage: element<HTMLButtonElement>('attach-image'),
  input: element<HTMLTextAreaElement>('composer-input'),
  iconTemplates: element<HTMLTemplateElement>('icon-templates'),
  dictate: element<HTMLButtonElement>('dictate'),
  clearChat: element<HTMLButtonElement>('clear-chat'),
  stopRun: element<HTMLButtonElement>('stop-run'),
  sendMessage: element<HTMLButtonElement>('send-message'),
  questionModal: element<HTMLDivElement>('question-modal'),
  questionTabs: element<HTMLElement>('question-tabs'),
  questionBody: element<HTMLDivElement>('question-body'),
  closeQuestion: element<HTMLButtonElement>('close-question'),
  submitAnswers: element<HTMLButtonElement>('submit-answers'),
  lightbox: element<HTMLDivElement>('lightbox'),
  lightboxImage: element<HTMLImageElement>('lightbox-image'),
  lightboxCaption: element<HTMLSpanElement>('lightbox-caption'),
  lightboxClose: element<HTMLButtonElement>('lightbox-close'),
};

let state: PrometheonViewState | null = null;
let currentRunId: string | null = null;
/** Nó de texto de cada mensagem, para aplicar deltas sem redesenhar a lista. */
const contentNodes = new Map<string, HTMLElement>();
/** Faixa de passos de cada mensagem, para inserir a timeline sem redesenhá-la. */
const stepContainers = new Map<string, HTMLElement>();
/** Elemento de cada passo, indexado por `mensagem:passo`. */
const stepNodes = new Map<string, HTMLElement>();
/** Quantas mensagens estão na lista; decide o estado vazio junto do indicador. */
let messageCount = 0;
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

/** Todos os menus vivos, inclusive os criados dentro do modal. */
const openMenus = new Set<OptionMenu>();

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
    // Os menus do modal nascem e morrem com a seção aberta; o registro permite
    // que um clique em qualquer lugar feche todos sem conhecê-los por nome.
    openMenus.add(this);

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

  /** Um menu descartado junto com a seção não pode continuar registrado. */
  destroy(): void {
    this.close();
    openMenus.delete(this);
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
  for (const menu of openMenus) {
    if (menu !== except) {
      menu.close();
    }
  }
}

/**
 * Menu de escolha única montado em tempo de execução, para os formulários do
 * modal. Substitui o `<select>` nativo, que não mostra a descrição da opção.
 */
function createOptionMenu(
  title: string,
  options: readonly MenuOption[],
  selected: string,
  onSelect: (value: string) => void,
): { readonly root: HTMLElement; readonly menu: OptionMenu } {
  const anchor = document.createElement('div');
  anchor.className = 'menu-anchor field-menu';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pill field-pill';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const iconSlot = document.createElement('span');
  iconSlot.className = 'pill-icon';
  iconSlot.dataset['slot'] = 'icon';
  const labelSlot = document.createElement('span');
  labelSlot.className = 'field-pill-label';
  labelSlot.dataset['slot'] = 'label';
  // O chevron não é um slot do OptionMenu: ele fica fora e sobrevive ao update.
  const caret = document.createElement('span');
  caret.className = 'field-pill-caret';
  caret.append(...nodes(icon('chevron')));
  button.append(iconSlot, labelSlot, caret);

  const dropdown = document.createElement('div');
  dropdown.className = 'menu menu-below';
  dropdown.setAttribute('role', 'menu');
  dropdown.setAttribute('aria-label', title);
  dropdown.hidden = true;
  const heading = document.createElement('div');
  heading.className = 'menu-title';
  heading.textContent = title;
  const items = document.createElement('div');
  items.className = 'menu-items';
  items.dataset['slot'] = 'items';
  dropdown.append(heading, items);

  anchor.append(button, dropdown);
  const menu = new OptionMenu(button, dropdown, onSelect);
  menu.update(options, selected);
  return { root: anchor, menu };
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
  button.setAttribute('aria-label', sf('Open {0}', attachment.name));
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
  remove.title = s('Remove image');
  remove.setAttribute('aria-label', sf('Remove {0}', attachment.name));
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
    showNotification(sf('At most {0} images per message.', MAX_ATTACHMENTS_PER_MESSAGE), 'warning');
    return;
  }
  const accepted = attachments.slice(0, room);
  if (accepted.length < attachments.length) {
    showNotification(sf('At most {0} images per message.', MAX_ATTACHMENTS_PER_MESSAGE), 'warning');
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
    showNotification(sf('Unsupported image format: {0}', file.name || file.type), 'warning');
    return null;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showNotification(
      sf('Image is larger than {0} MB.', Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)),
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

/**
 * Gerúndios do indicador de trabalho. Rotacionam devagar para dar sinal de vida
 * sem virar enfeite; a fase real do run continua na barra do composer.
 */
const WORKING_WORDS = ['Envisioning', 'Thinking', 'Working', 'Composing', 'Reasoning'] as const;
const WORD_INTERVAL_MS = 4200;
/** Deve casar com a transição de opacidade de `.working-word` no CSS. */
const WORD_FADE_MS = 200;

let wordIndex = 0;
let wordTimer = 0;
let wordFadeTimer = 0;

function currentWord(): string {
  return `${s(WORKING_WORDS[wordIndex] ?? 'Working')}…`;
}

function startWorkingWords(): void {
  if (wordTimer !== 0) {
    return;
  }
  dom.workingWord.textContent = currentWord();
  wordTimer = window.setInterval(() => {
    wordIndex = (wordIndex + 1) % WORKING_WORDS.length;
    dom.workingWord.classList.add('fading');
    wordFadeTimer = window.setTimeout(() => {
      dom.workingWord.textContent = currentWord();
      dom.workingWord.classList.remove('fading');
    }, WORD_FADE_MS);
  }, WORD_INTERVAL_MS);
}

function stopWorkingWords(): void {
  window.clearInterval(wordTimer);
  window.clearTimeout(wordFadeTimer);
  wordTimer = 0;
  wordIndex = 0;
  dom.workingWord.classList.remove('fading');
}

/** O estado vazio só aparece quando não há mensagem nem trabalho em andamento. */
function updateEmptyState(): void {
  dom.emptyState.hidden = messageCount > 0 || !dom.working.hidden || state?.chatType === 'web';
}

/**
 * Barra acima do composer (o que o agente faz agora e com qual conta) e
 * indicador no topo da conversa, que toma o lugar do estado vazio enquanto o
 * trabalho corre.
 */
function renderActivity(activity: PrometheonViewState['activity']): void {
  const running = activity.phase !== 'idle';
  dom.activity.hidden = !running;
  dom.activityLabel.textContent = activity.label;
  dom.activityDetail.textContent = activity.detail ?? '';
  dom.activity.className = `activity phase-${activity.phase}`;

  dom.working.hidden = !running || state?.chatType === 'web';
  if (dom.working.hidden) {
    stopWorkingWords();
  } else {
    startWorkingWords();
  }
  updateEmptyState();

  // Tokens contados durante o run, ao lado do relógio. Some quando o run acaba:
  // a conta que fica é a do cabeçalho da mensagem.
  const tokens = activity.usage === undefined ? '' : tokenPair(activity.usage);
  dom.activityTokens.textContent = tokens;
  dom.workingTokens.textContent = tokens;
  const title =
    activity.usage === undefined
      ? ''
      : sf('{0} input tokens · {1} output tokens', activity.usage.input, activity.usage.output);
  dom.activityTokens.title = title;
  dom.workingTokens.title = title;

  window.clearInterval(elapsedTimer);
  if (!running || activity.startedAt === null) {
    dom.activityElapsed.textContent = '';
    dom.workingElapsed.textContent = '';
    return;
  }
  const startedAt = activity.startedAt;
  const tick = (): void => {
    const elapsed = formatElapsed(Date.now() - startedAt);
    dom.activityElapsed.textContent = elapsed;
    dom.workingElapsed.textContent = elapsed;
  };
  tick();
  elapsedTimer = window.setInterval(tick, 1000);
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// ---------- Contas e uso ----------

function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  return count < 1_000_000 ? `${(count / 1000).toFixed(1)}k` : `${(count / 1_000_000).toFixed(1)}M`;
}

// ---------- Modal de configuração ----------

const SECTION_LABELS: Record<SettingsSection, string> = {
  general: s('General'),
  accounts: s('Accounts'),
  agents: s('Agents'),
  workspace: s('Workspace'),
  mcp: s('MCP'),
};

const SECTION_ICONS: Record<SettingsSection, string> = {
  general: 'sliders',
  accounts: 'person',
  agents: 'agent',
  workspace: 'folder',
  mcp: 'plug',
};

/** Idiomas oferecidos no painel, na ordem em que aparecem no menu. */
const LANGUAGE_OPTIONS: readonly {
  readonly value: LanguageChoice;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'auto', label: s('Follow VS Code'), description: s('Use the display language of the editor.') },
  { value: 'en', label: s('English'), description: s('Source language of the interface.') },
  {
    value: 'pt-br',
    label: s('Português (Brasil)'),
    description: s('Interface in Brazilian Portuguese.'),
  },
  { value: 'es', label: s('Español'), description: s('Interface in Spanish.') },
];

const ROLE_ICONS: Record<AgentRole, string> = {
  orchestrator: 'agent-team',
  planner: 'plan',
  implementer: 'edit',
  reviewer: 'check',
  researcher: 'magnifier',
  tester: 'beaker',
  custom: 'sliders',
};

const CONTEXT_ICONS: Record<ContextStrategy, string> = {
  isolated: 'box',
  project: 'folder',
  team: 'agent-team',
};

const AGENT_AUTONOMY_ICONS: Record<AgentAutonomyMode, string> = {
  manual: 'manual',
  auto: 'auto',
  'bypass-temporary': 'bypass',
};

/** Rascunho do formulário de conta, preservado entre redesenhos do painel. */
interface AccountDraft {
  name: string;
  providerId: string;
}

/** Rascunho de um Agent Profile. `id` nulo significa criação. */
interface AgentDraft {
  id: string | null;
  name: string;
  providerProfileId: string;
  role: AgentRole;
  model: string;
  systemPrompt: string;
  autonomyMode: AgentAutonomyMode;
  allowedTools: string;
  deniedTools: string;
  maxConcurrentSessions: string;
  contextStrategy: ContextStrategy;
  enabled: boolean;
}

interface McpDraft {
  /** Nome original quando estamos editando; nulo na criação. */
  original: string | null;
  name: string;
  transport: McpTransport;
  command: string;
  /** Um argumento por linha, como o usuário digita. */
  args: string;
  /** `CHAVE=valor`, uma por linha. */
  env: string;
  url: string;
  headers: string;
  enabled: boolean;
}

let settingsSection: SettingsSection = 'accounts';
let accountDraft: AccountDraft = { name: '', providerId: '' };
let agentDraft: AgentDraft | null = null;
let mcpDraft: McpDraft | null = null;
/** Menus criados para a seção aberta; descartados a cada redesenho. */
let sectionMenus: OptionMenu[] = [];

function isSettingsOpen(): boolean {
  return !dom.settingsModal.hidden;
}

function openSettings(section: SettingsSection = settingsSection, focus?: 'new'): void {
  settingsSection = section;
  dom.settingsModal.hidden = false;
  dom.openSettingsModal.setAttribute('aria-expanded', 'true');
  if (focus === 'new') {
    // Abre já com o formulário da seção pronto para digitar.
    if (section === 'agents') {
      agentDraft = newAgentDraft(state?.accounts[0]?.profileId ?? '');
    } else if (section === 'mcp') {
      mcpDraft = newMcpDraft();
    }
  }
  renderSettings();
  const firstField = focus === 'new' ? firstInputFor(section) : null;
  (firstField ?? dom.closeSettings).focus();
  // Desenha já com o que temos e pede a releitura: consultar o `auth status` de
  // cada CLI leva tempo, e abrir num painel vazio pareceria erro.
  post({ type: 'accounts.refresh' });
  post({ type: 'mcp.refresh' });
}

/** Primeiro campo do formulário de criação da seção, quando ela tem um. */
function firstInputFor(section: SettingsSection): HTMLInputElement | null {
  const names: Partial<Record<SettingsSection, string>> = {
    accounts: 'account-name',
    agents: 'agent-name',
    mcp: 'mcp-name',
  };
  const name = names[section];
  return name === undefined
    ? null
    : dom.settingsPane.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
}

function closeSettings(): void {
  dom.settingsModal.hidden = true;
  dom.openSettingsModal.setAttribute('aria-expanded', 'false');
  for (const menu of sectionMenus) {
    menu.destroy();
  }
  sectionMenus = [];
}

function selectSection(section: SettingsSection): void {
  settingsSection = section;
  renderSettings();
  dom.settingsPane.focus();
}

/**
 * Redesenha o modal inteiro a partir do snapshot e dos rascunhos. O foco e a
 * posição do cursor são devolvidos ao campo que estava em uso: o estado chega
 * de fora a qualquer momento e não pode interromper quem está digitando.
 */
function renderSettings(): void {
  if (!isSettingsOpen()) {
    return;
  }
  const active = document.activeElement;
  const focusedField =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? {
          field: active.dataset['field'] ?? null,
          start: active.selectionStart,
          end: active.selectionEnd,
        }
      : null;

  for (const menu of sectionMenus) {
    menu.destroy();
  }
  sectionMenus = [];

  renderSettingsNav();
  dom.settingsPane.setAttribute('aria-label', SECTION_LABELS[settingsSection]);
  dom.settingsPane.replaceChildren(...renderSection());

  if (focusedField !== null && focusedField.field !== null) {
    const restored = dom.settingsPane.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-field="${focusedField.field}"]`,
    );
    if (restored !== null) {
      restored.focus();
      if (focusedField.start !== null && focusedField.end !== null) {
        restored.setSelectionRange(focusedField.start, focusedField.end);
      }
    }
  }
}

function renderSettingsNav(): void {
  dom.settingsNav.replaceChildren(
    ...SETTINGS_SECTIONS.map((section) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-tab';
      button.setAttribute('role', 'tab');
      const active = section === settingsSection;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));

      const glyph = document.createElement('span');
      glyph.className = 'settings-tab-icon';
      glyph.append(...nodes(icon(SECTION_ICONS[section])));

      const label = document.createElement('span');
      label.textContent = SECTION_LABELS[section];

      button.append(glyph, label);
      button.addEventListener('click', () => selectSection(section));
      return button;
    }),
  );
}

function renderSection(): readonly Node[] {
  switch (settingsSection) {
    case 'general':
      return renderGeneralSection();
    case 'accounts':
      return renderAccountsSection();
    case 'agents':
      return renderAgentsSection();
    case 'workspace':
      return renderWorkspaceSection();
    case 'mcp':
      return renderMcpSection();
  }
}

// ---------- Blocos reutilizados pelas seções ----------

function sectionHeading(title: string, note?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'settings-heading';

  const heading = document.createElement('h3');
  heading.textContent = title;
  wrapper.append(heading);

  if (note !== undefined) {
    const text = document.createElement('p');
    text.className = 'settings-note';
    text.textContent = note;
    wrapper.append(text);
  }
  return wrapper;
}

function emptyNote(text: string): HTMLElement {
  const paragraph = document.createElement('p');
  paragraph.className = 'settings-empty';
  paragraph.textContent = text;
  return paragraph;
}

/** Campo rotulado: rótulo em cima, controle embaixo, dica opcional. */
function field(label: string, control: Node, hint?: string): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';

  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = label;
  wrapper.append(caption, control);

  if (hint !== undefined) {
    const note = document.createElement('span');
    note.className = 'field-hint';
    note.textContent = hint;
    wrapper.append(note);
  }
  return wrapper;
}

function textInput(options: {
  readonly name: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly onInput: (value: string) => void;
}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field-input';
  input.dataset['field'] = options.name;
  input.value = options.value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (options.placeholder !== undefined) {
    input.placeholder = options.placeholder;
  }
  if (options.maxLength !== undefined) {
    input.maxLength = options.maxLength;
  }
  input.addEventListener('input', () => options.onInput(input.value));
  return input;
}

function textArea(options: {
  readonly name: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly maxLength: number;
  readonly onInput: (value: string) => void;
}): HTMLTextAreaElement {
  const area = document.createElement('textarea');
  area.className = 'field-input field-textarea';
  area.dataset['field'] = options.name;
  area.rows = 3;
  area.value = options.value;
  area.maxLength = options.maxLength;
  if (options.placeholder !== undefined) {
    area.placeholder = options.placeholder;
  }
  area.addEventListener('input', () => options.onInput(area.value));
  return area;
}

function checkboxField(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field field-inline';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));

  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = label;

  wrapper.append(box, caption);
  return wrapper;
}

/** Menu de seleção dentro de um campo, registrado para ser descartado depois. */
function menuField(
  label: string,
  options: readonly MenuOption[],
  selected: string,
  onSelect: (value: string) => void,
  hint?: string,
): HTMLElement {
  const created = createOptionMenu(label, options, selected, onSelect);
  sectionMenus.push(created.menu);
  // `label` embrulhando um menu roubaria o clique do botão; aqui é um bloco.
  const wrapper = document.createElement('div');
  wrapper.className = 'field';

  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = label;
  wrapper.append(caption, created.root);

  if (hint !== undefined) {
    const note = document.createElement('span');
    note.className = 'field-hint';
    note.textContent = hint;
    wrapper.append(note);
  }
  return wrapper;
}

function actionRow(...buttons: readonly HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field-actions';
  row.append(...buttons);
  return row;
}

function actionButton(
  label: string,
  variant: 'primary' | 'ghost' | 'link',
  onClick: () => void,
): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = variant;
  control.textContent = label;
  control.addEventListener('click', onClick);
  return control;
}

/** Aviso âmbar: algo precisa de atenção, sem ser um erro do usuário. */
function warningNote(text: string): HTMLElement {
  const note = document.createElement('p');
  note.className = 'settings-warning';
  note.textContent = text;
  return note;
}

// ---------- Seção General ----------

/**
 * Preferências que valem para o painel inteiro. Hoje, o idioma: a escolha vai
 * para as configurações do usuário e a webview é redesenhada com o texto novo.
 */
function renderGeneralSection(): readonly Node[] {
  const language = state?.language ?? 'auto';
  return [
    sectionHeading(
      s('General'),
      s(
        'Applies to this panel. Menus and commands contributed to VS Code follow the editor language.',
      ),
    ),
    menuField(
      s('Interface language'),
      LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        icon: 'globe',
      })),
      language,
      (value) => {
        if (isLanguageChoice(value) && value !== language) {
          post({ type: 'settings.setLanguage', payload: { language: value } });
        }
      },
    ),
  ];
}

function isLanguageChoice(value: string): value is LanguageChoice {
  return LANGUAGE_OPTIONS.some((option) => option.value === value);
}

// ---------- Seção Accounts ----------

function renderAccountsSection(): readonly Node[] {
  const accounts = state?.accounts ?? [];
  const providers = state?.providers ?? [];
  const blocks: Node[] = [
    sectionHeading(
      s('Accounts'),
      s(
        'Each account is a separate CLI sign-in with its own configuration directory. Signing in always happens through the official CLI flow.',
      ),
    ),
  ];

  if (accounts.length === 0) {
    blocks.push(
      emptyNote(
        s('No account yet. Create one to give an agent its own CLI sign-in, isolated from the others.'),
      ),
    );
  } else {
    blocks.push(...accounts.map(renderAccount));
  }

  blocks.push(
    renderAccountForm(providers),
    emptyNote(
      s(
        'Token counts are measured by Prometheon on this machine. Subscription limits live in each provider account and are not read from here.',
      ),
    ),
  );
  return blocks;
}

function renderAccountForm(providers: PrometheonViewState['providers']): HTMLElement {
  const form = document.createElement('section');
  form.className = 'settings-form';
  form.append(sectionHeading(s('New account')));

  if (providers.length === 0) {
    form.append(emptyNote(s('No provider adapter is available yet.')));
    return form;
  }

  const selected = providers.find((provider) => provider.id === accountDraft.providerId) ??
    providers[0];
  if (selected !== undefined && accountDraft.providerId !== selected.id) {
    accountDraft = { ...accountDraft, providerId: selected.id };
  }

  form.append(
    field(
      s('Name'),
      textInput({
        name: 'account-name',
        value: accountDraft.name,
        placeholder: 'Mateus27',
        maxLength: MAX_PROFILE_NAME_LENGTH,
        onInput: (value) => {
          accountDraft = { ...accountDraft, name: value };
        },
      }),
      s('A name to tell this account apart from the others.'),
    ),
    menuField(
      s('Provider'),
      providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: sf('Isolated through {0}', provider.configEnvironmentVariable),
        icon: 'cloud',
      })),
      accountDraft.providerId,
      (value) => {
        accountDraft = { ...accountDraft, providerId: value };
        renderSettings();
      },
    ),
    actionRow(
      actionButton(s('Create account'), 'primary', () => {
        const name = accountDraft.name.trim();
        if (name === '' || accountDraft.providerId === '') {
          showNotification(s('Give the account a name before creating it.'), 'warning');
          return;
        }
        post({ type: 'accounts.create', payload: { name, providerId: accountDraft.providerId } });
        accountDraft = { ...accountDraft, name: '' };
        renderSettings();
      }),
    ),
  );
  return form;
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
    ? s('Signed in')
    : account.cliInstalled
      ? s('Signed out')
      : s('CLI missing');

  header.append(name, state);
  card.append(header);

  const rows: [string, string][] = [
    [
      s('Provider'),
      account.cliVersion === undefined
        ? account.providerName
        : `${account.providerName} ${account.cliVersion}`,
    ],
  ];
  if (account.authMethod !== undefined) {
    rows.push([s('Auth method'), account.authMethod]);
  }
  if (account.accountLabel !== undefined) {
    rows.push([s('Email'), account.accountLabel]);
  }
  if (account.organization !== undefined) {
    rows.push([s('Organization'), account.organization]);
  }
  if (account.plan !== undefined) {
    rows.push([s('Plan'), account.plan]);
  }
  if (account.message !== undefined && !account.authenticated) {
    rows.push([s('Status'), account.message]);
  }
  card.append(definitionList(rows));

  const usage = document.createElement('div');
  usage.className = 'usage';
  const title = document.createElement('span');
  title.className = 'usage-title';
  title.textContent = s('Tokens measured locally');
  usage.append(title);
  usage.append(
    definitionList([
      [s('Today'), tokenPair(account.usage.today)],
      [s('Last 7 days'), tokenPair(account.usage.last7Days)],
      [s('All time'), sf('{0} · {1} runs', tokenPair(account.usage.total), account.usage.runs)],
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
    accountButton(account.authenticated ? s('Sign in again') : s('Sign in'), () =>
      post({ type: 'accounts.login', payload: { profileId: account.profileId } }),
    ),
    accountButton(s('Sign out'), () =>
      post({ type: 'accounts.logout', payload: { profileId: account.profileId } }),
    ),
    accountButton(s('Remove'), () =>
      post({ type: 'accounts.remove', payload: { profileId: account.profileId } }),
    ),
  );
  card.append(actions);
  return card;
}

// ---------- Seção Agents ----------

function newAgentDraft(providerProfileId: string): AgentDraft {
  return {
    id: null,
    name: '',
    providerProfileId,
    role: 'implementer',
    model: '',
    systemPrompt: '',
    autonomyMode: 'manual',
    allowedTools: '',
    deniedTools: '',
    maxConcurrentSessions: '1',
    contextStrategy: 'project',
    enabled: true,
  };
}

function draftFromSummary(summary: AgentProfileSummary): AgentDraft {
  const profile = summary.profile;
  return {
    id: profile.id,
    name: profile.name,
    providerProfileId: profile.providerProfileId,
    role: profile.role,
    model: profile.model ?? '',
    systemPrompt: profile.systemPrompt ?? '',
    autonomyMode: profile.autonomyMode,
    allowedTools: profile.allowedTools.join(', '),
    deniedTools: profile.deniedTools.join(', '),
    maxConcurrentSessions: String(profile.maxConcurrentSessions),
    contextStrategy: profile.contextStrategy,
    enabled: profile.enabled,
  };
}

/** Lista separada por vírgula ou quebra de linha, sem itens vazios. */
function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function renderAgentsSection(): readonly Node[] {
  const profiles = state?.agentProfiles ?? [];
  const accounts = state?.accounts ?? [];
  const blocks: Node[] = [
    sectionHeading(
      s('Agent Profiles'),
      s(
        'Every agent runs through one account. Prometheon never falls back to another one when the bound account is unavailable.',
      ),
    ),
  ];

  if (accounts.length === 0) {
    blocks.push(
      emptyNote(s('An agent profile needs an account. Create one first, then come back here.')),
      actionRow(actionButton(s('Go to Accounts'), 'ghost', () => selectSection('accounts'))),
    );
    return blocks;
  }

  blocks.push(
    profiles.length === 0
      ? emptyNote(s('No agent profile yet.'))
      : fragment(profiles.map(renderAgentProfile)),
  );

  if (agentDraft === null) {
    const firstAccount = accounts[0];
    blocks.push(
      actionRow(
        actionButton(s('New agent profile'), 'primary', () => {
          agentDraft = newAgentDraft(firstAccount?.profileId ?? '');
          renderSettings();
        }),
      ),
    );
  } else {
    blocks.push(renderAgentForm(agentDraft, accounts));
  }
  return blocks;
}

function fragment(children: readonly Node[]): DocumentFragment {
  const parent = document.createDocumentFragment();
  parent.append(...children);
  return parent;
}

function renderAgentProfile(summary: AgentProfileSummary): HTMLElement {
  const profile = summary.profile;
  const card = document.createElement('section');
  card.className = `account agent-profile ${profile.enabled ? 'enabled' : 'disabled'}`;

  const header = document.createElement('header');
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = profile.name;

  const role = document.createElement('span');
  role.className = 'account-state';
  role.textContent = s(AGENT_ROLE_LABELS[profile.role]);

  header.append(name, role);
  card.append(header);

  // `Agent → Provider → Account`: o documento exige que a conta usada nunca
  // fique escondida.
  const chain = document.createElement('p');
  chain.className = 'agent-chain';
  chain.textContent = `${profile.name} → ${summary.providerName ?? s('unknown provider')} → ${summary.accountName ?? profile.providerProfileId}`;
  card.append(chain);

  const rows: [string, string][] = [
    [s('Model'), profile.model ?? s('Chosen by the CLI')],
    [s('Autonomy'), s(AGENT_AUTONOMY_MODE_LABELS[profile.autonomyMode])],
    [s('Context'), s(CONTEXT_STRATEGY_LABELS[profile.contextStrategy])],
    [s('Max sessions'), String(profile.maxConcurrentSessions)],
  ];
  if (profile.allowedTools.length > 0) {
    rows.push([s('Allowed tools'), profile.allowedTools.join(', ')]);
  }
  if (profile.deniedTools.length > 0) {
    rows.push([s('Denied tools'), profile.deniedTools.join(', ')]);
  }
  card.append(definitionList(rows));

  if (summary.warning !== undefined) {
    card.append(warningNote(summary.warning));
  }

  card.append(
    actionRow(
      actionButton(s('Edit'), 'ghost', () => {
        agentDraft = draftFromSummary(summary);
        renderSettings();
      }),
      actionButton(profile.enabled ? s('Disable') : s('Enable'), 'ghost', () =>
        post({
          type: 'agentProfiles.setEnabled',
          payload: { id: profile.id, enabled: !profile.enabled },
        }),
      ),
      actionButton(s('Remove'), 'ghost', () =>
        post({ type: 'agentProfiles.remove', payload: { id: profile.id } }),
      ),
    ),
  );
  return card;
}

function renderAgentForm(
  draft: AgentDraft,
  accounts: PrometheonViewState['accounts'],
): HTMLElement {
  const form = document.createElement('section');
  form.className = 'settings-form';
  form.append(sectionHeading(draft.id === null ? s('New agent profile') : sf('Edit {0}', draft.name)));

  const update = (patch: Partial<AgentDraft>, redraw = false): void => {
    agentDraft = { ...draft, ...patch };
    if (redraw) {
      renderSettings();
    }
  };

  form.append(
    field(
      s('Name'),
      textInput({
        name: 'agent-name',
        value: draft.name,
        placeholder: 'Code Reviewer',
        maxLength: MAX_PROFILE_NAME_LENGTH,
        onInput: (value) => update({ name: value }),
      }),
    ),
    menuField(
      s('Account'),
      accounts.map((account) => ({
        value: account.profileId,
        label: account.name,
        description: account.authenticated
          ? sf('{0} · signed in', account.providerName)
          : sf('{0} · not signed in', account.providerName),
        icon: 'cloud',
      })),
      draft.providerProfileId,
      (value) => update({ providerProfileId: value }, true),
      s('The account this agent runs through. It is required.'),
    ),
    menuField(
      s('Role'),
      AGENT_ROLES.map((role) => ({
        value: role,
        label: s(AGENT_ROLE_LABELS[role]),
        description: s(AGENT_ROLE_DESCRIPTIONS[role]),
        icon: ROLE_ICONS[role],
      })),
      draft.role,
      (value) => update({ role: value as AgentRole }, true),
    ),
    field(
      s('Model'),
      textInput({
        name: 'agent-model',
        value: draft.model,
        placeholder: s('Leave empty to use the CLI default'),
        maxLength: MAX_MODEL_LENGTH,
        onInput: (value) => update({ model: value }),
      }),
      s('Free text: Prometheon does not list models. The CLI validates it when the agent runs.'),
    ),
    field(
      s('System prompt'),
      textArea({
        name: 'agent-prompt',
        value: draft.systemPrompt,
        placeholder: s('How this agent should behave.'),
        maxLength: MAX_SYSTEM_PROMPT_LENGTH,
        onInput: (value) => update({ systemPrompt: value }),
      }),
    ),
    menuField(
      s('Autonomy'),
      AGENT_AUTONOMY_MODES.map((mode) => ({
        value: mode,
        label: s(AGENT_AUTONOMY_MODE_LABELS[mode]),
        description: s(AGENT_AUTONOMY_MODE_DESCRIPTIONS[mode]),
        icon: AGENT_AUTONOMY_ICONS[mode],
      })),
      draft.autonomyMode,
      (value) => update({ autonomyMode: value as AgentAutonomyMode }, true),
    ),
    menuField(
      s('Context strategy'),
      CONTEXT_STRATEGIES.map((strategy) => ({
        value: strategy,
        label: s(CONTEXT_STRATEGY_LABELS[strategy]),
        description: s(CONTEXT_STRATEGY_DESCRIPTIONS[strategy]),
        icon: CONTEXT_ICONS[strategy],
      })),
      draft.contextStrategy,
      (value) => update({ contextStrategy: value as ContextStrategy }, true),
    ),
    field(
      s('Allowed tools'),
      textInput({
        name: 'agent-allowed',
        value: draft.allowedTools,
        placeholder: 'Read, Grep, Bash',
        onInput: (value) => update({ allowedTools: value }),
      }),
      s('Comma separated. Empty means the provider default.'),
    ),
    field(
      s('Denied tools'),
      textInput({
        name: 'agent-denied',
        value: draft.deniedTools,
        placeholder: 'Bash, Write',
        onInput: (value) => update({ deniedTools: value }),
      }),
      s('Comma separated.'),
    ),
    field(
      s('Max concurrent sessions'),
      textInput({
        name: 'agent-sessions',
        value: draft.maxConcurrentSessions,
        placeholder: '1',
        maxLength: 2,
        onInput: (value) => update({ maxConcurrentSessions: value }),
      }),
      sf('Between 1 and {0}.', MAX_CONCURRENT_SESSIONS),
    ),
    checkboxField(s('Enabled'), draft.enabled, (value) => update({ enabled: value })),
    actionRow(
      actionButton(draft.id === null ? s('Create agent') : s('Save agent'), 'primary', () =>
        submitAgentDraft(),
      ),
      actionButton(s('Cancel'), 'ghost', () => {
        agentDraft = null;
        renderSettings();
      }),
    ),
  );
  return form;
}

function submitAgentDraft(): void {
  const draft = agentDraft;
  if (draft === null) {
    return;
  }
  const name = draft.name.trim();
  if (name === '') {
    showNotification(s('Give the agent profile a name.'), 'warning');
    return;
  }
  if (draft.providerProfileId === '') {
    showNotification(s('Pick the account this agent runs through.'), 'warning');
    return;
  }
  const sessions = Number(draft.maxConcurrentSessions);
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > MAX_CONCURRENT_SESSIONS) {
    showNotification(
      sf('Max concurrent sessions must be between 1 and {0}.', MAX_CONCURRENT_SESSIONS),
      'warning',
    );
    return;
  }

  const model = draft.model.trim();
  const systemPrompt = draft.systemPrompt.trim();
  const profile: AgentProfileDraft = {
    name,
    providerProfileId: draft.providerProfileId,
    role: draft.role,
    ...(model === '' ? {} : { model }),
    ...(systemPrompt === '' ? {} : { systemPrompt }),
    autonomyMode: draft.autonomyMode,
    allowedTools: splitList(draft.allowedTools),
    deniedTools: splitList(draft.deniedTools),
    maxConcurrentSessions: sessions,
    contextStrategy: draft.contextStrategy,
    enabled: draft.enabled,
  };

  post(
    draft.id === null
      ? { type: 'agentProfiles.create', payload: { profile } }
      : { type: 'agentProfiles.update', payload: { id: draft.id, profile } },
  );
  agentDraft = null;
  renderSettings();
}

// ---------- Seção Workspace ----------

function renderWorkspaceSection(): readonly Node[] {
  const workspace = state?.workspace;
  const blocks: Node[] = [
    sectionHeading(
      s('Workspace'),
      s(
        'The shared Prometheon workspace lives in .prometheon/ inside the open folder. Local Chat works without it.',
      ),
    ),
  ];

  if (workspace !== undefined) {
    blocks.push(
      definitionList([
        [s('Folder'), workspace.folderName ?? s('None open')],
        [s('Configured'), workspace.configured ? s('Yes') : s('No')],
        [s('Git repository'), workspace.hasGit ? s('Detected') : s('Not detected')],
        [s('External folder'), workspace.externalFolder ?? s('None')],
        [s('Setup skipped'), workspace.skipped ? s('Yes') : s('No')],
      ]),
    );
  }

  blocks.push(
    actionRow(
      actionButton(s('Initialize in current workspace'), 'primary', () =>
        post({ type: 'workspace.initialize', payload: { choice: 'current' } }),
      ),
      actionButton(s('Choose Prometheon workspace folder'), 'ghost', () =>
        post({ type: 'workspace.initialize', payload: { choice: 'external' } }),
      ),
      actionButton(s('Continue without shared workspace'), 'link', () =>
        post({ type: 'workspace.initialize', payload: { choice: 'skip' } }),
      ),
    ),
  );
  return blocks;
}

// ---------- Seção MCP ----------

function newMcpDraft(): McpDraft {
  return {
    original: null,
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    url: '',
    headers: '',
    enabled: true,
  };
}

function draftFromServer(server: McpServerSummary): McpDraft {
  return {
    original: server.name,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args.join('\n'),
    env: pairsToText(server.env),
    url: server.url ?? '',
    headers: pairsToText(server.headers),
    enabled: server.enabled,
  };
}

function pairsToText(pairs: readonly McpKeyValue[]): string {
  return pairs.map((pair) => `${pair.key}=${pair.value}`).join('\n');
}

/** `CHAVE=valor` por linha. O primeiro `=` separa; o resto faz parte do valor. */
function textToPairs(value: string): McpKeyValue[] {
  const pairs: McpKeyValue[] = [];
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (key !== '' && !pairs.some((pair) => pair.key === key)) {
      pairs.push({ key, value: trimmed.slice(separator + 1).trim() });
    }
  }
  return pairs;
}

const MCP_SECRET_NOTE =
  'This file lives at the root of the project and usually goes into Git. Keep tokens out of it: put the value in an environment variable and reference it by name, like ${GITHUB_TOKEN}.';

function renderMcpSection(): readonly Node[] {
  const mcp = state?.mcp;
  const blocks: Node[] = [
    sectionHeading(
      s('MCP servers'),
      s(
        'Model Context Protocol servers of this project, read from .mcp.json — the same file Claude Code, Cursor and VS Code use.',
      ),
    ),
  ];

  if (mcp === undefined || !mcp.available) {
    blocks.push(
      emptyNote(
        s(
          mcp?.message ??
            'MCP servers are configured in .mcp.json at the root of the open folder. Open a folder to configure them.',
        ),
      ),
      actionRow(actionButton(s('Go to Workspace'), 'ghost', () => selectSection('workspace'))),
    );
    return blocks;
  }

  if (mcp.file !== null) {
    const path = document.createElement('code');
    path.className = 'account-directory';
    path.textContent = mcp.exists ? mcp.file : sf('{0} (not created yet)', mcp.file);
    path.title = mcp.file;
    blocks.push(path);
  }
  blocks.push(emptyNote(s(MCP_SECRET_NOTE)));

  for (const problem of mcp.problems) {
    blocks.push(warningNote(`${problem.name}: ${problem.detail}`));
  }

  blocks.push(
    mcp.servers.length === 0
      ? emptyNote(s('No MCP server configured yet.'))
      : fragment(mcp.servers.map(renderMcpServer)),
  );

  if (mcpDraft === null) {
    blocks.push(
      actionRow(
        actionButton(s('Add server'), 'primary', () => {
          mcpDraft = newMcpDraft();
          renderSettings();
        }),
        // A leitura do arquivo escolhido acontece na extensão: a webview só pede.
        actionButton(s('Import from .mcp.json'), 'ghost', () => post({ type: 'mcp.import' })),
      ),
    );
  } else {
    blocks.push(renderMcpForm(mcpDraft));
  }
  return blocks;
}

function renderMcpServer(server: McpServerSummary): HTMLElement {
  const card = document.createElement('section');
  card.className = `account mcp-server ${server.enabled ? 'enabled' : 'disabled'}`;

  const header = document.createElement('header');
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = server.name;

  const status = document.createElement('span');
  status.className = 'account-state';
  status.textContent = server.enabled ? s('Enabled') : s('Disabled');

  header.append(name, status);
  card.append(header);

  const rows: [string, string][] = [
    [s('Transport'), s(MCP_TRANSPORT_LABELS[server.transport])],
  ];
  if (server.command !== undefined) {
    rows.push([s('Command'), server.command]);
  }
  if (server.args.length > 0) {
    rows.push([s('Arguments'), server.args.join(' ')]);
  }
  if (server.url !== undefined) {
    rows.push([s('URL'), server.url]);
  }
  if (server.env.length > 0) {
    rows.push([s('Environment'), server.env.map((pair) => pair.key).join(', ')]);
  }
  if (server.headers.length > 0) {
    rows.push([s('Headers'), server.headers.map((pair) => pair.key).join(', ')]);
  }
  if (server.preservedFields.length > 0) {
    rows.push([s('Kept as is'), server.preservedFields.join(', ')]);
  }
  card.append(definitionList(rows));

  for (const warning of server.warnings) {
    card.append(warningNote(warning));
  }

  card.append(
    actionRow(
      actionButton(s('Edit'), 'ghost', () => {
        mcpDraft = draftFromServer(server);
        renderSettings();
      }),
      actionButton(server.enabled ? s('Disable') : s('Enable'), 'ghost', () =>
        post({ type: 'mcp.setEnabled', payload: { name: server.name, enabled: !server.enabled } }),
      ),
      actionButton(s('Remove'), 'ghost', () =>
        post({ type: 'mcp.remove', payload: { name: server.name } }),
      ),
    ),
  );
  return card;
}

function renderMcpForm(draft: McpDraft): HTMLElement {
  const form = document.createElement('section');
  form.className = 'settings-form';
  form.append(
    sectionHeading(draft.original === null ? s('New MCP server') : sf('Edit {0}', draft.original)),
  );

  const update = (patch: Partial<McpDraft>, redraw = false): void => {
    mcpDraft = { ...draft, ...patch };
    if (redraw) {
      renderSettings();
    }
  };

  // O nome é a chave da entrada no arquivo; trocá-lo seria remover e recriar.
  const nameInput = textInput({
    name: 'mcp-name',
    value: draft.name,
    placeholder: 'filesystem',
    maxLength: MAX_MCP_NAME_LENGTH,
    onInput: (value) => update({ name: value }),
  });
  nameInput.disabled = draft.original !== null;

  form.append(
    field(
      s('Name'),
      nameInput,
      draft.original === null
        ? s('Letters, digits, dot, dash and underscore. It is the key inside .mcp.json.')
        : s('To rename a server, remove it and add it again.'),
    ),
    menuField(
      s('Transport'),
      MCP_TRANSPORTS.map((transport) => ({
        value: transport,
        label: s(MCP_TRANSPORT_LABELS[transport]),
        description: s(MCP_TRANSPORT_DESCRIPTIONS[transport]),
        icon: transport === 'stdio' ? 'plug' : 'cloud',
      })),
      draft.transport,
      (value) => update({ transport: value as McpTransport }, true),
    ),
  );

  if (draft.transport === 'stdio') {
    form.append(
      field(
        s('Command'),
        textInput({
          name: 'mcp-command',
          value: draft.command,
          placeholder: 'npx',
          maxLength: MAX_MCP_COMMAND_LENGTH,
          onInput: (value) => update({ command: value }),
        }),
      ),
      field(
        s('Arguments'),
        textArea({
          name: 'mcp-args',
          value: draft.args,
          placeholder: '-y\n@modelcontextprotocol/server-filesystem\n.',
          maxLength: 4_000,
          onInput: (value) => update({ args: value }),
        }),
        s('One argument per line.'),
      ),
      field(
        s('Environment'),
        textArea({
          name: 'mcp-env',
          value: draft.env,
          placeholder: 'GITHUB_TOKEN=${GITHUB_TOKEN}',
          maxLength: 4_000,
          onInput: (value) => update({ env: value }),
        }),
        s('KEY=value, one per line. Reference secrets by variable name, never by value.'),
      ),
    );
  } else {
    form.append(
      field(
        s('URL'),
        textInput({
          name: 'mcp-url',
          value: draft.url,
          placeholder: 'http://127.0.0.1:3550/mcp',
          maxLength: MAX_MCP_URL_LENGTH,
          onInput: (value) => update({ url: value }),
        }),
        s('Must start with http:// or https://.'),
      ),
      field(
        s('Headers'),
        textArea({
          name: 'mcp-headers',
          value: draft.headers,
          placeholder: 'Authorization=${MCP_TOKEN}',
          maxLength: 4_000,
          onInput: (value) => update({ headers: value }),
        }),
        s('Header=value, one per line. Reference secrets by variable name, never by value.'),
      ),
    );
  }

  form.append(
    checkboxField(s('Enabled'), draft.enabled, (value) => update({ enabled: value })),
    actionRow(
      actionButton(draft.original === null ? s('Add server') : s('Save server'), 'primary', () =>
        submitMcpDraft(),
      ),
      actionButton(s('Cancel'), 'ghost', () => {
        mcpDraft = null;
        renderSettings();
      }),
    ),
  );
  return form;
}

function submitMcpDraft(): void {
  const draft = mcpDraft;
  if (draft === null) {
    return;
  }
  const name = draft.name.trim();
  if (name === '') {
    showNotification(s('Give the MCP server a name.'), 'warning');
    return;
  }

  const base = { name, transport: draft.transport, enabled: draft.enabled };
  let server: McpServerDraft;

  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (command === '') {
      showNotification(s('A stdio server needs a command.'), 'warning');
      return;
    }
    server = {
      ...base,
      command,
      args: draft.args
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
      env: textToPairs(draft.env),
      headers: [],
    };
  } else {
    const url = draft.url.trim();
    if (url === '') {
      showNotification(sf('A {0} server needs a URL.', draft.transport), 'warning');
      return;
    }
    server = { ...base, args: [], env: [], url, headers: textToPairs(draft.headers) };
  }

  post({ type: 'mcp.save', payload: { server } });
  mcpDraft = null;
  renderSettings();
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
    ? (speech.detail ?? s('Dictation unavailable.'))
    : listening
      ? s('Listening… tap Ctrl+D to stop')
      : transcribing
        ? s('Transcribing…')
        : s('Dictate — tap or hold Ctrl+D to record');
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
        ? s('Web sessions need a connected Hub.')
        : s('No sessions yet.')
      : s('No session matches this search.');

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

// ---------- Perguntas do agente ----------

/**
 * Rótulo da escolha livre. Nunca vai no `selected` da resposta: o que o usuário
 * escreve viaja em `custom`, e o núcleo só aceita rótulos que ele mesmo ofereceu.
 */
const OTHER_LABEL = s('Other');

interface QuestionDraft {
  /** Rótulos marcados entre as opções oferecidas pelo agente. */
  selected: string[];
  /** "Other" está marcado; o texto digitado é que vale como resposta. */
  other: boolean;
  custom: string;
}

let question: AgentQuestionRequest | null = null;
let questionAt = 0;
let questionDrafts: QuestionDraft[] = [];

function isQuestionOpen(): boolean {
  return !dom.questionModal.hidden;
}

/** Abre o modal com um pedido novo; reabrir o mesmo preserva o que foi marcado. */
function openQuestion(request: AgentQuestionRequest): void {
  if (question?.requestId !== request.requestId) {
    question = request;
    questionAt = 0;
    questionDrafts = request.questions.map(() => ({ selected: [], other: false, custom: '' }));
  }
  dom.questionModal.hidden = false;
  renderQuestion();
  dom.questionBody.focus();
}

/** Tira o modal da tela sem avisar a extensão — quem fecha por lá já sabe. */
function hideQuestion(): void {
  question = null;
  questionDrafts = [];
  questionAt = 0;
  dom.questionModal.hidden = true;
  dom.questionTabs.replaceChildren();
  dom.questionBody.replaceChildren();
}

/** O usuário desistiu: o agente recebe "cancelado" e o run segue sem resposta. */
function cancelQuestion(): void {
  const requestId = question?.requestId;
  hideQuestion();
  if (requestId !== undefined) {
    post({ type: 'question.cancel', payload: { requestId } });
  }
}

function isAnswered(draft: QuestionDraft): boolean {
  return draft.selected.length > 0 || (draft.other && draft.custom.trim() !== '');
}

function renderQuestion(): void {
  const request = question;
  if (request === null) {
    return;
  }
  const current = request.questions[questionAt];
  if (current === undefined) {
    return;
  }

  // Abas só quando há mais de uma pergunta: uma aba sozinha não navega nada.
  dom.questionTabs.hidden = request.questions.length < 2;
  dom.questionTabs.replaceChildren(
    ...request.questions.map((item, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'question-tab';
      tab.setAttribute('role', 'tab');
      tab.textContent = item.header;
      const active = index === questionAt;
      tab.classList.toggle('active', active);
      tab.classList.toggle('answered', isAnswered(questionDrafts[index] ?? emptyDraft()));
      tab.setAttribute('aria-selected', String(active));
      tab.addEventListener('click', () => {
        questionAt = index;
        renderQuestion();
      });
      return tab;
    }),
  );

  dom.questionBody.replaceChildren(renderQuestionOptions(current, questionAt));
  dom.submitAnswers.disabled = !questionDrafts.every(isAnswered);
}

function emptyDraft(): QuestionDraft {
  return { selected: [], other: false, custom: '' };
}

function renderQuestionOptions(item: AgentQuestion, index: number): DocumentFragment {
  const draft = questionDrafts[index] ?? emptyDraft();

  const prompt = document.createElement('p');
  prompt.className = 'question-prompt';
  prompt.textContent = item.question;

  const list = document.createElement('div');
  list.className = 'question-options';
  list.setAttribute('role', item.multiSelect ? 'group' : 'radiogroup');

  for (const option of item.options) {
    list.append(
      optionRow(item, index, option.label, option.description, draft.selected.includes(option.label)),
    );
  }
  list.append(optionRow(item, index, OTHER_LABEL, undefined, draft.other));

  if (draft.other) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'question-custom';
    input.value = draft.custom;
    input.maxLength = MAX_CUSTOM_ANSWER_LENGTH;
    input.placeholder = s('Type your answer…');
    input.setAttribute('aria-label', item.question);
    input.addEventListener('input', () => {
      draft.custom = input.value;
      // Só o rodapé e as abas mudam: redesenhar o campo perderia o cursor.
      dom.submitAnswers.disabled = !questionDrafts.every(isAnswered);
      updateQuestionTabs();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitAnswers();
      }
    });
    list.append(input);
  }

  return fragment([prompt, list]);
}

function optionRow(
  item: AgentQuestion,
  index: number,
  label: string,
  description: string | undefined,
  checked: boolean,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'question-option';
  row.classList.toggle('selected', checked);

  const input = document.createElement('input');
  input.type = item.multiSelect ? 'checkbox' : 'radio';
  input.name = `question-${index}`;
  input.checked = checked;
  input.addEventListener('change', () => toggleOption(item, index, label, input.checked));

  const text = document.createElement('span');
  text.className = 'question-option-text';

  const title = document.createElement('span');
  title.className = 'question-option-label';
  title.textContent = label;
  text.append(title);

  if (description !== undefined && description !== '') {
    const hint = document.createElement('span');
    hint.className = 'question-option-description';
    hint.textContent = description;
    text.append(hint);
  }

  row.append(input, text);
  return row;
}

function toggleOption(item: AgentQuestion, index: number, label: string, checked: boolean): void {
  const draft = questionDrafts[index];
  if (draft === undefined) {
    return;
  }
  const other = label === OTHER_LABEL;

  if (!item.multiSelect) {
    // Escolha única: a marcação nova substitui a anterior, inclusive o "Other".
    draft.selected = other || !checked ? [] : [label];
    draft.other = other && checked;
  } else if (other) {
    draft.other = checked;
  } else {
    draft.selected = checked
      ? [...draft.selected, label]
      : draft.selected.filter((choice) => choice !== label);
  }
  if (!draft.other) {
    draft.custom = '';
  }

  renderQuestion();
  // Escolha única já resolvida avança sozinha para a próxima pendente; com
  // "Other" o usuário ainda precisa digitar, então a aba fica onde está.
  if (!item.multiSelect && checked && !other) {
    goToNextUnanswered();
  }
}

function goToNextUnanswered(): void {
  const next = questionDrafts.findIndex((draft, index) => index !== questionAt && !isAnswered(draft));
  if (next !== -1) {
    questionAt = next;
    renderQuestion();
  }
}

/** Marca no cabeçalho quais perguntas já têm resposta, sem remontar o corpo. */
function updateQuestionTabs(): void {
  const tabs = Array.from(dom.questionTabs.querySelectorAll<HTMLElement>('.question-tab'));
  tabs.forEach((tab, index) => {
    tab.classList.toggle('answered', isAnswered(questionDrafts[index] ?? emptyDraft()));
  });
}

function submitAnswers(): void {
  const request = question;
  if (request === null || !questionDrafts.every(isAnswered)) {
    return;
  }
  const answers = request.questions.map<AgentQuestionAnswer>((item, index) => {
    const draft = questionDrafts[index] ?? emptyDraft();
    const custom = draft.other ? draft.custom.trim() : '';
    return {
      header: item.header,
      selected: [...draft.selected],
      ...(custom === '' ? {} : { custom }),
    };
  });
  const requestId = request.requestId;
  hideQuestion();
  post({ type: 'question.answer', payload: { requestId, answers } });
}

// ---------- Passos do agente ----------

/**
 * Item de timeline de um passo do agente. Tudo entra por `textContent`: o bloco
 * de saída é texto monoespaçado, sem destaque de sintaxe e sem `innerHTML`.
 */
function renderStep(step: AgentStep): HTMLElement {
  const dot = document.createElement('span');
  dot.className = 'step-dot';

  if (step.kind === 'thought') {
    const item = document.createElement('div');
    item.className = 'step step-thought step-row status-done';
    const label = document.createElement('span');
    label.className = 'step-thought-label';
    label.textContent = sf('Thought for {0}', formatElapsed(step.durationMs ?? 0));
    item.append(dot, label);
    return item;
  }

  const tool = document.createElement('span');
  tool.className = 'step-tool';
  tool.textContent = step.kind === 'question' ? s('Asked') : step.tool;

  const target = document.createElement('span');
  target.className = 'step-target';
  target.textContent = step.title;

  const detail = document.createElement('span');
  detail.className = 'step-detail';
  // O resumo de uma pergunta cancelada é texto nosso, e é traduzível; o resto
  // do detalhe vem do agente e passa intacto.
  detail.textContent = step.kind === 'question' ? s(step.detail ?? '') : (step.detail ?? '');

  const hasOutput = step.output !== undefined && step.output !== '';
  if (!hasOutput) {
    const item = document.createElement('div');
    item.className = `step step-tool-item step-row status-${step.status}`;
    item.append(dot, tool, target, detail);
    return item;
  }

  const item = document.createElement('details');
  item.className = `step step-tool-item status-${step.status}`;

  const summary = document.createElement('summary');
  summary.className = 'step-row';
  const caret = document.createElement('span');
  caret.className = 'step-caret';
  caret.append(...nodes(icon('chevronRight')));
  summary.append(dot, tool, target, detail, caret);

  const output = document.createElement('pre');
  output.className = 'step-output';
  output.textContent = step.output ?? '';

  item.append(summary, output);
  if (step.truncated === true) {
    const note = document.createElement('span');
    note.className = 'step-truncated';
    note.textContent = `Output truncated at ${Math.round(MAX_STEP_OUTPUT_CHARS / 1024)} KB`;
    item.append(note);
  }
  return item;
}

/** Faixa de passos de uma mensagem; nasce vazia e escondida. */
function renderStepList(message: ChatMessage): HTMLElement {
  const list = document.createElement('div');
  list.className = 'steps';
  const steps = message.steps ?? [];
  list.hidden = steps.length === 0;
  for (const step of steps) {
    const node = renderStep(step);
    stepNodes.set(`${message.id}:${step.id}`, node);
    list.append(node);
  }
  stepContainers.set(message.id, list);
  return list;
}

/** Insere ou substitui um passo, preservando o bloco que o usuário abriu. */
function upsertStep(messageId: string, step: AgentStep): void {
  const container = stepContainers.get(messageId);
  if (container === undefined) {
    return;
  }
  container.hidden = false;

  const key = `${messageId}:${step.id}`;
  const node = renderStep(step);
  const previous = stepNodes.get(key);
  if (previous === undefined) {
    container.append(node);
  } else {
    if (previous instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
      node.open = previous.open;
    }
    previous.replaceWith(node);
  }
  stepNodes.set(key, node);
  scrollToEnd();
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
    message.author === 'user' ? s('You') : (message.agentName ?? capitalize(message.author));
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

  // Os passos vêm antes da resposta: é a ordem em que o trabalho aconteceu.
  item.append(header, renderStepList(message), body);

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
  badge.title = sf('{0} input tokens · {1} output tokens', usage.input, usage.output);
  return badge;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderMessages(messages: readonly ChatMessage[]): void {
  contentNodes.clear();
  stepContainers.clear();
  stepNodes.clear();
  dom.messages.replaceChildren(...messages.map(renderMessage));
  messageCount = messages.length;
  updateEmptyState();
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
      role.textContent = s(agent.role);

      const status = document.createElement('span');
      status.className = 'agent-status';
      status.textContent = s(agent.status);

      const task = document.createElement('span');
      task.className = 'agent-task';
      task.textContent = agent.task ?? '';

      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'agent-stop';
      stop.textContent = s('Stop');
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

  dom.hubBadge.textContent = s(HUB_STATE_LABELS[next.hub.state]);
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
    updateEmptyState();
  } else {
    renderMessages(next.messages);
  }

  menus.workMode.update(
    WORK_MODES.map((mode) => ({
      value: mode,
      label: s(WORK_MODE_LABELS[mode]),
      description: s(WORK_MODE_DESCRIPTIONS[mode]),
      icon: mode,
    })),
    next.workMode,
  );
  menus.autonomy.update(
    AUTONOMY_LEVELS.map((level) => ({
      value: level,
      label: s(AUTONOMY_LABELS[level]),
      description: s(AUTONOMY_DESCRIPTIONS[level]),
      icon: level,
    })),
    next.autonomy,
  );
  menus.mainAgent.update(
    next.agents.map((agent) => ({
      value: agent.id,
      label: agent.displayName,
      description: agent.available
        ? sf('Available · {0}', agent.transport)
        : sf('Unavailable · {0}', agent.transport),
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

  // O snapshot manda no modal: uma view reconstruída no meio do run reabre a
  // pergunta que o agente ainda está esperando.
  if (next.pendingQuestion === null) {
    if (isQuestionOpen()) {
      hideQuestion();
    }
  } else {
    openQuestion(next.pendingQuestion);
  }

  renderActivity(next.activity);
  renderSettings();
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
      dom.messages.append(renderMessage(payload.message));
      messageCount += 1;
      updateEmptyState();
      scrollToEnd();
      break;

    case 'message.created':
      dom.messages.append(renderMessage(payload.message));
      messageCount += 1;
      updateEmptyState();
      scrollToEnd();
      break;

    case 'step.started':
    case 'step.completed':
      upsertStep(payload.messageId, payload.step);
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

    // Tratados fora daqui: o uso em andamento e o estado do agente chegam pela
    // barra de atividade, e a pergunta abre o modal por mensagem própria.
    case 'run.usage':
    case 'agent.status':
    case 'question.asked':
    case 'question.closed':
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
  messageCount += 1;
  updateEmptyState();
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
dom.openSettings.addEventListener('click', () => post({ type: 'settings.openEditor' }));
dom.connectHub.addEventListener('click', () => post({ type: 'hub.connect.request' }));

dom.openSettingsModal.addEventListener('click', (event) => {
  event.stopPropagation();
  openSettings();
});
dom.closeSettings.addEventListener('click', closeSettings);
dom.settingsModal.addEventListener('click', (event) => {
  if (event.target === dom.settingsModal) {
    closeSettings();
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
  // A pergunta vem antes da configuração: é ela que está segurando o run.
  if (isQuestionOpen()) {
    cancelQuestion();
    return;
  }
  if (isSettingsOpen()) {
    closeSettings();
    dom.openSettingsModal.focus();
    return;
  }
  closeAllMenus();
  if (isPopoverOpen()) {
    closePopover();
    dom.toggleSessions.focus();
  }
});

dom.submitAnswers.addEventListener('click', submitAnswers);
dom.closeQuestion.addEventListener('click', cancelQuestion);
dom.questionModal.addEventListener('click', (event) => {
  // Clicar fora do cartão equivale a fechar: o agente segue sem a resposta.
  if (event.target === dom.questionModal) {
    cancelQuestion();
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
      dom.hubBadge.textContent = s(HUB_STATE_LABELS[message.payload.state]);
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
    case 'question.ask':
      openQuestion(message.payload);
      break;
    case 'question.close':
      if (question?.requestId === message.payload.requestId) {
        hideQuestion();
      }
      break;
    case 'settings.open':
      openSettings(message.payload.section, message.payload.focus);
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
