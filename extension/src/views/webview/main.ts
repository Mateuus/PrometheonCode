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
import { renderMarkdown } from './markdown';
import type { LanguageChoice } from '../../i18n/language';
import type { ModelChoice } from '../../providers/types';
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
  AGENT_ROLE_SCOPES,
  AGENT_ROLE_SCOPE_DESCRIPTIONS,
  AGENT_ROLE_SCOPE_LABELS,
  AUTONOMY_DESCRIPTIONS,
  DEFAULT_ROLE_SKILLS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  CONTEXT_STRATEGIES,
  CONTEXT_STRATEGY_DESCRIPTIONS,
  CONTEXT_STRATEGY_LABELS,
  EFFORT_DESCRIPTIONS,
  modelWithoutWindow,
  EFFORT_LEVELS,
  HUB_STATE_LABELS,
  MAX_CONCURRENT_SESSIONS,
  MAX_MODEL_LENGTH,
  MAX_PROFILE_NAME_LENGTH,
  SKILL_RISK_LABELS,
  SKILL_SCOPE_LABELS,
  MAX_ROLE_DESCRIPTION_LENGTH,
  MAX_ROLE_LABEL_LENGTH,
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
  type WorkerMessage,
  type AgentAutonomyMode,
  type AgentProfileSummary,
  type AgentRole,
  type AgentProfileScope,
  type AgentRoleScope,
  type ChatType,
  type CommitLanguage,
  type CommitStyle,
  type ContextStrategy,
  type EffortLevel,
  type CustomAgentRole,
  type GraphRebuildTrigger,
  type SkillSummary,
  type McpKeyValue,
  type McpServerDraft,
  type McpServerSummary,
  type McpTransport,
  type WorkMode,
} from '../../core/types';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_SESSION_TITLE,
  SETTINGS_SECTIONS,
  type AgentProfileDraft,
  type CustomRoleDraft,
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

/** Como `element`, para nós SVG — que não descendem de `HTMLElement`. */
function svgElement<T extends SVGElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Elemento ausente no template: #${id}`);
  }
  return found as unknown as T;
}

const dom = {
  effortAnchor: element<HTMLDivElement>('effort-anchor'),
  sessionTitle: element<HTMLButtonElement>('session-title'),
  sessionTitleText: element<HTMLSpanElement>('session-title-text'),
  sessionTitleInput: element<HTMLInputElement>('session-title-input'),
  toggleSessions: element<HTMLButtonElement>('toggle-sessions'),
  newSession: element<HTMLButtonElement>('new-session'),
  sessionsPopover: element<HTMLDivElement>('sessions-popover'),
  segments: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-chat-type]')),
  sessionSearch: element<HTMLInputElement>('session-search'),
  sessionList: element<HTMLUListElement>('session-list'),
  sessionEmpty: element<HTMLParagraphElement>('session-empty'),
  hubBadge: element<HTMLSpanElement>('hub-badge'),
  bypassBanner: element<HTMLDivElement>('bypass-banner'),
  setupPanel: element<HTMLElement>('setup-panel'),
  setupDescription: element<HTMLParagraphElement>('setup-description'),
  setupButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-setup]')),
  webPanel: element<HTMLElement>('web-panel'),
  webProject: element<HTMLDivElement>('web-project'),
  connectHub: element<HTMLButtonElement>('connect-hub'),
  messages: element<HTMLElement>('messages'),
  agentViews: element<HTMLElement>('agent-views'),
  agentConsole: element<HTMLElement>('agent-console'),
  emptyState: element<HTMLDivElement>('empty-state'),
  working: element<HTMLDivElement>('working'),
  workingWord: element<HTMLSpanElement>('working-word'),
  workingElapsed: element<HTMLSpanElement>('working-elapsed'),
  agentsSection: element<HTMLDetailsElement>('agents-section'),
  agentsCount: element<HTMLSpanElement>('agents-count'),
  agentsList: element<HTMLUListElement>('agents-list'),
  activity: element<HTMLDivElement>('activity'),
  queued: element<HTMLUListElement>('queued'),
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
  attachButton: element<HTMLButtonElement>('attach-button'),
  attachMenu: element<HTMLDivElement>('attach-menu'),
  commandButton: element<HTMLButtonElement>('command-button'),
  commandPanel: element<HTMLDivElement>('command-panel'),
  commandSearch: element<HTMLInputElement>('command-search'),
  commandGroups: element<HTMLDivElement>('command-groups'),
  commandEmpty: element<HTMLParagraphElement>('command-empty'),
  contextButton: element<HTMLButtonElement>('context-button'),
  contextPopover: element<HTMLDivElement>('context-popover'),
  contextBody: element<HTMLDivElement>('context-body'),
  contextFill: svgElement<SVGCircleElement>('context-fill'),
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
    this.fitToViewport();
    this.menu.querySelector<HTMLButtonElement>('.menu-item.active')?.focus();
  }

  /**
   * Puxa o menu para dentro da janela quando ele estoura a borda.
   *
   * O painel é estreito e os pills ficam à direita: ancorado à esquerda do
   * botão, o menu saía da tela e metade das opções ficava inalcançável. A
   * medida é feita depois de exibir — antes disso ele não tem tamanho.
   */
  private fitToViewport(): void {
    this.menu.style.left = '0';
    this.menu.style.right = 'auto';
    this.menu.style.maxHeight = '';

    const margin = 8;
    const box = this.menu.getBoundingClientRect();
    if (box.right > window.innerWidth - margin) {
      // Alinhar pela direita resolve o caso comum; se ainda não couber, o
      // deslocamento explícito cola o menu na margem da janela.
      this.menu.style.left = 'auto';
      this.menu.style.right = '0';
      const shifted = this.menu.getBoundingClientRect();
      if (shifted.left < margin) {
        this.menu.style.right = `${shifted.left - margin}px`;
      }
    }

    // Altura: o menu abre para cima, então o teto é o espaço acima do botão.
    // Um teto pequeno demais esconderia opções — abaixo de 120px é melhor
    // deixar o menu inteiro e confiar na rolagem da janela.
    const above = this.button.getBoundingClientRect().top - margin * 2;
    if (above > 120) {
      this.menu.style.maxHeight = `${above}px`;
    }
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

  /**
   * Escreve no pill um rótulo que não está na lista de opções.
   *
   * Serve ao caso em que o botão deixa de ser um seletor e passa a informar:
   * com a aba de um worker aberta, ele mostra para quem a mensagem vai.
   */
  setLabel(label: string): void {
    this.labelSlot.textContent = label;
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
  effort: new OptionMenu(
    element<HTMLButtonElement>('effort-button'),
    element<HTMLDivElement>('effort-menu'),
    (value) => {
      const effort = EFFORT_LEVELS.find((candidate) => candidate === value);
      if (effort !== undefined) {
        post({ type: 'settings.setEffort', payload: { effort } });
      }
    },
  ),
};

/**
 * Opções de agente principal: os perfis criados vêm primeiro — são eles que
 * carregam papel, conta, modelo e prompt — e os adaptadores crus fecham a
 * lista, para quem ainda não montou perfil nenhum.
 */
/**
 * Rótulos de esforço do agente que vai executar. O perfil aponta para uma
 * conta, e é o adaptador daquele provedor que dá nome aos níveis — "Extra
 * high" no Claude Code, "Extra High" no Codex.
 */
function effortLabelsFor(
  snapshot: PrometheonViewState,
): Partial<Record<EffortLevel, string>> | undefined {
  const profile = snapshot.agentProfiles.find(
    (summary) => summary.profile.id === snapshot.mainAgentId,
  );
  const engine =
    profile === undefined
      ? snapshot.agents.find((agent) => agent.id === snapshot.mainAgentId)
      : snapshot.agents.find((agent) => agent.displayName === profile.providerName);
  return engine?.effortLabels;
}

/**
 * Opções de esforço na ordem da escala, só com os níveis que o adaptador
 * declarou: o Claude Code tem o degrau extra do Ultracode, o Codex não.
 */
function effortOptions(labels: Partial<Record<EffortLevel, string>>): readonly MenuOption[] {
  return EFFORT_LEVELS.filter((level) => labels[level] !== undefined).map((level) => ({
    value: level,
    label: labels[level] ?? level,
    description: s(EFFORT_DESCRIPTIONS[level]),
    icon: 'sliders',
  }));
}

function mainAgentOptions(snapshot: PrometheonViewState): readonly MenuOption[] {
  const profiles = snapshot.agentProfiles
    .filter((summary) => summary.profile.enabled)
    // Só quem lidera entra: orquestradores — inclusive funções nomeadas
    // baseadas em orquestrador. Os outros papéis recebem tarefa, não a dão.
    .filter(
      (summary) => (summary.customRole?.basedOn ?? summary.profile.role) === 'orchestrator',
    )
    .map((summary) => ({
      value: summary.profile.id,
      label: summary.profile.name,
      description: `${summary.customRole?.label ?? s(AGENT_ROLE_LABELS[summary.profile.role])} · ${
        summary.accountName ?? s('unknown provider')
      }`,
      icon: ROLE_ICONS[summary.profile.role],
    }));
  const engines = snapshot.agents.map((agent) => ({
    value: agent.id,
    label: agent.displayName,
    description: agent.available
      ? sf('Available · {0}', agent.transport)
      : sf('Unavailable · {0}', agent.transport),
    icon: 'agent',
  }));
  return [...profiles, ...engines];
}

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

// ---------- Menu de ações ----------

/** Uma ação de menu. Diferente de `MenuOption`, não há item "ativo". */
interface MenuAction {
  readonly label: string;
  readonly description?: string;
  readonly icon: string;
  /** Valor à direita, como o modelo atual ou On/Off de um interruptor. */
  readonly value?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

/**
 * Menu de ações pendurado num botão de ícone.
 *
 * Não é um `OptionMenu`: ali existe uma escolha corrente e a marca de seleção
 * carrega significado. Aqui cada item é um verbo — nada fica "escolhido" depois
 * do clique.
 */
class ActionMenu {
  private items: readonly MenuAction[] = [];

  constructor(
    private readonly button: HTMLButtonElement,
    private readonly menu: HTMLDivElement,
    private readonly build: () => readonly MenuAction[],
  ) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    openActionMenus.add(this);
  }

  get isOpen(): boolean {
    return !this.menu.hidden;
  }

  open(): void {
    closeAllMenus();
    closeAllActionMenus(this);
    this.items = this.build();
    const slot = this.menu.querySelector<HTMLElement>('[data-slot="items"]');
    slot?.replaceChildren(...this.items.map((action) => renderActionItem(action, () => this.close())));
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.menu.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
  }

  close(): void {
    if (!this.isOpen) {
      return;
    }
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }
}

const openActionMenus = new Set<ActionMenu>();

function closeAllActionMenus(except?: ActionMenu): void {
  for (const menu of openActionMenus) {
    if (menu !== except) {
      menu.close();
    }
  }
}

function renderActionItem(action: MenuAction, close: () => void): HTMLElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'menu-item';
  item.setAttribute('role', 'menuitem');
  item.disabled = action.disabled === true;

  const glyph = document.createElement('span');
  glyph.className = 'menu-item-icon';
  glyph.append(...nodes(icon(action.icon)));

  const text = document.createElement('span');
  text.className = 'menu-item-text';

  const label = document.createElement('span');
  label.className = 'menu-item-label';
  label.textContent = action.label;
  text.append(label);

  if (action.description !== undefined) {
    const description = document.createElement('span');
    description.className = 'menu-item-description';
    description.textContent = action.description;
    text.append(description);
  }

  const value = document.createElement('span');
  value.className = 'menu-item-value';
  if (action.value !== undefined) {
    value.textContent = action.value;
  }

  item.append(glyph, text, value);
  item.addEventListener('click', () => {
    close();
    action.run();
  });
  return item;
}

// ---------- Painel de ações `[/]` ----------

/** Um grupo do painel. `items` já vem filtrado quando há busca. */
interface CommandGroup {
  readonly title: string;
  readonly items: readonly MenuAction[];
  /** Bloco livre no lugar da lista — usado pelo resumo de uso. */
  readonly body?: () => HTMLElement;
}

function isCommandPanelOpen(): boolean {
  return !dom.commandPanel.hidden;
}

function openCommandPanel(): void {
  closeAllMenus();
  closeAllActionMenus();
  closeContextPopover();
  dom.commandSearch.value = '';
  dom.commandPanel.hidden = false;
  dom.commandButton.setAttribute('aria-expanded', 'true');
  renderCommandPanel();
  dom.commandSearch.focus();
}

function closeCommandPanel(): void {
  if (!isCommandPanelOpen()) {
    return;
  }
  dom.commandPanel.hidden = true;
  dom.commandButton.setAttribute('aria-expanded', 'false');
}

function toggleCommandPanel(): void {
  if (isCommandPanelOpen()) {
    closeCommandPanel();
  } else {
    openCommandPanel();
  }
}

/**
 * Grupos do painel.
 *
 * Só entra aqui o que o Prometheon faz de verdade. Um item desabilitado com
 * nome bonito é pior do que a ausência dele: promete um recurso e ainda ocupa a
 * linha que a busca teria devolvido para algo funcional.
 */
function commandGroups(): readonly CommandGroup[] {
  const context = state?.context;
  const busy = state?.busy === true;
  const hasMessages = messageCount > 0;

  return [
    {
      title: s('Context'),
      items: [
        {
          label: s('Upload from computer'),
          description: s('Attach images to the message.'),
          icon: 'folder',
          run: () => post({ type: 'chat.attachImages' }),
        },
        {
          label: s('Add context'),
          description: s('Mention a file from this project.'),
          icon: 'box',
          run: () => post({ type: 'context.addFile' }),
        },
        {
          label: s('Compact conversation'),
          description: s('Ask the agent to summarize and continue from the summary.'),
          icon: 'beaker',
          disabled: busy || !hasMessages,
          run: () => post({ type: 'context.compact' }),
        },
        {
          label: s('Auto-compact'),
          description: s('Compact on its own when the window is nearly full.'),
          icon: 'sliders',
          value: context?.autoCompact === true ? s('On') : s('Off'),
          run: () =>
            post({
              type: 'context.setAutoCompact',
              payload: { enabled: context?.autoCompact !== true },
            }),
        },
        {
          label: s('Clear conversation'),
          description: s('Erase the messages and keep the session.'),
          icon: 'magnifier',
          disabled: !hasMessages,
          run: () => post({ type: 'chat.clearLocal' }),
        },
      ],
    },
    {
      title: s('Model'),
      // Os modelos do provedor da conta em uso. Antes era uma lista fixa de
      // Claude; agora quem responde é o catálogo, para o menu não oferecer
      // modelo de outro provedor.
      items: modelsForActiveAccount().map<MenuAction>((model) => ({
        label: model.label,
        description: model.hint === '' ? model.id : model.hint,
        icon: 'sparkle',
        ...(activeModel() === model.id ? { value: s('In use') } : {}),
        run: () => post({ type: 'settings.setModel', payload: { model: model.id } }),
      })),
    },
    {
      title: s('Account & usage'),
      items: [],
      body: renderUsageSummary,
    },
    {
      title: s('Settings'),
      items: [
        {
          label: s('Accounts'),
          description: s('CLI sign-ins available on this machine.'),
          icon: 'person',
          run: () => openSettings('accounts'),
        },
        {
          label: s('Agents'),
          description: s('Agent Profiles and their bindings.'),
          icon: 'agent',
          run: () => openSettings('agents'),
        },
        {
          label: s('MCP servers'),
          icon: 'plug',
          run: () => openSettings('mcp'),
        },
        {
          label: s('Workspace'),
          icon: 'folder',
          run: () => openSettings('workspace'),
        },
      ],
    },
  ];
}

/** Modelo da conta que executa; vazio quando a escolha é do CLI. */
function activeModel(): string {
  return state?.accounts[0]?.model ?? '';
}

/**
 * Modelos do provedor da conta em uso. Vazio quando não há conta ou o catálogo
 * não conhece aquele provedor — e aí a seção de modelo do menu não aparece.
 */
function modelsForActiveAccount(): readonly ModelChoice[] {
  const providerId = state?.accounts[0]?.providerId;
  return (state?.models ?? []).find((entry) => entry.providerId === providerId)?.models ?? [];
}

/**
 * Uso somado das contas.
 *
 * O número é o que o Prometheon mediu **nesta máquina** — não é a fatura nem o
 * limite do plano, que vivem na conta de cada provedor. Dizer isso na tela
 * evita que um total baixo aqui seja lido como folga lá.
 */
function renderUsageSummary(): HTMLElement {
  const accounts = state?.accounts ?? [];
  const block = document.createElement('div');
  block.className = 'usage-summary';

  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'command-note';
    empty.textContent = s('No account yet.');
    block.append(empty);
    return block;
  }

  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = 'usage-row';

    const name = document.createElement('span');
    name.className = 'usage-name';
    name.textContent = `${account.providerName} · ${account.name}`;

    const state_ = document.createElement('span');
    state_.className = `usage-state ${account.authenticated ? 'ok' : 'off'}`;
    state_.textContent = account.authenticated ? s('Signed in') : s('Signed out');

    const today = document.createElement('span');
    today.className = 'usage-numbers';
    today.textContent = sf(
      '{0} today · {1} total · {2} runs',
      formatTokens(account.usage.today.input + account.usage.today.output),
      formatTokens(account.usage.total.input + account.usage.total.output),
      account.usage.runs,
    );

    row.append(name, state_, today);
    block.append(row);
  }

  const total = accounts.reduce(
    (sum, account) => sum + account.usage.total.input + account.usage.total.output,
    0,
  );
  const runs = accounts.reduce((sum, account) => sum + account.usage.runs, 0);

  const footer = document.createElement('p');
  footer.className = 'command-note';
  footer.textContent = sf(
    'All accounts: {0} tokens across {1} runs. Counted by Prometheon on this machine, not by the provider.',
    formatTokens(total),
    runs,
  );
  block.append(footer);
  return block;
}

function renderCommandPanel(): void {
  const query = dom.commandSearch.value.trim().toLowerCase();
  const groups: HTMLElement[] = [];

  for (const group of commandGroups()) {
    const matches =
      query === ''
        ? group.items
        : group.items.filter(
            (item) =>
              item.label.toLowerCase().includes(query) ||
              (item.description ?? '').toLowerCase().includes(query) ||
              group.title.toLowerCase().includes(query),
          );
    // Um grupo com corpo próprio só aparece quando o título casa com a busca:
    // filtrar dentro dele exigiria conhecer o que ele desenha.
    const showBody =
      group.body !== undefined && (query === '' || group.title.toLowerCase().includes(query));

    if (matches.length === 0 && !showBody) {
      continue;
    }

    const section = document.createElement('section');
    section.className = 'command-group';

    const heading = document.createElement('h3');
    heading.className = 'command-group-title';
    heading.textContent = group.title;
    section.append(heading);

    if (showBody && group.body !== undefined) {
      section.append(group.body());
    }
    section.append(
      ...matches.map((action) => renderActionItem(action, () => closeCommandPanel())),
    );
    groups.push(section);
  }

  dom.commandGroups.replaceChildren(...groups);
  dom.commandEmpty.hidden = groups.length > 0;
}

// ---------- Projeto do Web Chat ----------

/** Menu do projeto; recriado a cada render e descartado junto. */
let projectMenu: OptionMenu | null = null;

/**
 * Barra de escolha do projeto.
 *
 * Conversa do Web Chat mora dentro de um projeto do Hub. Sem escolher um não há
 * o que listar — e dizer isso é melhor do que mostrar um histórico vazio que
 * parece uma conversa que nunca aconteceu.
 */
function renderWebProject(next: PrometheonViewState, visible: boolean): void {
  projectMenu?.destroy();
  projectMenu = null;
  dom.webProject.hidden = !visible;

  if (!visible) {
    dom.webProject.replaceChildren();
    return;
  }

  if (next.webProjects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'command-note';
    empty.textContent = s('No project available for this account in the Hub.');
    dom.webProject.replaceChildren(empty);
    return;
  }

  const created = createOptionMenu(
    s('Project'),
    next.webProjects.map((project) => ({
      value: project.id,
      label: project.name,
      icon: 'folder',
    })),
    next.webProjectId ?? '',
    (projectId) => post({ type: 'chat.selectProject', payload: { projectId } }),
  );
  projectMenu = created.menu;

  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = s('Project');
  dom.webProject.replaceChildren(caption, created.root);
}

// ---------- Janela de contexto ----------

/** Comprimento do traço do anel: 2πr, com r = 5.6 do SVG do template. */
const CONTEXT_RING = 2 * Math.PI * 5.6;

function renderContextIndicator(): void {
  const context = state?.context;
  const used = context?.usedTokens ?? 0;
  const window_ = context?.windowTokens ?? 0;
  const ratio = window_ === 0 ? 0 : Math.min(1, used / window_);
  const percent = Math.round(ratio * 100);

  dom.contextFill.style.strokeDasharray = `${(CONTEXT_RING * ratio).toFixed(2)} ${CONTEXT_RING.toFixed(2)}`;
  dom.contextButton.classList.toggle('warn', ratio >= (context?.threshold ?? 0.85));
  dom.contextButton.title = sf('Context window · {0}% used', percent);
  dom.contextButton.setAttribute('aria-label', sf('Context window · {0}% used', percent));

  if (!dom.contextPopover.hidden) {
    renderContextPopover();
  }
}

function renderContextPopover(): void {
  const context = state?.context;
  const used = context?.usedTokens ?? 0;
  const window_ = context?.windowTokens ?? 0;
  const ratio = window_ === 0 ? 0 : Math.min(1, used / window_);
  const busy = state?.busy === true;

  const bar = document.createElement('div');
  bar.className = 'context-bar';
  const fill = document.createElement('span');
  fill.className = 'context-bar-fill';
  fill.style.width = `${String(Math.round(ratio * 100))}%`;
  bar.append(fill);

  const numbers = document.createElement('p');
  numbers.className = 'context-numbers';
  numbers.textContent = sf(
    '{0} of {1} tokens · {2}',
    formatTokens(used),
    formatTokens(window_),
    context?.modelLabel ?? '',
  );

  const note = document.createElement('p');
  note.className = 'command-note';
  // Dizer que é estimativa é parte do dado. O CLI não publica o tamanho do
  // contexto; isto é o que a última chamada consumiu de entrada.
  note.textContent = s('Estimated from the last call. Compacting starts a shorter conversation.');

  const actions = document.createElement('div');
  actions.className = 'context-actions';

  const compact = document.createElement('button');
  compact.type = 'button';
  compact.className = 'primary';
  compact.textContent = s('Compact now');
  compact.disabled = busy || messageCount === 0;
  compact.addEventListener('click', () => {
    closeContextPopover();
    post({ type: 'context.compact' });
  });

  const auto = document.createElement('label');
  auto.className = 'context-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = context?.autoCompact === true;
  box.addEventListener('change', () =>
    post({ type: 'context.setAutoCompact', payload: { enabled: box.checked } }),
  );
  const caption = document.createElement('span');
  caption.textContent = s('Auto-compact');
  auto.append(box, caption);

  actions.append(compact, auto);
  dom.contextBody.replaceChildren(bar, numbers, actions, note);
}

function openContextPopover(): void {
  closeAllMenus();
  closeAllActionMenus();
  closeCommandPanel();
  renderContextPopover();
  dom.contextPopover.hidden = false;
  dom.contextButton.setAttribute('aria-expanded', 'true');
}

function closeContextPopover(): void {
  if (dom.contextPopover.hidden) {
    return;
  }
  dom.contextPopover.hidden = true;
  dom.contextButton.setAttribute('aria-expanded', 'false');
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
  dom.attachButton.disabled = drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE;
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

/** Sem reticências no texto: quem pontua são os três pontos animados ao lado. */
function currentWord(): string {
  return s(WORKING_WORDS[wordIndex] ?? 'Working');
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
/**
 * A fila de mensagens que esperam o agente terminar.
 *
 * Cada uma com o texto que a pessoa escreveu, um jeito de desistir dela, e —
 * na primeira — o botão que interrompe o trabalho atual para mandar tudo
 * agora. Sem essa lista, a mensagem escrita no meio de um run simplesmente
 * sumia, e quem escreveu concluía que tinha errado o envio.
 */
function renderQueued(queued: readonly string[]): void {
  dom.queued.hidden = queued.length === 0;
  dom.queued.replaceChildren(
    ...queued.map((content, index) => {
      const item = document.createElement('li');
      item.className = 'queued-item';

      const text = document.createElement('span');
      text.className = 'queued-text';
      text.textContent = content;
      text.title = content;

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'queued-drop';
      drop.title = s('Discard this message');
      drop.append(...nodes(icon('close')));
      drop.addEventListener('click', () =>
        post({ type: 'chat.dropQueued', payload: { index } }),
      );

      item.append(text);
      if (index === 0) {
        const now = document.createElement('button');
        now.type = 'button';
        now.className = 'queued-now';
        now.textContent = s('Send now');
        now.title = s('Interrupt the current run and send what is waiting');
        now.addEventListener('click', () => post({ type: 'chat.sendQueued' }));
        item.append(now);
      }
      item.append(drop);
      return item;
    }),
  );
}

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
  skills: s('Skills'),
  workspace: s('Workspace'),
  graph: s('Graph'),
  git: s('Git & Commits'),
  mcp: s('MCP'),
};

const SECTION_ICONS: Record<SettingsSection, string> = {
  general: 'sliders',
  accounts: 'person',
  agents: 'agent',
  skills: 'beaker',
  workspace: 'folder',
  graph: 'graph',
  git: 'git',
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
  /** Papel nomeado escolhido; vazio quando o papel é um dos embutidos. */
  customRoleId: string;
  model: string;
  /** O campo de modelo está em modo texto livre, fora da lista do provedor. */
  modelIsCustom: boolean;
  systemPrompt: string;
  /** Esforço padrão; vazio significa "deixe com o CLI". */
  effort: string;
  autonomyMode: AgentAutonomyMode;
  allowedTools: string;
  deniedTools: string;
  /** Nomes de skill separados por vírgula, como o usuário os edita. */
  skills: string;
  maxConcurrentSessions: string;
  contextStrategy: ContextStrategy;
  /** Onde o agente é guardado: no projeto (versionado) ou só nesta máquina. */
  scope: AgentProfileScope;
  enabled: boolean;
}

/** Rascunho de um papel nomeado. `id` nulo significa criação. */
interface RoleDraft {
  id: string | null;
  label: string;
  description: string;
  basedOn: AgentRole;
  skills: string;
  systemPrompt: string;
  scope: AgentRoleScope;
}

/** Valor sentinela do menu de modelo: abre o campo de texto livre. */
const OTHER_MODEL = '\u0000other';

const ROLE_SCOPE_ICONS: Record<AgentRoleScope, string> = {
  project: 'folder',
  hub: 'agent-team',
  machine: 'box',
};

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
/** Conta cujo nome está sendo corrigido no próprio card; nula fora da edição. */
/**
 * Contas com o card expandido. O redesenho do modal recria os nós, então o
 * aberto/fechado de cada `details` sobreviveria zero redesenhos sem isto.
 */
const expandedAccounts = new Set<string>();

/** O formulário de conta nova só ocupa a tela quando alguém pede. */
let accountFormOpen = false;

/** Agentes com o card expandido, pelo id do perfil — mesma razão das contas. */
const expandedAgents = new Set<string>();

/** O gerenciador de papéis é um diálogo; aberto, sobrevive aos redesenhos. */
let rolesDialogOpen = false;

/** Servidores MCP com o card expandido, pelo nome. */
const expandedMcp = new Set<string>();

/** Lista de agentes agrupada por papel — um modo de ver, guardado à parte. */
let agentsGroupByRole = false;

/** Dono do seletor de skills aberto: o rascunho de agente ou o de papel. */
let skillsPickerTarget: 'agent' | 'role' | null = null;
let skillsPickerFilter = '';

/** O diálogo de configurações do workspace está aberto. */
let workspaceDialogOpen = false;
let agentDraft: AgentDraft | null = null;
/** Papel em edição. Abre por cima do formulário de agente, que fica guardado. */
let roleDraft: RoleDraft | null = null;
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
    } else if (section === 'accounts') {
      accountFormOpen = true;
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
  // No documento, e não só no pane: o formulário de conta vive num diálogo
  // sobreposto, fora da árvore do pane.
  return name === undefined
    ? null
    : document.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
}

function closeSettings(): void {
  // Os diálogos empilhados pertencem à configuração: não sobrevivem a ela.
  closeUiDialog();
  accountFormOpen = false;
  rolesDialogOpen = false;
  roleDraft = null;
  agentDraft = null;
  skillsPickerTarget = null;
  workspaceDialogOpen = false;
  mcpDraft = null;
  document.getElementById('account-dialog')?.remove();
  document.getElementById('roles-dialog')?.remove();
  document.getElementById('agent-dialog')?.remove();
  document.getElementById('skills-dialog')?.remove();
  document.getElementById('workspace-dialog')?.remove();
  document.getElementById('mcp-dialog')?.remove();
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
  renderAccountDialog();
  renderAgentDialog();
  renderRolesDialog();
  renderSkillsDialog();
  renderWorkspaceDialog();
  renderMcpDialog();

  if (focusedField !== null && focusedField.field !== null) {
    // No documento, não só no pane: os campos podem morar num diálogo
    // sobreposto, e perder o foco a cada tecla mataria a digitação.
    const restored = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
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
    case 'skills':
      return renderSkillsSection();
    case 'workspace':
      return renderWorkspaceSection();
    case 'graph':
      return renderGraphSection();
    case 'git':
      return renderGitSection();
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
function field(label: string, control: Node, hint?: string, help?: string): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  wrapper.append(fieldCaption(label, help), control);

  if (hint !== undefined) {
    const note = document.createElement('span');
    note.className = 'field-hint';
    note.textContent = hint;
    wrapper.append(note);
  }
  return wrapper;
}

/**
 * Rótulo do campo, com o `?` de ajuda quando há explicação. A dica curta segue
 * embaixo do controle: o texto longo fica atrás do botão para não empurrar o
 * formulário inteiro para baixo.
 */
function fieldCaption(label: string, help?: string): HTMLElement {
  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = label;
  if (help !== undefined) {
    caption.classList.add('field-label-help');
    caption.append(helpButton(label, help));
  }
  return caption;
}

/** Botão de ajuda e a bolha que ele abre. Passar o mouse ou focar também abre. */
function helpButton(label: string, help: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'field-help';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'field-help-trigger';
  trigger.textContent = '?';
  trigger.setAttribute('aria-label', sf('About {0}', label));
  trigger.setAttribute('aria-expanded', 'false');

  const bubble = document.createElement('span');
  bubble.className = 'field-help-bubble';
  bubble.setAttribute('role', 'tooltip');
  bubble.textContent = help;

  const close = (): void => {
    wrapper.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
  };

  trigger.addEventListener('click', (event) => {
    // O rótulo é um `<label>`: sem barrar o clique, ele cairia no controle e a
    // bolha abriria junto com o cursor piscando no campo.
    event.preventDefault();
    event.stopPropagation();
    const open = wrapper.classList.toggle('is-open');
    trigger.setAttribute('aria-expanded', String(open));
  });
  trigger.addEventListener('blur', close);
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && wrapper.classList.contains('is-open')) {
      // Sem parar aqui, o Esc fecharia o painel inteiro junto com a bolha.
      event.stopPropagation();
      close();
    }
  });

  wrapper.append(trigger, bubble);
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
  help?: string,
): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field field-inline';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));

  wrapper.append(box, fieldCaption(label, help));
  return wrapper;
}

/** Menu de seleção dentro de um campo, registrado para ser descartado depois. */
function menuField(
  label: string,
  options: readonly MenuOption[],
  selected: string,
  onSelect: (value: string) => void,
  hint?: string,
  help?: string,
): HTMLElement {
  const created = createOptionMenu(label, options, selected, onSelect);
  sectionMenus.push(created.menu);
  // `label` embrulhando um menu roubaria o clique do botão; aqui é um bloco.
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  wrapper.append(fieldCaption(label, help), created.root);

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
    // O editor de configurações do VS Code mora aqui, e não mais no cabeçalho:
    // duas engrenagens lado a lado não diziam qual abria o quê.
    actionRow(
      actionButton(s('Open VS Code settings'), 'ghost', () =>
        post({ type: 'settings.openEditor' }),
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
    ...renderHubSection(),
  ];
}

/**
 * Conexão com o Prometheon Hub.
 *
 * Mora em General, e não no painel do Web Chat: entrar numa conta é
 * configuração, e escondê-la atrás de "troque para Web" fazia o login parecer
 * um detalhe do chat remoto em vez do que ele é.
 */
function renderHubSection(): readonly Node[] {
  const hub = state?.hub ?? { state: 'local-only' as const };
  const connected = hub.state === 'connected';

  const status = document.createElement('div');
  status.className = 'hub-line';

  const badge = document.createElement('span');
  badge.className = `hub-badge ${hubBadgeClass(hub.state)}`;
  badge.textContent = s(HUB_STATE_LABELS[hub.state]);
  status.append(badge);

  if (hub.detail !== undefined && hub.detail !== '') {
    const detail = document.createElement('span');
    detail.className = 'command-note';
    detail.textContent = hub.detail;
    status.append(detail);
  }

  const nodes: Node[] = [
    sectionHeading(
      s('Prometheon Hub'),
      s(
        'Signing in authorizes this device through your browser. Prometheon never asks for your password, and the credential stays in the editor secret storage.',
      ),
    ),
    status,
  ];

  nodes.push(
    connected
      ? actionRow(
          actionButton(s('Sign out of Hub'), 'ghost', () => post({ type: 'hub.signOut' })),
          actionButton(s('Reconnect'), 'ghost', () => post({ type: 'hub.connect.request' })),
        )
      : actionRow(
          actionButton(s('Sign in to Prometheon Hub'), 'primary', () =>
            post({ type: 'hub.connect.request' }),
          ),
        ),
  );

  return nodes;
}

function hubBadgeClass(state: PrometheonViewState['hub']['state']): string {
  switch (state) {
    case 'connected':
      return 'hub-connected';
    case 'connecting':
      return 'hub-connecting';
    case 'error':
      return 'hub-error';
    default:
      return '';
  }
}

function isLanguageChoice(value: string): value is LanguageChoice {
  return LANGUAGE_OPTIONS.some((option) => option.value === value);
}

// ---------- Seção Accounts ----------

function renderAccountsSection(): readonly Node[] {
  const accounts = state?.accounts ?? [];

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('Accounts'),
      s(
        'Each account is a separate CLI sign-in with its own configuration directory. Signing in always happens through the official CLI flow.',
      ),
    ),
    actionButton(s('Add account'), 'primary', () => {
      accountFormOpen = true;
      renderSettings();
      firstInputFor('accounts')?.focus();
    }),
  );

  const blocks: Node[] = [headingRow];

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
    emptyNote(
      s(
        'Token counts are measured by Prometheon on this machine. Subscription limits live in each provider account and are not read from here.',
      ),
    ),
  );
  return blocks;
}

/**
 * Diálogo de conta nova, sobre o modal de Configurações.
 *
 * É recriado a cada redesenho — o mesmo ciclo de vida do resto do modal — e
 * vive em cima da configuração porque criar conta é um desvio curto: dois
 * campos, e a pessoa volta para a lista de onde saiu.
 */
function renderAccountDialog(): void {
  document.getElementById('account-dialog')?.remove();
  if (!accountFormOpen || !isSettingsOpen()) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'account-dialog';
  overlay.className = 'modal account-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', s('New account'));
  overlay.addEventListener('mousedown', (event) => {
    // Só o clique no pano de fundo fecha; dentro do cartão é uso normal.
    if (event.target === overlay) {
      closeAccountDialog();
    }
  });

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = s('New account');
  header.append(title);

  card.append(header, renderAccountForm(state?.providers ?? []));
  overlay.append(card);
  document.body.append(overlay);
}

function closeAccountDialog(): void {
  accountFormOpen = false;
  renderSettings();
  dom.settingsPane.focus();
}

/**
 * Gerenciador de papéis nomeados, num diálogo sobre a configuração: a lista
 * inteira num lugar só — ver, criar, editar e remover — em vez de formulários
 * espalhados pela seção. Com um rascunho aberto (`roleDraft`), o diálogo vira
 * o próprio formulário; cancelar volta para a lista.
 */
function renderRolesDialog(): void {
  document.getElementById('roles-dialog')?.remove();
  if ((!rolesDialogOpen && roleDraft === null) || !isSettingsOpen()) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'roles-dialog';
  overlay.className = 'modal account-dialog roles-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', s('Roles'));
  overlay.addEventListener('mousedown', (event) => {
    // Com o formulário aberto, clique fora não descarta a digitação — sair
    // dali é decisão dos botões (ou do Esc, que cancela um nível por vez).
    if (event.target === overlay && roleDraft === null) {
      closeRolesDialog();
    }
  });

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card roles-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = s('Roles');
  header.append(title);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'roles-body';

  if (roleDraft !== null) {
    body.append(renderRoleForm(roleDraft));
  } else {
    const roles = state?.customRoles ?? [];
    if (roles.length === 0) {
      body.append(
        emptyNote(s('No named role yet. Create one to reuse a specialty across agents.')),
      );
    }
    for (const role of roles) {
      body.append(renderRoleRow(role));
    }
    body.append(
      actionRow(
        actionButton(s('New role'), 'primary', () => {
          roleDraft = newRoleDraft();
          renderSettings();
        }),
      ),
    );
  }

  card.append(body);
  overlay.append(card);
  document.body.append(overlay);
}

/** Uma linha do gerenciador: quem é o papel, de onde veio, e as duas ações. */
function renderRoleRow(role: CustomAgentRole): HTMLElement {
  const row = document.createElement('div');
  row.className = 'role-row';

  const glyph = document.createElement('span');
  glyph.className = 'role-row-icon';
  const roleIcon = icon(ROLE_ICONS[role.basedOn]);
  if (roleIcon !== null) {
    glyph.append(roleIcon);
  }

  const text = document.createElement('div');
  text.className = 'account-summary-text';
  const label = document.createElement('span');
  label.className = 'account-name';
  label.textContent = role.label;
  const subtitle = document.createElement('span');
  subtitle.className = 'account-subtitle';
  subtitle.textContent = `${s(AGENT_ROLE_LABELS[role.basedOn])} · ${s(AGENT_ROLE_SCOPE_LABELS[role.scope])}`;
  text.append(label, subtitle);

  const actions = document.createElement('div');
  actions.className = 'role-row-actions';
  const remove = accountButton(s('Remove role'), () =>
    confirmDialog({
      title: s('Remove role'),
      body: [
        s('Agents using this role start warning that it is missing; none of them is repointed.'),
      ],
      confirmLabel: s('Remove'),
      danger: true,
      onConfirm: () => post({ type: 'agentRoles.remove', payload: { id: role.id } }),
    }),
  );
  remove.classList.add('danger');
  actions.append(
    accountButton(s('Edit role'), () => {
      roleDraft = roleDraftFrom(role);
      renderSettings();
    }),
    remove,
  );

  row.append(glyph, text, actions);
  return row;
}

function closeRolesDialog(): void {
  rolesDialogOpen = false;
  roleDraft = null;
  renderSettings();
  dom.settingsPane.focus();
}

/**
 * Criar e editar agente acontecem num diálogo próprio: o formulário é o maior
 * da configuração, e inline ele empurrava a lista para fora da tela. O card
 * rola por dentro; clique no pano de fundo não descarta a digitação.
 */
function renderAgentDialog(): void {
  document.getElementById('agent-dialog')?.remove();
  const draft = agentDraft;
  if (draft === null || !isSettingsOpen()) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'agent-dialog';
  overlay.className = 'modal account-dialog agent-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', draft.id === null ? s('New agent') : sf('Edit {0}', draft.name));

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card roles-card agent-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = draft.id === null ? s('New agent') : sf('Edit {0}', draft.name);
  header.append(title);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'roles-body';
  body.append(renderAgentForm(draft, state?.accounts ?? []));
  card.append(body);

  overlay.append(card);
  document.body.append(overlay);
}

/**
 * Casca dos diálogos imperativos — confirmação, renomear, o que vier. Um por
 * vez: abrir outro substitui o anterior. É imperativa de propósito: a pergunta
 * nasce do clique, não do estado, então um redesenho do modal de configuração
 * não a recria nem a perde — o nó vive fora do pane.
 */
function openUiDialog(title: string): HTMLElement {
  closeUiDialog();

  const overlay = document.createElement('div');
  overlay.id = 'ui-dialog';
  overlay.className = 'modal confirm-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) {
      closeUiDialog();
    }
  });

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card confirm-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const heading = document.createElement('h2');
  heading.textContent = title;
  header.append(heading);
  card.append(header);

  overlay.append(card);
  document.body.append(overlay);
  return card;
}

/** Fecha o diálogo imperativo, se houver. Devolve se havia um aberto. */
function closeUiDialog(): boolean {
  const open = document.getElementById('ui-dialog');
  if (open === null) {
    return false;
  }
  open.remove();
  return true;
}

/** Fileira de ações de um diálogo: a principal primeiro, cancelar por último. */
function dialogActions(...buttons: readonly HTMLElement[]): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'field-actions confirm-actions';
  actions.append(...buttons);
  return actions;
}

/** Confirmação antes de uma ação com consequência — o uso mais comum da casca. */
function confirmDialog(options: {
  readonly title: string;
  readonly body?: readonly string[];
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
}): void {
  const card = openUiDialog(options.title);

  const body = document.createElement('div');
  body.className = 'confirm-body';
  for (const paragraph of options.body ?? []) {
    const text = document.createElement('p');
    text.textContent = paragraph;
    body.append(text);
  }
  card.append(body);

  const confirm = actionButton(options.confirmLabel, 'primary', () => {
    closeUiDialog();
    options.onConfirm();
  });
  if (options.danger === true) {
    confirm.classList.add('danger');
  }
  const cancel = actionButton(s('Cancel'), 'ghost', () => closeUiDialog());
  card.append(dialogActions(confirm, cancel));

  // O foco nasce no caminho seguro: confirmar exige mirar, cancelar é o Enter.
  cancel.focus();
}

/** Renomeia a conta num diálogo próprio; Enter salva, Esc desiste. */
function renameAccountDialog(account: PrometheonViewState['accounts'][number]): void {
  const card = openUiDialog(s('Rename'));

  let draft = account.name;
  const commit = (): void => {
    const name = draft.trim();
    if (name === '') {
      showNotification(s('Give the account a name.'), 'warning');
      return;
    }
    closeUiDialog();
    if (name !== account.name) {
      post({ type: 'accounts.rename', payload: { profileId: account.profileId, name } });
    }
  };

  const input = textInput({
    name: 'account-rename',
    value: account.name,
    maxLength: MAX_PROFILE_NAME_LENGTH,
    onInput: (value) => {
      draft = value;
    },
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });

  const body = document.createElement('div');
  body.className = 'confirm-body';
  body.append(field(s('Name'), input));
  card.append(body);

  card.append(
    dialogActions(
      actionButton(s('Save name'), 'primary', commit),
      actionButton(s('Cancel'), 'ghost', () => closeUiDialog()),
    ),
  );

  input.focus();
  input.select();
}

function renderAccountForm(providers: PrometheonViewState['providers']): HTMLElement {
  const form = document.createElement('section');
  form.className = 'settings-form';

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
        // O exemplo precisa parecer exemplo. Um nome de pessoa aqui se confunde
        // com um campo já preenchido, e o botão de criar recusa sem que nada na
        // tela explique o porquê.
        placeholder: s('e.g. Personal, Work, Client X'),
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
    // O modelo não é escolha da conta: uma conta é um login isolado, e o mesmo
    // login serve a agentes que usam modelos diferentes. Quem escolhe o modelo
    // é o Agent Profile, no campo Model daquele formulário.
    actionRow(
      actionButton(s('Create account'), 'primary', () => {
        const name = accountDraft.name.trim();
        if (name === '' || accountDraft.providerId === '') {
          showNotification(s('Give the account a name before creating it.'), 'warning');
          return;
        }
        post({
          type: 'accounts.create',
          payload: { name, providerId: accountDraft.providerId },
        });
        accountDraft = { ...accountDraft, name: '' };
        // Criou, o diálogo já cumpriu o papel: a lista é o que interessa.
        closeAccountDialog();
      }),
      actionButton(s('Cancel'), 'ghost', closeAccountDialog),
    ),
  );
  return form;
}

function renderAccount(account: PrometheonViewState['accounts'][number]): HTMLElement {
  // O card é um `details`: fechado mostra só nome e estado, e a lista inteira
  // cabe na tela.
  const card = document.createElement('details');
  card.className = `account ${account.authenticated ? 'signed-in' : 'signed-out'}`;
  card.open = expandedAccounts.has(account.profileId);
  card.addEventListener('toggle', () => {
    if (card.open) {
      expandedAccounts.add(account.profileId);
    } else {
      expandedAccounts.delete(account.profileId);
    }
  });

  const header = document.createElement('summary');
  header.className = 'account-summary';

  // `stateBadge`, não `state`: o snapshot global chama-se `state`, e sombreá-lo
  // aqui faria o filtro de agentes vinculados ler um span em vez do estado.
  const stateBadge = document.createElement('span');
  stateBadge.className = 'account-state';
  stateBadge.textContent = account.authenticated
    ? s('Signed in')
    : account.cliInstalled
      ? s('Signed out')
      : s('CLI missing');

  // Fechado, o card ainda diz de quem é: provedor e e-mail numa linha apagada
  // sob o nome — o suficiente para distinguir contas sem abrir nenhuma.
  const text = document.createElement('div');
  text.className = 'account-summary-text';

  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = account.name;
  text.append(name);

  const subtitleParts = [account.providerName, account.accountLabel].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  if (subtitleParts.length > 0) {
    const subtitle = document.createElement('span');
    subtitle.className = 'account-subtitle';
    subtitle.textContent = subtitleParts.join(' · ');
    text.append(subtitle);
  }

  header.append(text, stateBadge);
  card.append(header);

  // A identidade abre o corpo: quem é este login, de relance — e-mail em
  // destaque, método e organização na linha apagada, plano como selo. Sem
  // sessão não há identidade a mostrar: o CLI responde "none", e "none" na
  // tela é ruído fingindo ser informação.
  if (account.authenticated) {
    const identity = document.createElement('div');
    identity.className = 'account-identity';

    const avatar = document.createElement('span');
    avatar.className = 'account-avatar';
    avatar.textContent = (account.name.trim().charAt(0) || '?').toUpperCase();

    const identityText = document.createElement('div');
    identityText.className = 'account-identity-text';
    const identityPrimary = document.createElement('span');
    identityPrimary.className = 'account-identity-primary';
    identityPrimary.textContent = account.accountLabel ?? account.providerName;
    identityText.append(identityPrimary);

    const identityDetails = [account.authMethod, account.organization].filter(
      (part): part is string => part !== undefined && part !== '',
    );
    if (identityDetails.length > 0) {
      const identitySecondary = document.createElement('span');
      identitySecondary.className = 'account-identity-secondary';
      identitySecondary.textContent = identityDetails.join(' · ');
      identityText.append(identitySecondary);
    }
    identity.append(avatar, identityText);

    if (account.plan !== undefined && account.plan !== '') {
      const plan = document.createElement('span');
      plan.className = 'account-plan';
      plan.textContent = account.plan;
      identity.append(plan);
    }
    card.append(identity);
  }

  const rows: [string, string][] = [
    [
      s('Provider'),
      account.cliVersion === undefined
        ? account.providerName
        : `${account.providerName} ${account.cliVersion}`,
    ],
  ];
  if (account.message !== undefined && !account.authenticated) {
    rows.push([s('Status'), account.message]);
  }
  card.append(definitionList(rows));

  // Uso em três painéis — hoje, semana, sempre — com entrada e saída
  // empilhadas: números comparáveis de coluna a coluna, sem tabela.
  const usage = document.createElement('div');
  usage.className = 'usage';
  const title = document.createElement('span');
  title.className = 'usage-title';
  title.textContent =
    account.usage.runs > 0
      ? sf('{0} · {1} runs', s('Tokens measured locally'), account.usage.runs)
      : s('Tokens measured locally');
  const grid = document.createElement('div');
  grid.className = 'usage-grid';
  const windows: [string, { input: number; output: number }][] = [
    [s('Today'), account.usage.today],
    [s('Last 7 days'), account.usage.last7Days],
    [s('All time'), account.usage.total],
  ];
  for (const [label, tokens] of windows) {
    const cell = document.createElement('div');
    cell.className = 'usage-cell';
    const input = document.createElement('span');
    input.className = 'usage-cell-value';
    input.textContent = `↑ ${formatTokens(tokens.input)}`;
    const output = document.createElement('span');
    output.className = 'usage-cell-value usage-cell-out';
    output.textContent = `↓ ${formatTokens(tokens.output)}`;
    const caption = document.createElement('span');
    caption.className = 'usage-cell-label';
    caption.textContent = label;
    caption.title = label;
    cell.append(input, output, caption);
    grid.append(cell);
  }
  usage.append(title, grid);
  card.append(usage);

  const directory = document.createElement('code');
  directory.className = 'account-directory';
  directory.textContent = account.configDirectory;
  directory.title = account.configDirectory;
  card.append(directory);

  const actions = document.createElement('div');
  actions.className = 'account-actions';
  // Um botão de sessão só: conectado sai, desconectado entra. Oferecer os dois
  // ao mesmo tempo é pedir que a pessoa deduza qual deles vale agora.
  const session = account.authenticated
    ? accountButton(s('Sign out'), () =>
        confirmDialog({
          title: s('Sign out of this account?'),
          body: [s('The isolated configuration directory is kept.')],
          confirmLabel: s('Sign out'),
          onConfirm: () =>
            post({ type: 'accounts.logout', payload: { profileId: account.profileId } }),
        }),
      )
    : accountButton(s('Sign in'), () =>
        post({ type: 'accounts.login', payload: { profileId: account.profileId } }),
      );
  actions.append(session, accountButton(s('Rename'), () => renameAccountDialog(account)));
  // Remover é a única ação sem volta do card: fica separada, com a cor de
  // perigo, e conta o que sobra — o diretório fica, os agentes vinculados
  // param até apontarem para outra conta.
  const bound = (state?.agentProfiles ?? []).filter(
    (summary) => summary.profile.providerProfileId === account.profileId,
  );
  const remove = accountButton(s('Remove'), () =>
    confirmDialog({
      title: s('Remove account'),
      body: [
        sf(
          'The sign-in files in {0} are kept. Delete that folder yourself to also drop the credentials.',
          account.configDirectory,
        ),
        ...(bound.length === 0
          ? []
          : [
              sf(
                '{0} agent profile(s) still point to this account and will stop until they are bound to another one.',
                bound.length,
              ),
            ]),
      ],
      confirmLabel: s('Remove'),
      danger: true,
      onConfirm: () =>
        post({ type: 'accounts.remove', payload: { profileId: account.profileId } }),
    }),
  );
  remove.classList.add('danger');
  actions.append(remove);
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
    customRoleId: '',
    model: '',
    modelIsCustom: false,
    systemPrompt: '',
    effort: '',
    autonomyMode: 'manual',
    allowedTools: '',
    deniedTools: '',
    // As skills do papel já vêm marcadas: começar do zero a cada agente é o
    // que o catálogo existe para evitar.
    skills: defaultSkillsFor('implementer', '').join(', '),
    maxConcurrentSessions: '1',
    contextStrategy: 'project',
    scope: 'machine',
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
    customRoleId: profile.customRoleId ?? '',
    model: profile.model ?? '',
    // Um modelo gravado que não está no catálogo abre já em texto livre: ele foi
    // escolhido de propósito e não pode aparecer como "Chosen by the CLI".
    modelIsCustom: isUnlistedModel(profile.model ?? '', summary),
    systemPrompt: profile.systemPrompt ?? '',
    effort: profile.effort ?? '',
    autonomyMode: profile.autonomyMode,
    allowedTools: profile.allowedTools.join(', '),
    deniedTools: profile.deniedTools.join(', '),
    skills: profile.skills.join(', '),
    maxConcurrentSessions: String(profile.maxConcurrentSessions),
    contextStrategy: profile.contextStrategy,
    scope: profile.scope ?? 'machine',
    enabled: profile.enabled,
  };
}

/**
 * Skills que um papel traz por padrão. O papel nomeado tem as suas; os
 * embutidos usam a lista de `DEFAULT_ROLE_SKILLS`. Só entram as que existem no
 * catálogo — sugerir uma skill ausente seria prometer o que não há.
 */
function defaultSkillsFor(role: AgentRole, customRoleId: string): readonly string[] {
  const custom = (state?.customRoles ?? []).find((entry) => entry.id === customRoleId);
  const wanted = custom?.skills ?? DEFAULT_ROLE_SKILLS[role];
  const available = new Set((state?.skills.skills ?? []).map((skill) => skill.name));
  return wanted.filter((name) => available.has(name));
}

function newRoleDraft(): RoleDraft {
  return {
    id: null,
    label: '',
    description: '',
    basedOn: 'tester',
    skills: '',
    systemPrompt: '',
    // Projeto é o padrão porque é o escopo que a equipe enxerga; sem pasta
    // aberta a opção nem aparece, e aí a máquina assume.
    scope: state?.workspace.folderName === null ? 'machine' : 'project',
  };
}

function roleDraftFrom(role: CustomAgentRole): RoleDraft {
  return {
    id: role.id,
    label: role.label,
    description: role.description,
    basedOn: role.basedOn,
    skills: role.skills.join(', '),
    systemPrompt: role.systemPrompt ?? '',
    scope: role.scope,
  };
}

/** O modelo gravado não está no catálogo do provedor da conta vinculada. */
function isUnlistedModel(model: string, summary: AgentProfileSummary): boolean {
  if (model.trim() === '') {
    return false;
  }
  const account = (state?.accounts ?? []).find(
    (entry) => entry.profileId === summary.profile.providerProfileId,
  );
  const known = (state?.models ?? []).find(
    (entry) => entry.providerId === account?.providerId,
  )?.models;
  return known === undefined || !known.some((entry) => entry.id === model.trim());
}

/** Lista separada por vírgula ou quebra de linha, sem itens vazios. */
function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Estado vazio da seção de agentes: em vez de uma linha seca, o modelo do
 * produto em um cartão — ícone, uma frase e o diagrama Agente → Papel → Conta.
 * O corpo muda conforme o que falta (uma conta, ou só o primeiro agente).
 */
function agentsEmptyHero(body: string, ...buttons: readonly HTMLElement[]): HTMLElement {
  const hero = document.createElement('div');
  hero.className = 'settings-hero';

  const tile = document.createElement('span');
  tile.className = 'settings-hero-icon';
  const glyph = icon('agent');
  if (glyph !== null) {
    tile.append(glyph);
  }

  const title = document.createElement('h4');
  title.className = 'settings-hero-title';
  title.textContent = s('Assemble your agent team');

  const text = document.createElement('p');
  text.className = 'settings-hero-body';
  text.textContent = body;

  // O diagrama é o modelo inteiro numa linha: quem age, o que faz, por onde.
  const chain = document.createElement('div');
  chain.className = 'settings-hero-chain';
  const links: readonly [string, string][] = [
    ['agent', s('Agent')],
    ['sliders', s('Role')],
    ['person', s('Account')],
  ];
  links.forEach(([glyphName, label], index) => {
    if (index > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'settings-hero-arrow';
      arrow.textContent = '→';
      chain.append(arrow);
    }
    const chip = document.createElement('span');
    chip.className = 'settings-hero-chip';
    const chipIcon = icon(glyphName);
    if (chipIcon !== null) {
      chip.append(chipIcon);
    }
    const chipLabel = document.createElement('span');
    chipLabel.textContent = label;
    chip.append(chipLabel);
    chain.append(chip);
  });

  const actions = document.createElement('div');
  actions.className = 'settings-hero-actions';
  actions.append(...buttons);

  hero.append(tile, title, text, chain, actions);
  return hero;
}

function renderAgentsSection(): readonly Node[] {
  const profiles = state?.agentProfiles ?? [];
  const accounts = state?.accounts ?? [];

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('Agent Profiles'),
      s(
        'Every agent runs through one account. Prometheon never falls back to another one when the bound account is unavailable.',
      ),
    ),
  );

  // Antes da primeira conta, a seção ensina em vez de listar: sem conta não
  // existe agente, e o único passo que faz sentido é ir criá-la.
  if (accounts.length === 0) {
    return [
      headingRow,
      agentsEmptyHero(
        s('An agent profile needs an account. Create one first, then come back here.'),
        actionButton(s('Go to Accounts'), 'primary', () => selectSection('accounts')),
      ),
    ];
  }

  const firstAccount = accounts[0];
  headingRow.append(
    actionButton(s('Roles'), 'ghost', () => {
      rolesDialogOpen = true;
      renderSettings();
    }),
    actionButton(s('New agent'), 'primary', () => {
      agentDraft = newAgentDraft(firstAccount?.profileId ?? '');
      renderSettings();
      firstInputFor('agents')?.focus();
    }),
  );

  const blocks: Node[] = [headingRow];

  if (profiles.length === 0) {
    blocks.push(
      agentsEmptyHero(
        s('An agent is a role plus an account: the role says what it does, the account says how it runs.'),
      ),
    );
    return blocks;
  }

  // Agrupar por papel é um modo de ver, não uma ação — por isso mora junto da
  // lista, e só quando há agentes suficientes para a ordem importar.
  if (profiles.length > 1) {
    const view = document.createElement('div');
    view.className = 'agents-viewbar';
    const group = actionButton(s('Group by role'), 'ghost', () => {
      agentsGroupByRole = !agentsGroupByRole;
      renderSettings();
    });
    group.classList.add('agents-viewtoggle');
    group.setAttribute('aria-pressed', String(agentsGroupByRole));
    view.append(group);
    blocks.push(view);
  }

  if (agentsGroupByRole) {
    for (const [label, members] of groupAgentsByRole(profiles)) {
      const title = document.createElement('span');
      title.className = 'usage-title agents-group-title';
      title.textContent = label;
      blocks.push(title, ...members.map(renderAgentProfile));
    }
  } else {
    blocks.push(fragment(profiles.map(renderAgentProfile)));
  }
  return blocks;
}

/** Agrupa pela etiqueta do papel; nomeados aparecem pelo próprio nome. */
function groupAgentsByRole(
  profiles: readonly AgentProfileSummary[],
): readonly [string, readonly AgentProfileSummary[]][] {
  const groups = new Map<string, AgentProfileSummary[]>();
  for (const summary of profiles) {
    const label = summary.customRole?.label ?? s(AGENT_ROLE_LABELS[summary.profile.role]);
    const bucket = groups.get(label);
    if (bucket === undefined) {
      groups.set(label, [summary]);
    } else {
      bucket.push(summary);
    }
  }
  return [...groups.entries()];
}

/**
 * Catálogo de skills: o que existe, de onde veio e quanto custa carregar.
 *
 * A seção é de leitura. Editar uma skill é editar o `SKILL.md` — por isso cada
 * cartão abre o arquivo no editor em vez de oferecer um formulário: o arquivo é
 * a fonte, e um formulário por cima dele criaria duas.
 */
/** Skills com o card aberto — mesma memória de expansão de contas e agentes. */
const expandedSkills = new Set<string>();

/**
 * Diálogo de skill nova: nome e onde ela vive. Criar abre o SKILL.md no
 * editor — o arquivo é a skill; o diálogo só escolhe o lugar do arquivo.
 */
function newSkillDialog(): void {
  const card = openUiDialog(s('New skill'));
  let scope: 'project' | 'machine' = 'project';
  let name = '';

  const submit = (): void => {
    const trimmed = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      showNotification(
        s('Skill names use lowercase letters, numbers and dashes — it is also the folder name.'),
        'warning',
      );
      return;
    }
    closeUiDialog();
    post({ type: 'skills.create', payload: { name: trimmed, scope } });
  };

  const input = textInput({
    name: 'skill-name',
    value: '',
    placeholder: 'unreal-build-check',
    maxLength: 64,
    onInput: (value) => {
      name = value;
    },
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });

  const machineOnly = document.createElement('label');
  machineOnly.className = 'field field-inline';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => {
    scope = checkbox.checked ? 'machine' : 'project';
  });
  const checkboxLabel = document.createElement('span');
  checkboxLabel.className = 'field-label';
  checkboxLabel.textContent = s('Only on this machine');
  machineOnly.append(checkbox, checkboxLabel);

  const body = document.createElement('div');
  body.className = 'confirm-body';
  body.append(
    field(
      s('Name'),
      input,
      s('Lowercase, numbers and dashes. Project skills live in .prometheon/skills/ and travel with the repository.'),
    ),
    machineOnly,
  );
  card.append(
    body,
    dialogActions(
      actionButton(s('Create skill'), 'primary', submit),
      actionButton(s('Cancel'), 'ghost', () => closeUiDialog()),
    ),
  );
  input.focus();
}

function renderSkillsSection(): readonly Node[] {
  const catalog = state?.skills ?? { skills: [], problems: [], roots: [] };

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('Skills'),
      s(
        'A skill is a procedure an agent follows. Only the name and the trigger line stay in the prompt; the body is read when the agent needs it.',
      ),
    ),
    actionButton(s('New skill'), 'primary', newSkillDialog),
  );
  const blocks: Node[] = [headingRow];

  if (catalog.roots.length > 0) {
    blocks.push(emptyNote(sf('Read from: {0}', catalog.roots.join(' · '))));
  }

  if (catalog.skills.length === 0 && catalog.problems.length === 0) {
    blocks.push(
      emptyNote(s('No skill found yet. Add one under .prometheon/skills/ and refresh.')),
    );
  }

  const byCategory = new Map<string, SkillSummary[]>();
  for (const skill of catalog.skills) {
    const bucket = byCategory.get(skill.category) ?? [];
    bucket.push(skill);
    byCategory.set(skill.category, bucket);
  }

  for (const category of [...byCategory.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const group = document.createElement('div');
    group.className = 'skill-group';

    const title = document.createElement('h4');
    title.className = 'skill-group-title';
    title.textContent = `${category} · ${String(byCategory.get(category)?.length ?? 0)}`;
    group.append(title, ...(byCategory.get(category) ?? []).map(renderSkill));
    blocks.push(group);
  }

  // Uma skill que não pôde ser lida aparece com o motivo. Sumir em silêncio
  // faria parecer que ela não existe, e o autor procuraria no lugar errado.
  if (catalog.problems.length > 0) {
    blocks.push(
      sectionHeading(sf('{0} skills could not be read', catalog.problems.length)),
      ...catalog.problems.map((problem) => warningNote(`${problem.path} — ${problem.detail}`)),
    );
  }

  blocks.push(
    actionRow(
      actionButton(s('Refresh'), 'ghost', () => post({ type: 'skills.refresh' })),
    ),
  );
  return blocks;
}

function renderSkill(skill: SkillSummary): HTMLElement {
  // Colapsável como contas e agentes: fechada é uma linha — nome, gatilho e
  // escopo — e um catálogo de trinta skills cabe na tela sem rolagem infinita.
  const card = document.createElement('details');
  card.className = `account skill-card${skill.supported ? '' : ' disabled'}`;
  card.open = expandedSkills.has(skill.path);
  card.addEventListener('toggle', () => {
    if (card.open) {
      expandedSkills.add(skill.path);
    } else {
      expandedSkills.delete(skill.path);
    }
  });

  const header = document.createElement('summary');
  header.className = 'account-summary';

  const text = document.createElement('div');
  text.className = 'account-summary-text';
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = skill.name;
  const trigger = document.createElement('span');
  trigger.className = 'account-subtitle';
  trigger.textContent = skill.description;
  trigger.title = skill.description;
  text.append(name, trigger);

  const scope = document.createElement('span');
  scope.className = 'account-state';
  scope.textContent = s(SKILL_SCOPE_LABELS[skill.scope]);

  header.append(text, scope);
  card.append(header);

  // O gatilho completo mora no corpo; o resumo mostra só o que cabe na linha.
  const description = document.createElement('p');
  description.className = 'agent-chain';
  description.textContent = skill.description;
  card.append(description);

  const rows: [string, string][] = [
    [s('Risk'), s(SKILL_RISK_LABELS[skill.riskLevel])],
    // O custo do nível 2 é o que a pessoa precisa saber antes de marcar a skill
    // num agente: é o que será pago toda vez que ele a carregar.
    [s('Body'), sf('~{0} tokens', skill.bodyTokensEstimate)],
  ];
  if (skill.version !== null) {
    rows.push([s('Version'), skill.version]);
  }
  if (skill.license !== null) {
    rows.push([s('License'), skill.license]);
  }
  if (skill.author !== null) {
    rows.push([s('Author'), skill.author]);
  }
  if (skill.supportFiles.length > 0) {
    rows.push([s('Support files'), skill.supportFiles.join(', ')]);
  }
  if (skill.requiresMcp.length > 0) {
    rows.push([s('Requires MCP'), skill.requiresMcp.join(', ')]);
  }
  card.append(definitionList(rows));

  if (!skill.supported) {
    card.append(
      warningNote(
        sf('This skill declares {0} and does not run here.', skill.platforms.join(', ')),
      ),
    );
  }
  if (skill.autonomyCeiling === 'manual') {
    card.append(
      warningNote(
        s('This skill caps the agent at Manual: it asks for approval even in Auto or Bypass.'),
      ),
    );
  }

  card.append(
    actionRow(
      actionButton(s('Open SKILL.md'), 'ghost', () =>
        post({ type: 'skills.open', payload: { name: skill.name } }),
      ),
    ),
  );
  return card;
}

function fragment(children: readonly Node[]): DocumentFragment {
  const parent = document.createDocumentFragment();
  parent.append(...children);
  return parent;
}

function renderAgentProfile(summary: AgentProfileSummary): HTMLElement {
  const profile = summary.profile;
  // Colapsável como o card de conta: fechado é uma linha — nome, conta e
  // papel —, e uma equipe grande cabe inteira na tela.
  const card = document.createElement('details');
  card.className = `account agent-profile ${profile.enabled ? 'enabled' : 'disabled'}`;
  card.open = expandedAgents.has(profile.id);
  card.addEventListener('toggle', () => {
    if (card.open) {
      expandedAgents.add(profile.id);
    } else {
      expandedAgents.delete(profile.id);
    }
  });

  const header = document.createElement('summary');
  header.className = 'account-summary';

  const text = document.createElement('div');
  text.className = 'account-summary-text';
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = profile.name;
  text.append(name);

  const subtitleParts = [summary.providerName, summary.accountName].filter(
    (part): part is string => part !== null && part !== '',
  );
  if (subtitleParts.length > 0) {
    const subtitle = document.createElement('span');
    subtitle.className = 'account-subtitle';
    subtitle.textContent = subtitleParts.join(' · ');
    text.append(subtitle);
  }

  const role = document.createElement('span');
  role.className = 'account-state';
  // O papel nomeado aparece pelo próprio nome: dizer "Custom" esconderia
  // justamente o que distingue este agente dos outros.
  role.textContent = summary.customRole?.label ?? s(AGENT_ROLE_LABELS[profile.role]);

  header.append(text, role);
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
  const skills = [...(summary.customRole?.skills ?? []), ...profile.skills];
  if (skills.length > 0) {
    rows.push([s('Skills'), [...new Set(skills)].join(', ')]);
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
        confirmDialog({
          title: s('Remove agent'),
          body: [s('The agent profile is deleted. The account it points to is not touched.')],
          confirmLabel: s('Remove'),
          danger: true,
          onConfirm: () => post({ type: 'agentProfiles.remove', payload: { id: profile.id } }),
        }),
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

  const update = (patch: Partial<AgentDraft>, redraw = false): void => {
    // Sobre o estado ATUAL, nunca sobre o snapshot deste render: cada campo
    // guarda o próprio closure, e espalhar o snapshot faria a edição de um
    // campo apagar o que foi digitado nos outros desde o último redesenho.
    agentDraft = { ...(agentDraft ?? draft), ...patch };
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
      undefined,
      s(
        'Shown in the agent list and when the orchestrator delegates. It also derives the profile id at creation; renaming later keeps the original id.',
      ),
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
      s(
        'Each agent has its own CLI sign-in, isolated from the others. If the bound account is unavailable this agent simply does not run — Prometheon never borrows another one.',
      ),
    ),
    roleField(draft, update),
    modelField(draft, accounts, update),
    agentPromptField(draft, update),
    agentPromptFileRow(draft),
    effortField(draft, update),
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
      undefined,
      s(
        'How far this agent goes before it stops and asks. Bypass is temporary by design: it lives in memory only, and restarting the extension or switching workspace drops it back to Manual.',
      ),
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
      undefined,
      s(
        'How much this agent gets to see: the task alone, the repository plus the Prometheon Brain, or the knowledge shared through the Hub.',
      ),
    ),
    menuField(
      s('Where it lives'),
      [
        {
          value: 'machine',
          label: s('This machine'),
          description: s('Only you have this agent. Nothing is written to the repository.'),
          icon: 'machine',
        },
        {
          value: 'project',
          label: s('This project'),
          description: s(
            'Saved in .prometheon/agents/, which goes to git — everyone who clones gets this agent. The account stays yours: each machine picks its own.',
          ),
          icon: 'project',
        },
      ],
      draft.scope,
      (value) => update({ scope: value as AgentProfileScope }, true),
      undefined,
      s(
        'An agent describes how the work gets done here, so it belongs with the code. What never travels is the account behind it.',
      ),
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
      s('Restricts this agent to these tools. Empty means whatever the provider allows by default.'),
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
      s(
        'Tools this agent may never use, even when they also appear in the allowed list. Denied always wins.',
      ),
    ),
    skillsSummaryField(
      'agent',
      (state?.skills.skills ?? []).length === 0
        ? s('No skill found yet. Add one under .prometheon/skills/ and refresh.')
        : sf('{0} skills available in this workspace.', (state?.skills.skills ?? []).length),
      s(
        'Procedures this agent may load during a run. Only the name and the trigger line stay in the prompt; the body is read when the agent asks for it.',
      ),
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
      s(
        'How many tasks this agent runs at the same time. Each session is a separate CLI process, with its own context and its own cost, so four means four processes on this machine. Keep it at 1 when the tasks touch the same files.',
      ),
    ),
    checkboxField(
      s('Enabled'),
      draft.enabled,
      (value) => update({ enabled: value }),
      s(
        'A disabled agent keeps its configuration but is not offered for delegation and starts no new session.',
      ),
    ),
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

/**
 * Campo de modelo.
 *
 * A lista vem do provedor da conta vinculada — Claude Code oferece modelos
 * Claude, Codex oferece os dele. Ela é conveniência: `Other…` devolve o campo
 * de texto, porque o provedor lança modelo sem avisar e o Prometheon não deve
 * ser o motivo de você não conseguir usar o mais novo.
 */
function modelField(
  draft: AgentDraft,
  accounts: PrometheonViewState['accounts'],
  update: (patch: Partial<AgentDraft>, redraw?: boolean) => void,
): HTMLElement {
  const account = accounts.find((entry) => entry.profileId === draft.providerProfileId);
  const known = (state?.models ?? []).find(
    (entry) => entry.providerId === account?.providerId,
  )?.models ?? [];
  const typed = draft.model.trim();
  const listed = known.some((model) => model.id === typed);

  // Sem catálogo para este provedor, ou já digitando algo fora da lista, o campo
  // é o de texto: um menu de uma opção só atrapalharia.
  if (known.length === 0 || draft.modelIsCustom) {
    const wrapper = field(
      s('Model'),
      textInput({
        name: 'agent-model',
        value: draft.model,
        placeholder: s('Leave empty to use the CLI default'),
        maxLength: MAX_MODEL_LENGTH,
        onInput: (value) => update({ model: value }),
      }),
      known.length === 0
        ? s('Free text: the CLI validates it when the agent runs.')
        : sf('{0} models known for this provider.', known.length),
      s(
        'The model id handed to the CLI, exactly as typed. A wrong id only fails when the agent runs.',
      ),
    );
    if (known.length > 0) {
      wrapper.append(
        actionRow(
          actionButton(s('Pick from the list'), 'link', () =>
            update({ modelIsCustom: false }, true),
          ),
        ),
      );
    }
    return wrapper;
  }

  const options: MenuOption[] = [
    {
      value: '',
      label: s('Chosen by the CLI'),
      description: s('Whatever the CLI already uses for this account.'),
      icon: 'sparkle',
    },
    ...known.map((model) => ({
      value: model.id,
      label: model.label,
      description: model.hint === '' ? model.id : `${model.hint} · ${model.id}`,
      icon: 'sparkle',
    })),
    {
      value: OTHER_MODEL,
      label: s('Other…'),
      description: s('Type a model id the list does not have yet.'),
      icon: 'sliders',
    },
  ];

  return menuField(
    s('Model'),
    options,
    listed ? typed : '',
    (value) => {
      if (value === OTHER_MODEL) {
        update({ modelIsCustom: true }, true);
        return;
      }
      update({ model: value, modelIsCustom: false }, true);
    },
    s('The account only holds the sign-in. The model is this agent’s choice.'),
    s(
      'The model id handed to the CLI. The list comes from the provider of the bound account and is a convenience — pick Other… to type an id it does not have yet, or edit models.json to add it for good.',
    ),
  );
}

/**
 * Campo de papel: os sete embutidos, os papéis nomeados que existem aqui e a
 * entrada para criar mais um. Escolher um nomeado guarda `role: 'custom'` mais
 * o id — o papel-base dele continua dizendo ao orquestrador o que ele é.
 */
function roleField(
  draft: AgentDraft,
  update: (patch: Partial<AgentDraft>, redraw?: boolean) => void,
): HTMLElement {
  const custom = state?.customRoles ?? [];
  const options: MenuOption[] = AGENT_ROLES.filter((role) => role !== 'custom').map((role) => ({
    value: role,
    label: s(AGENT_ROLE_LABELS[role]),
    description: s(AGENT_ROLE_DESCRIPTIONS[role]),
    icon: ROLE_ICONS[role],
  }));
  for (const role of custom) {
    options.push({
      value: `custom:${role.id}`,
      label: role.label,
      // O escopo entra na descrição porque é o que responde "por que este papel
      // aparece aqui e não na máquina do colega".
      description: `${role.description} · ${s(AGENT_ROLE_SCOPE_LABELS[role.scope])}`,
      icon: ROLE_ICONS[role.basedOn],
    });
  }
  options.push({
    value: 'custom:new',
    label: s('New role…'),
    description: s('Name a specialty of your own and reuse it in other agents.'),
    icon: 'sliders',
  });

  const selected = draft.role === 'custom' && draft.customRoleId !== ''
    ? `custom:${draft.customRoleId}`
    : draft.role;

  const wrapper = menuField(
    s('Role'),
    options,
    selected,
    (value) => {
      if (value === 'custom:new') {
        roleDraft = newRoleDraft();
        renderSettings();
        return;
      }
      if (value.startsWith('custom:')) {
        const id = value.slice('custom:'.length);
        // Trocar de papel troca as skills sugeridas junto: manter as do papel
        // anterior deixaria o agente com um kit que ninguém escolheu.
        update(
          { role: 'custom', customRoleId: id, skills: defaultSkillsFor('custom', id).join(', ') },
          true,
        );
        return;
      }
      const role = value as AgentRole;
      update({ role, customRoleId: '', skills: defaultSkillsFor(role, '').join(', ') }, true);
    },
    undefined,
    s(
      'The part this agent plays in a team run. The orchestrator delegates instead of implementing; the others receive a task and execute it. A named role of your own carries its own skills.',
    ),
  );

  const chosen = custom.find((role) => role.id === draft.customRoleId);
  if (chosen !== undefined) {
    wrapper.append(
      actionRow(
        actionButton(s('Edit role'), 'link', () => {
          roleDraft = roleDraftFrom(chosen);
          renderSettings();
        }),
        actionButton(s('Remove role'), 'link', () =>
          confirmDialog({
            title: s('Remove role'),
            body: [
              s('Agents using this role start warning that it is missing; none of them is repointed.'),
            ],
            confirmLabel: s('Remove'),
            danger: true,
            onConfirm: () => post({ type: 'agentRoles.remove', payload: { id: chosen.id } }),
          }),
        ),
      ),
    );
  }
  return wrapper;
}

/** Lê e grava o CSV de skills do rascunho dono do seletor. */
function readSkills(target: 'agent' | 'role'): string {
  return (target === 'agent' ? agentDraft?.skills : roleDraft?.skills) ?? '';
}

function writeSkills(target: 'agent' | 'role', skills: string): void {
  if (target === 'agent' && agentDraft !== null) {
    agentDraft = { ...agentDraft, skills };
  } else if (target === 'role' && roleDraft !== null) {
    roleDraft = { ...roleDraft, skills };
  }
  renderSettings();
}

/**
 * Campo de skills dos formulários: as escolhidas como chips — clicar tira — e
 * o seletor completo num diálogo. O CSV continua sendo o formato do rascunho;
 * quem edita a lista é o diálogo, não um input de texto.
 */
function skillsSummaryField(target: 'agent' | 'role', hint: string, help: string): HTMLElement {
  const chosen = splitList(readSkills(target));
  const catalog = state?.skills.skills ?? [];

  const box = document.createElement('div');
  box.className = 'skills-summary';
  for (const name of chosen) {
    const known = catalog.some((skill) => skill.name === name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `skill-chip is-on${known ? '' : ' is-missing'}`;
    chip.textContent = name;
    chip.title = known ? s('Click to remove.') : s('Not in the catalog');
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      writeSkills(target, chosen.filter((item) => item !== name).join(', '));
    });
    box.append(chip);
  }
  if (chosen.length === 0) {
    const none = document.createElement('span');
    none.className = 'skills-summary-empty';
    none.textContent = s('No skill enabled.');
    box.append(none);
  }
  const open = actionButton(s('Select skills…'), 'ghost', () => {
    skillsPickerTarget = target;
    skillsPickerFilter = '';
    renderSettings();
  });
  open.classList.add('skills-summary-open');
  box.append(open);

  // `div`, e não `label`: um label ativaria o primeiro botão embutido em
  // qualquer clique no texto — e o primeiro botão embutido remove uma skill.
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = s('Skills');
  const hintNote = document.createElement('span');
  hintNote.className = 'field-hint';
  hintNote.textContent = hint;
  wrapper.append(caption, box, hintNote);
  wrapper.title = help;
  return wrapper;
}

/**
 * Seletor de skills em duas colunas — ativadas de um lado, disponíveis do
 * outro; clicar move. As mudanças aplicam na hora; fechar nunca perde nada.
 */
function renderSkillsDialog(): void {
  document.getElementById('skills-dialog')?.remove();
  const target = skillsPickerTarget;
  if (target === null || !isSettingsOpen()) {
    return;
  }

  const chosen = splitList(readSkills(target));
  const catalog = state?.skills.skills ?? [];
  const filter = skillsPickerFilter.trim().toLowerCase();
  const matches = (name: string): boolean => filter === '' || name.toLowerCase().includes(filter);

  const overlay = document.createElement('div');
  overlay.id = 'skills-dialog';
  overlay.className = 'modal account-dialog skills-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', s('Skills'));
  overlay.addEventListener('mousedown', (event) => {
    // As escolhas aplicam na hora: fechar por fora não descarta nada.
    if (event.target === overlay) {
      closeSkillsPicker();
    }
  });

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card roles-card skills-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = s('Skills');
  header.append(title);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'roles-body';

  body.append(
    textInput({
      name: 'skills-filter',
      value: skillsPickerFilter,
      placeholder: s('Filter skills…'),
      onInput: (value) => {
        skillsPickerFilter = value;
        renderSettings();
      },
    }),
  );

  const columns = document.createElement('div');
  columns.className = 'skills-columns';
  columns.append(
    skillsColumn(s('Enabled'), chosen.filter(matches), catalog, true, (name) => {
      writeSkills(target, chosen.filter((item) => item !== name).join(', '));
    }),
    skillsColumn(
      s('Available'),
      catalog
        .map((skill) => skill.name)
        .filter((name) => !chosen.includes(name))
        .filter(matches),
      catalog,
      false,
      (name) => {
        writeSkills(target, [...chosen, name].join(', '));
      },
    ),
  );
  body.append(columns);
  body.append(dialogActions(actionButton(s('Done'), 'primary', closeSkillsPicker)));
  card.append(body);
  overlay.append(card);
  document.body.append(overlay);
}

/** Uma coluna do seletor: título com contagem e a pilha de skills clicáveis. */
function skillsColumn(
  label: string,
  names: readonly string[],
  catalog: PrometheonViewState['skills']['skills'],
  enabledSide: boolean,
  onPick: (name: string) => void,
): HTMLElement {
  const column = document.createElement('div');
  column.className = 'skills-column';

  const heading = document.createElement('span');
  heading.className = 'usage-title';
  heading.textContent = `${label} · ${names.length}`;
  column.append(heading);

  if (names.length === 0) {
    const none = document.createElement('span');
    none.className = 'skills-summary-empty';
    none.textContent = enabledSide ? s('No skill enabled.') : s('Nothing else available.');
    column.append(none);
    return column;
  }

  for (const name of names) {
    const skill = catalog.find((entry) => entry.name === name);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `skills-item${skill === undefined ? ' is-missing' : ''}${skill?.supported === false ? ' is-off' : ''}`;
    item.textContent = name;
    item.title =
      skill === undefined
        ? s('Not in the catalog')
        : skill.supported
          ? skill.description
          : sf('{0} — does not run on this platform.', skill.description);
    item.addEventListener('click', (event) => {
      event.preventDefault();
      onPick(name);
    });
    column.append(item);
  }
  return column;
}

function closeSkillsPicker(): void {
  skillsPickerTarget = null;
  skillsPickerFilter = '';
  renderSettings();
}

/**
 * Formulário de papel nomeado. Abre no lugar do de agente e volta para ele
 * quando termina — o rascunho do agente continua onde estava.
 */
function renderRoleForm(draft: RoleDraft): HTMLElement {
  const form = document.createElement('section');
  form.className = 'settings-form';
  form.append(
    sectionHeading(draft.id === null ? s('New role') : sf('Edit {0}', draft.label)),
  );

  const update = (patch: Partial<RoleDraft>, redraw = false): void => {
    // Mesmo cuidado do formulário de agente: o estado atual, não o snapshot.
    roleDraft = { ...(roleDraft ?? draft), ...patch };
    if (redraw) {
      renderSettings();
    }
  };

  const scopes = AGENT_ROLE_SCOPES.filter((scope) => {
    // Um escopo sem destino não é oferecido: escolher "projeto" sem pasta
    // aberta só produziria um erro depois do formulário preenchido.
    if (scope === 'project') {
      return state?.workspace.folderName !== null;
    }
    if (scope === 'hub') {
      return state?.hub.state === 'connected';
    }
    return true;
  });

  form.append(
    field(
      s('Name'),
      textInput({
        name: 'role-label',
        value: draft.label,
        placeholder: 'Gameplay PIE UE5 Test',
        maxLength: MAX_ROLE_LABEL_LENGTH,
        onInput: (value) => update({ label: value }),
      }),
      undefined,
      s('How this role appears in the Role list of every agent profile.'),
    ),
    field(
      s('Description'),
      textInput({
        name: 'role-description',
        value: draft.description,
        placeholder: 'Runs gameplay tests in PIE and reports what broke.',
        maxLength: MAX_ROLE_DESCRIPTION_LENGTH,
        onInput: (value) => update({ description: value }),
      }),
      undefined,
      s('One line saying what this role does. It is what the orchestrator reads when deciding whom to delegate to.'),
    ),
    menuField(
      s('Based on'),
      AGENT_ROLES.filter((role) => role !== 'custom').map((role) => ({
        value: role,
        label: s(AGENT_ROLE_LABELS[role]),
        description: s(AGENT_ROLE_DESCRIPTIONS[role]),
        icon: ROLE_ICONS[role],
      })),
      draft.basedOn,
      (value) => update({ basedOn: value as AgentRole }, true),
      undefined,
      s('Which built-in role this one behaves like when work is delegated. A test specialty is still a tester.'),
    ),
    menuField(
      s('Shared through'),
      scopes.map((scope) => ({
        value: scope,
        label: s(AGENT_ROLE_SCOPE_LABELS[scope]),
        description: s(AGENT_ROLE_SCOPE_DESCRIPTIONS[scope]),
        icon: ROLE_SCOPE_ICONS[scope],
      })),
      draft.scope,
      (value) => update({ scope: value as AgentRoleScope }, true),
      undefined,
      s('Where this role is stored, and therefore who else gets it. Team roles need a connected Hub; project roles travel with the repository.'),
    ),
    skillsSummaryField(
      'role',
      s('Skills every agent with this role starts with. Each agent can still add its own.'),
      s('Skills every agent with this role starts with. Each agent can still add its own.'),
    ),
    rolePromptField(draft, update),
    ...(draft.scope === 'hub' ? [] : [rolePromptFileRow(draft)]),
    actionRow(
      actionButton(draft.id === null ? s('Create role') : s('Save role'), 'primary', () =>
        submitRoleDraft(),
      ),
      actionButton(s('Cancel'), 'ghost', () => {
        roleDraft = null;
        renderSettings();
      }),
    ),
  );
  return form;
}

/**
 * Botão que leva ao prompt em arquivo (`agents/prompts/<id>.md`). O arquivo é
 * nomeado pelo id, então uma função nova precisa ser criada antes.
 */
/**
 * Esforço padrão do agente. "Escolha do CLI" é a primeira opção porque é o
 * padrão honesto: sem escolha nossa, quem decide é o provedor.
 */
function effortField(
  draft: AgentDraft,
  update: (patch: Partial<AgentDraft>, redraw?: boolean) => void,
): HTMLElement {
  const labels =
    state === null
      ? undefined
      : effortLabelsForAccount(state, draft.providerProfileId);
  if (labels === undefined) {
    // Provedor sem controle de raciocínio: nada a configurar aqui.
    return document.createDocumentFragment() as unknown as HTMLElement;
  }
  return menuField(
    s('Effort'),
    [
      {
        value: '',
        label: s('Chosen by the CLI'),
        description: s('No effort flag is sent; the provider decides.'),
        icon: 'sparkle',
      },
      ...effortOptions(labels),
    ],
    draft.effort,
    (value) => update({ effort: value }, true),
    undefined,
    s(
      'How much the agent thinks before acting. The composer can raise or lower it for one session without changing this default.',
    ),
  );
}

/** Rótulos de esforço do provedor por trás de uma conta. */
function effortLabelsForAccount(
  snapshot: PrometheonViewState,
  providerProfileId: string,
): Partial<Record<EffortLevel, string>> | undefined {
  const account = snapshot.accounts.find((item) => item.profileId === providerProfileId);
  return snapshot.agents.find((agent) => agent.displayName === account?.providerName)
    ?.effortLabels;
}

/** O prompt deste agente veio do arquivo? Lido do snapshot, sempre fresco. */
function agentPromptFromFile(draft: AgentDraft): boolean {
  return (
    draft.id !== null &&
    state?.agentProfiles.find((summary) => summary.profile.id === draft.id)?.profile
      .promptFile === true
  );
}

/**
 * Campo de prompt do agente. Com o arquivo existindo, o texto mostrado é o do
 * arquivo e o campo trava: editar aqui seria digitar num texto que o arquivo
 * sobrescreve — o caminho certo é o editor.
 */
function agentPromptField(
  draft: AgentDraft,
  update: (patch: Partial<AgentDraft>, redraw?: boolean) => void,
): HTMLElement {
  const fromFile = agentPromptFromFile(draft);
  const input = textArea({
    name: 'agent-prompt',
    value: draft.systemPrompt,
    placeholder: s('How this agent should behave.'),
    maxLength: MAX_SYSTEM_PROMPT_LENGTH,
    onInput: (value) => update({ systemPrompt: value }),
  });
  input.disabled = fromFile;
  return field(
    s('System prompt'),
    input,
    fromFile
      ? s('The prompt file is in charge — edit it in the editor.')
      : s('When the prompt file exists, it wins over this text.'),
    s(
      'Standing instructions added to every session of this agent. The project rules and the task itself come on top of them.',
    ),
  );
}

/**
 * Botão que leva ao prompt em arquivo do agente (`~/.prometheon/agent-prompts/
 * <id>.md`). Prompt grande merece editor de verdade — e, sendo arquivo, o
 * próprio agente pode manter o próprio manual.
 */
function agentPromptFileRow(draft: AgentDraft): HTMLElement {
  const fromFile = agentPromptFromFile(draft);
  const open = actionButton(
    fromFile ? s('Open prompt in the editor') : s('Create prompt file'),
    'link',
    () => {
      // Sem id não há nome para o arquivo. Avisar é melhor do que desabilitar:
      // um link que parece clicável e não responde é indistinguível de bug.
      if (draft.id === null) {
        showNotification(s('Create the agent first — the prompt file is named after it.'), 'warning');
        return;
      }
      post({ type: 'agentProfiles.openPrompt', payload: { id: draft.id } });
    },
  );
  return actionRow(open);
}

/** O prompt desta função veio do arquivo? Lido do snapshot, sempre fresco. */
function rolePromptFromFile(draft: RoleDraft): boolean {
  return (
    draft.id !== null &&
    state?.customRoles.find((role) => role.id === draft.id)?.promptFile === true
  );
}

/** Campo de prompt da função — trava quando o arquivo é quem manda. */
function rolePromptField(
  draft: RoleDraft,
  update: (patch: Partial<RoleDraft>, redraw?: boolean) => void,
): HTMLElement {
  const fromFile = draft.scope !== 'hub' && rolePromptFromFile(draft);
  const input = textArea({
    name: 'role-prompt',
    value: draft.systemPrompt,
    placeholder: s('How this agent should behave.'),
    maxLength: MAX_SYSTEM_PROMPT_LENGTH,
    onInput: (value) => update({ systemPrompt: value }),
  });
  input.disabled = fromFile;
  return field(
    s('System prompt'),
    input,
    draft.scope === 'hub'
      ? undefined
      : fromFile
        ? s('The prompt file is in charge — edit it in the editor.')
        : s('When the prompt file exists, it wins over this text.'),
    s('Added to the system prompt of every agent with this role, before the prompt of the agent itself.'),
  );
}

/**
 * Botão que leva ao prompt em arquivo (`agents/prompts/<id>.md`). O arquivo é
 * nomeado pelo id, então uma função nova precisa ser criada antes.
 */
function rolePromptFileRow(draft: RoleDraft): HTMLElement {
  const fromFile = rolePromptFromFile(draft);
  const open = actionButton(
    fromFile ? s('Open prompt in the editor') : s('Create prompt file'),
    'link',
    () => {
      if (draft.id === null) {
        showNotification(s('Create the role first — the prompt file is named after it.'), 'warning');
        return;
      }
      post({ type: 'agentRoles.openPrompt', payload: { id: draft.id } });
    },
  );
  return actionRow(open);
}

function submitRoleDraft(): void {
  const draft = roleDraft;
  if (draft === null) {
    return;
  }
  const label = draft.label.trim();
  const description = draft.description.trim();
  if (label === '') {
    showNotification(s('Give the role a name.'), 'warning');
    return;
  }
  if (description === '') {
    showNotification(s('Describe in one line what this role does.'), 'warning');
    return;
  }

  const systemPrompt = draft.systemPrompt.trim();
  const role: CustomRoleDraft = {
    label,
    description,
    basedOn: draft.basedOn,
    skills: splitList(draft.skills),
    ...(systemPrompt === '' ? {} : { systemPrompt }),
    scope: draft.scope,
  };

  post(
    draft.id === null
      ? { type: 'agentRoles.create', payload: { role } }
      : { type: 'agentRoles.update', payload: { id: draft.id, role } },
  );
  roleDraft = null;
  renderSettings();
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

  if (draft.role === 'custom' && draft.customRoleId === '') {
    showNotification(s('Pick the role this agent plays.'), 'warning');
    return;
  }

  const model = draft.model.trim();
  const systemPrompt = draft.systemPrompt.trim();
  const profile: AgentProfileDraft = {
    name,
    providerProfileId: draft.providerProfileId,
    role: draft.role,
    ...(draft.customRoleId === '' ? {} : { customRoleId: draft.customRoleId }),
    ...(model === '' ? {} : { model }),
    ...(systemPrompt === '' ? {} : { systemPrompt }),
    // Vazio é escolha: significa não mandar flag de esforço nenhuma ao CLI.
    ...(draft.effort === '' ? {} : { effort: draft.effort as EffortLevel }),
    autonomyMode: draft.autonomyMode,
    allowedTools: splitList(draft.allowedTools),
    deniedTools: splitList(draft.deniedTools),
    skills: splitList(draft.skills),
    maxConcurrentSessions: sessions,
    contextStrategy: draft.contextStrategy,
    enabled: draft.enabled,
    scope: draft.scope,
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
  const configured = workspace?.configured === true;

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('Workspace'),
      s(
        'The shared Prometheon workspace lives in .prometheon/ inside the open folder. Local Chat works without it.',
      ),
    ),
  );
  if (configured) {
    headingRow.append(
      actionButton(s('Workspace settings'), 'primary', () => {
        workspaceDialogOpen = true;
        renderSettings();
      }),
    );
  }
  const blocks: Node[] = [headingRow];

  // Sem workspace, a seção é o convite: o que ele dá, o estado da pasta, e a
  // inicialização como o único destaque — no mesmo desenho do vazio de agentes.
  if (!configured) {
    const hero = document.createElement('div');
    hero.className = 'settings-hero';

    const tile = document.createElement('span');
    tile.className = 'settings-hero-icon';
    const glyph = icon('folder');
    if (glyph !== null) {
      tile.append(glyph);
    }

    const title = document.createElement('h4');
    title.className = 'settings-hero-title';
    title.textContent = s('Set up the shared workspace');

    const text = document.createElement('p');
    text.className = 'settings-hero-body';
    text.textContent = s(
      'Skills, roles and the commit policy live in .prometheon/ and reach the whole team through Git.',
    );

    const chips = document.createElement('div');
    chips.className = 'settings-hero-chain';
    const folderChip = document.createElement('span');
    folderChip.className = 'settings-hero-chip';
    const folderGlyph = icon('folder');
    if (folderGlyph !== null) {
      folderChip.append(folderGlyph);
    }
    const folderLabel = document.createElement('span');
    folderLabel.textContent = workspace?.folderName ?? s('None open');
    folderChip.append(folderLabel);
    const gitChip = document.createElement('span');
    gitChip.className = `settings-hero-chip ${workspace?.hasGit === true ? 'is-ok' : 'is-warn'}`;
    const gitGlyph = icon('git');
    if (gitGlyph !== null) {
      gitChip.append(gitGlyph);
    }
    const gitLabel = document.createElement('span');
    gitLabel.textContent =
      workspace?.hasGit === true ? s('Git repository detected') : s('No Git repository');
    gitChip.append(gitLabel);
    chips.append(folderChip, gitChip);

    const actions = document.createElement('div');
    actions.className = 'settings-hero-actions';
    actions.append(
      actionButton(s('Initialize in current workspace'), 'primary', () =>
        post({ type: 'workspace.initialize', payload: { choice: 'current' } }),
      ),
      actionButton(s('Choose Prometheon workspace folder'), 'ghost', () =>
        post({ type: 'workspace.initialize', payload: { choice: 'external' } }),
      ),
    );
    const skip = actionButton(s('Continue without shared workspace'), 'link', () =>
      post({ type: 'workspace.initialize', payload: { choice: 'skip' } }),
    );

    hero.append(tile, title, text, chips, actions, skip);
    blocks.push(hero);
    return blocks;
  }

  // Configurado: o resumo do que está valendo e o vínculo com o Hub.
  const summaryCard = document.createElement('section');
  summaryCard.className = 'settings-form';
  const rows: [string, string][] = [
    [s('Folder'), workspace?.folderName ?? s('None open')],
    [s('Git repository'), workspace?.hasGit === true ? s('Detected') : s('Not detected')],
  ];
  if (workspace?.externalFolder !== null && workspace?.externalFolder !== undefined) {
    rows.push([s('External folder'), workspace.externalFolder]);
  }
  summaryCard.append(definitionList(rows));
  blocks.push(summaryCard, renderHubProjectCard());
  return blocks;
}

/**
 * Vínculo do workspace com um projeto do Hub: onde o Web Chat grava as
 * conversas e de onde a estratégia de contexto de equipe lê conhecimento.
 */
function renderHubProjectCard(): HTMLElement {
  const card = document.createElement('section');
  card.className = 'settings-form';

  const title = document.createElement('span');
  title.className = 'usage-title';
  title.textContent = s('Prometheon Hub project');
  card.append(title);

  const hub = state?.hub ?? { state: 'local-only' as const };
  if (hub.state !== 'connected') {
    card.append(
      emptyNote(s('Connect to the Hub to bind this workspace to a team project.')),
      actionRow(
        actionButton(s('Sign in to Prometheon Hub'), 'ghost', () =>
          post({ type: 'hub.connect.request' }),
        ),
      ),
    );
    return card;
  }

  const projects = state?.webProjects ?? [];
  if (projects.length === 0) {
    card.append(emptyNote(s('No project available for this account in the Hub.')));
    return card;
  }

  card.append(
    menuField(
      s('Project'),
      projects.map((project) => ({
        value: project.id,
        label: project.name,
        description: '',
        icon: 'cloud',
      })),
      state?.webProjectId ?? '',
      (value) => post({ type: 'chat.selectProject', payload: { projectId: value } }),
      s('Web Chat conversations live inside this project; team context is read from it.'),
    ),
  );
  return card;
}

/**
 * Configurações do workspace num diálogo: cada escolha grava na hora no
 * `prometheon.yaml` — o arquivo que o time inteiro compartilha — e vale já.
 */
function renderWorkspaceDialog(): void {
  document.getElementById('workspace-dialog')?.remove();
  if (!workspaceDialogOpen || !isSettingsOpen()) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'workspace-dialog';
  overlay.className = 'modal account-dialog workspace-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', s('Workspace settings'));
  overlay.addEventListener('mousedown', (event) => {
    // Tudo aqui grava na hora: fechar por fora não perde escolha nenhuma.
    if (event.target === overlay) {
      closeWorkspaceDialog();
    }
  });

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card roles-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const heading = document.createElement('h2');
  heading.textContent = s('Workspace settings');
  header.append(heading);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'roles-body';
  body.append(
    emptyNote(
      s('Changes apply as you pick them and are written to .prometheon/prometheon.yaml — the file the whole team shares.'),
    ),
    menuField(
      s('Default chat'),
      [
        { value: 'local', label: s('Local'), description: s('Conversations stay on this machine.'), icon: 'folder' },
        { value: 'web', label: s('Web'), description: s('Conversations live in the Hub project.'), icon: 'globe' },
      ],
      state?.chatType ?? 'local',
      (value) => post({ type: 'workspace.update', payload: { patch: { defaultType: value as ChatType } } }),
    ),
    menuField(
      s('Work mode'),
      WORK_MODES.map((mode) => ({
        value: mode,
        label: s(WORK_MODE_LABELS[mode]),
        description: s(WORK_MODE_DESCRIPTIONS[mode]),
        icon: mode,
      })),
      state?.workMode ?? 'plan',
      (value) => post({ type: 'workspace.update', payload: { patch: { workMode: value as WorkMode } } }),
    ),
    menuField(
      s('Autonomy'),
      (['manual', 'auto'] as const).map((level) => ({
        value: level,
        label: s(AUTONOMY_LABELS[level]),
        description: s(AUTONOMY_DESCRIPTIONS[level]),
        icon: level,
      })),
      state?.autonomy === 'auto' ? 'auto' : 'manual',
      (value) =>
        post({ type: 'workspace.update', payload: { patch: { autonomy: value as 'manual' | 'auto' } } }),
      undefined,
      s('Bypass is never a persisted default: it stays local, temporary and per session.'),
    ),
    menuField(
      s('Main agent'),
      state === null ? [] : [...mainAgentOptions(state)],
      state?.mainAgentId ?? '',
      (value) => post({ type: 'workspace.update', payload: { patch: { mainAgent: value } } }),
    ),
  );
  card.append(body, dialogActions(actionButton(s('Done'), 'primary', closeWorkspaceDialog)));
  overlay.append(card);
  document.body.append(overlay);
}

function closeWorkspaceDialog(): void {
  workspaceDialogOpen = false;
  renderSettings();
  dom.settingsPane.focus();
}

// ---------- Seção Graph ----------

/**
 * Campo de texto que só grava quando o usuário termina.
 *
 * `input` dispararia uma escrita no YAML a cada tecla, e o arquivo é
 * versionado: o histórico do Git ficaria com uma linha por caractere digitado.
 * Aqui a gravação acontece no blur ou no Enter, e só se o valor mudou.
 */
function commitInput(options: {
  readonly name: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly maxLength: number;
  readonly onCommit: (value: string) => void;
}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field-input';
  input.dataset['field'] = options.name;
  input.value = options.value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = options.maxLength;
  if (options.placeholder !== undefined) {
    input.placeholder = options.placeholder;
  }

  const commit = (): void => {
    const next = input.value.trim();
    if (next !== options.value) {
      options.onCommit(next);
    }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  });
  return input;
}

/**
 * As duas seções gravam no `prometheon.yaml`, que só existe depois da
 * inicialização. Sem ele os controles apareceriam funcionando e não gravariam
 * nada — o aviso vem antes de o usuário descobrir isso mexendo.
 */
function configRequiredNote(): readonly Node[] {
  if (state?.workspace.configured !== false) {
    return [];
  }
  return [
    warningNote(
      s('These settings are stored in .prometheon/prometheon.yaml, which does not exist yet.'),
    ),
    actionRow(
      actionButton(s('Initialize in current workspace'), 'primary', () =>
        post({ type: 'workspace.initialize', payload: { choice: 'current' } }),
      ),
    ),
  ];
}

const REBUILD_TRIGGER_OPTIONS: readonly {
  readonly value: GraphRebuildTrigger;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
}[] = [
  {
    value: 'commit',
    label: s('On commit (recommended)'),
    description: s(
      'A Git hook rebuilds the graph when the commit touches code, so graph and code land together.',
    ),
    icon: 'git',
  },
  {
    value: 'manual',
    label: s('Manual'),
    description: s('Nobody rebuilds it for you. Use the button below when you want to.'),
    icon: 'manual',
  },
  {
    value: 'run',
    label: s('After each run'),
    description: s(
      'Rebuilds when an agent finishes. Costs one rebuild per run, and the graph can be rebuilt mid-task.',
    ),
    icon: 'auto',
  },
];

/**
 * Idade por extenso, em unidade grossa.
 *
 * O histórico usa o formato curto (`2d`), que é certo numa lista densa. Aqui é
 * um painel de configuração onde a pergunta é "o grafo está velho?", e para
 * isso "2 days ago" responde sem exigir decodificação.
 */
function formatGraphAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return s('just now');
  }
  if (minutes < 60) {
    return sf('{0} min ago', minutes);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? s('1 hour ago') : sf('{0} hours ago', hours);
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? s('1 day ago') : sf('{0} days ago', days);
}

/**
 * Grafo de conhecimento do projeto.
 *
 * O comando de rebuild é um campo, e não um botão que "sabe" reconstruir: cada
 * projeto tem o seu, e o comando genérico errado pode reescrever o grafo com
 * um corpus diferente do curado — inclusive arrastando caminho de máquina para
 * dentro de um arquivo versionado.
 */
/** Chip de estado do grafo: verde-ciano quando pronto, âmbar quando falta. */
function graphStatusChip(iconName: string, label: string, ok: boolean): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `settings-hero-chip ${ok ? 'is-ok' : 'is-warn'}`;
  const glyph = icon(iconName);
  if (glyph !== null) {
    chip.append(glyph);
  }
  const text = document.createElement('span');
  text.textContent = label;
  chip.append(text);
  return chip;
}

function renderGraphSection(): readonly Node[] {
  const graph = state?.graph;

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('Graph'),
      s(
        'A knowledge graph of this project, generated from the code and committed with it. Agents query it instead of reading file by file.',
      ),
    ),
  );
  const blocks: Node[] = [headingRow];

  if (graph === undefined || !graph.available) {
    blocks.push(
      emptyNote(
        s(
          graph?.message ??
            'The project graph lives inside the open folder. Open a folder to configure it.',
        ),
      ),
      actionRow(actionButton(s('Go to Workspace'), 'ghost', () => selectSection('workspace'))),
    );
    return blocks;
  }

  // Sem comando não há o que reconstruir: o botão diz o porquê em vez de
  // deixar o clique terminar num erro.
  const rebuildNow = actionButton(s('Rebuild now'), 'ghost', () =>
    post({ type: 'graph.rebuild' }),
  );
  if (graph.rebuildCommand === '') {
    rebuildNow.disabled = true;
    rebuildNow.title = s('Set the rebuild command before choosing an automatic trigger.');
  }
  headingRow.append(rebuildNow);

  blocks.push(...configRequiredNote());

  // O estado em três selos, legível de relance: o grafo, a ferramenta, o hook.
  const status = document.createElement('div');
  status.className = 'settings-hero-chain graph-status';
  status.append(
    graphStatusChip(
      'graph',
      graph.exists && graph.ageMs !== null
        ? sf('Found in {0}/ · rebuilt {1}', graph.outputDir, formatGraphAge(graph.ageMs))
        : sf('Not found in {0}/', graph.outputDir),
      graph.exists,
    ),
    graphStatusChip(
      'beaker',
      graph.cliDetected ? s('Detected') : s('Not found on PATH'),
      graph.cliDetected,
    ),
    graphStatusChip(
      'git',
      state?.git.hooksInstalled === true ? s('Installed') : s('Not installed'),
      state?.git.hooksInstalled === true,
    ),
  );
  blocks.push(status);

  blocks.push(
    checkboxField(
      s('Let agents query the project graph'),
      graph.enabled,
      (enabled) => post({ type: 'graph.update', payload: { patch: { enabled } } }),
      s(
        'Every agent is told the graph exists, where it is, and which commands read it. Without this they fall back to reading files one by one.',
      ),
    ),
    field(
      s('Graph folder'),
      commitInput({
        name: 'graph-output-dir',
        value: graph.outputDir,
        placeholder: 'graphify-out',
        maxLength: 260,
        onCommit: (outputDir) =>
          post({ type: 'graph.update', payload: { patch: { outputDir } } }),
      }),
      s('Relative to the project root.'),
    ),
    field(
      s('Rebuild command'),
      commitInput({
        name: 'graph-rebuild-command',
        value: graph.rebuildCommand,
        placeholder: 'powershell -NoProfile -File Scripts/Rebuild-Graphify.ps1',
        maxLength: 1_000,
        onCommit: (rebuildCommand) =>
          post({ type: 'graph.update', payload: { patch: { rebuildCommand } } }),
      }),
      s(
        'Runs from the project root, in a shell. There is no default: the wrong command can rebuild the graph from a different corpus than the one your project curates.',
      ),
    ),
    // Sem comando, o Prometheon oferece o primeiro: gera o script versionado
    // em .prometheon/scripts/ e aponta o campo para ele.
    ...(graph.rebuildCommand === ''
      ? [
          actionRow(
            actionButton(s('Create rebuild script'), 'primary', () =>
              post({ type: 'graph.createScript' }),
            ),
          ),
        ]
      : []),
    menuField(
      s('When to rebuild'),
      REBUILD_TRIGGER_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        icon: option.icon,
      })),
      graph.rebuildOn,
      (value) => {
        const trigger = REBUILD_TRIGGER_OPTIONS.find((option) => option.value === value);
        if (trigger !== undefined && trigger.value !== graph.rebuildOn) {
          post({ type: 'graph.update', payload: { patch: { rebuildOn: trigger.value } } });
        }
      },
      undefined,
      s(
        'On commit is the safest: the commit is the only verifiable statement that the work is good, and it keeps one rebuild per commit instead of many per task.',
      ),
    ),
    field(
      s('Gate command'),
      commitInput({
        name: 'graph-gate',
        value: graph.gate,
        placeholder: s('optional — e.g. npm test'),
        maxLength: 1_000,
        onCommit: (gate) => post({ type: 'graph.update', payload: { patch: { gate } } }),
      }),
      s('The commit only proceeds when this command exits 0. Leave empty to skip the gate.'),
      s(
        'A command, never an agent saying it finished: the agent that wrote the code is the worst judge of whether it works.',
      ),
    ),
    checkboxField(
      s('Block the commit when the hygiene check fails'),
      graph.blockOnHygieneFailure,
      (blockOnHygieneFailure) =>
        post({ type: 'graph.update', payload: { patch: { blockOnHygieneFailure } } }),
      s(
        'If the rebuild reports a hygiene failure — a machine path or a sensitive file inside the graph — the commit stops. Tracking a leak down later costs far more than stopping now.',
      ),
    ),
  );

  if (graph.rebuildOn === 'commit' && state?.git.hooksInstalled !== true) {
    blocks.push(
      warningNote(
        s(
          'Rebuild on commit needs the Git hooks installed on this machine. They are not installed yet.',
        ),
      ),
      actionRow(actionButton(s('Install Git hooks'), 'primary', () => selectSection('git'))),
    );
  }

  if (graph.rebuildCommand === '') {
    blocks.push(warningNote(s('Set the rebuild command before choosing an automatic trigger.')));
  }

  // Um gatilho automático põe o rebuild no caminho de quem está trabalhando. Se
  // ele demora, o time desliga o hook e o grafo volta a envelhecer em silêncio —
  // pior do que nunca ter automatizado. Medir antes é mais barato.
  if (graph.rebuildOn !== 'manual' && graph.rebuildCommand !== '') {
    blocks.push(
      emptyNote(
        graph.rebuildOn === 'commit'
          ? s(
              'Every commit that touches code waits for this command to finish. Time it before rolling this out to the team — a rebuild of a couple of minutes gets the hook disabled.',
            )
          : s('Every run that changes code waits for this command to finish.'),
      ),
    );
  }

  return blocks;
}

// ---------- Seção Git & Commits ----------

const COMMIT_STYLE_OPTIONS: readonly {
  readonly value: CommitStyle;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: 'conventional',
    label: s('Conventional Commits'),
    description: s('type(scope): subject — for example, feat(extension): add the graph section.'),
  },
  {
    value: 'free',
    label: s('Free form'),
    description: s('No required format. The agent follows whatever the repository already does.'),
  },
];

const COMMIT_LANGUAGE_OPTIONS: readonly {
  readonly value: CommitLanguage;
  readonly label: string;
}[] = [
  { value: 'en', label: s('English') },
  { value: 'pt-br', label: s('Português (Brasil)') },
  { value: 'es', label: s('Español') },
];

/**
 * Política de commit do projeto.
 *
 * A seção separa o que é pedido do que é garantido: as preferências entram no
 * prompt do agente, mas quem faz a política valer é o hook — ele roda em todo
 * commit, inclusive nos feitos por uma ferramenta que nunca leu prompt nenhum.
 */
function renderGitSection(): readonly Node[] {
  const git = state?.git;

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('Git & Commits'),
      s(
        'Commit policy for this project. It is stored in .prometheon/prometheon.yaml, so whoever clones the repository gets the same rules.',
      ),
    ),
  );
  const blocks: Node[] = [headingRow];

  if (git === undefined || !git.available) {
    blocks.push(
      emptyNote(
        s(
          git?.message ??
            'Commit policy belongs to a project. Open a folder to configure it.',
        ),
      ),
      actionRow(actionButton(s('Go to Workspace'), 'ghost', () => selectSection('workspace'))),
    );
    return blocks;
  }

  // A ação da seção mora no topo: instalar (ou desligar) os hooks é o que
  // transforma a política escrita em política aplicada.
  headingRow.append(
    git.hooksInstalled
      ? actionButton(s('Disable hooks on this machine'), 'ghost', () =>
          post({ type: 'git.uninstallHooks' }),
        )
      : actionButton(s('Install Git hooks'), 'primary', () => post({ type: 'git.installHooks' })),
  );

  blocks.push(...configRequiredNote());

  blocks.push(
    checkboxField(
      s('Allow AI co-authorship in commits'),
      git.coAuthoredBy,
      (coAuthoredBy) => post({ type: 'git.update', payload: { patch: { coAuthoredBy } } }),
      s(
        'Off by default. With this off, the installed hook strips Co-Authored-By trailers and tool signatures from every commit message — asking the model not to add them only reduces the noise.',
      ),
    ),
    menuField(
      s('Commit message format'),
      COMMIT_STYLE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        icon: 'edit',
      })),
      git.commitStyle,
      (value) => {
        const style = COMMIT_STYLE_OPTIONS.find((option) => option.value === value);
        if (style !== undefined && style.value !== git.commitStyle) {
          post({ type: 'git.update', payload: { patch: { commitStyle: style.value } } });
        }
      },
    ),
    menuField(
      s('Commit message language'),
      COMMIT_LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: '',
        icon: 'globe',
      })),
      git.commitLanguage,
      (value) => {
        const language = COMMIT_LANGUAGE_OPTIONS.find((option) => option.value === value);
        if (language !== undefined && language.value !== git.commitLanguage) {
          post({ type: 'git.update', payload: { patch: { commitLanguage: language.value } } });
        }
      },
      s('Independent of the panel language.'),
    ),
  );

  if (git.commitStyle === 'conventional') {
    blocks.push(
      field(
        s('Accepted scopes'),
        commitInput({
          name: 'git-scopes',
          value: git.scopes.join(', '),
          placeholder: s('e.g. extension, hub, docs'),
          maxLength: 400,
          onCommit: (value) =>
            post({
              type: 'git.update',
              payload: {
                patch: {
                  scopes: value
                    .split(',')
                    .map((scope) => scope.trim())
                    .filter((scope) => scope !== ''),
                },
              },
            }),
        }),
        s('Comma separated. Leave empty to accept any scope.'),
      ),
    );
  }

  blocks.push(
    sectionHeading(
      s('Hooks'),
      s(
        'The files are versioned so the whole team gets them, but pointing Git at them is per machine — each person installs it once.',
      ),
    ),
  );

  // O estado dos hooks em selos, como no Grafo: instalado é verde; um Git
  // apontando para outro lugar é âmbar com o caminho à vista.
  const hookStatus = document.createElement('div');
  hookStatus.className = 'settings-hero-chain graph-status';
  hookStatus.append(
    graphStatusChip(
      'git',
      git.hooksInstalled ? s('Installed') : s('Not installed'),
      git.hooksInstalled,
    ),
  );
  const pathChip = document.createElement('span');
  pathChip.className = `settings-hero-chip${
    !git.hooksInstalled && git.hooksPath !== null ? ' is-warn' : ''
  }`;
  const pathLabel = document.createElement('span');
  pathLabel.className = 'graph-status-path';
  pathLabel.textContent = git.hooksPath ?? s('Not set (Git uses .git/hooks)');
  pathLabel.title = git.hooksPath ?? '';
  pathChip.append(pathLabel);
  hookStatus.append(pathChip);
  blocks.push(hookStatus);

  if (!git.hooksInstalled && git.hooksPath !== null) {
    blocks.push(
      warningNote(
        sf(
          'Git is currently using hooks from {0}. Installing points it at .githooks instead.',
          git.hooksPath,
        ),
      ),
    );
  }

  blocks.push(
    actionRow(actionButton(s('Configure the graph'), 'link', () => selectSection('graph'))),
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

  const headingRow = document.createElement('div');
  headingRow.className = 'settings-heading-row';
  headingRow.append(
    sectionHeading(
      s('MCP servers'),
      s(
        'Model Context Protocol servers of this project, read from .mcp.json — the same file Claude Code, Cursor and VS Code use.',
      ),
    ),
  );
  const blocks: Node[] = [headingRow];

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

  headingRow.append(
    // A sonda responde "dá para falar com ele?" — não roda servidor nenhum.
    ...(mcp.servers.length > 0
      ? [actionButton(s('Test servers'), 'ghost', () => post({ type: 'mcp.probe' }))]
      : []),
    // A leitura do arquivo escolhido acontece na extensão: a webview só pede.
    actionButton(s('Import from .mcp.json'), 'ghost', () => post({ type: 'mcp.import' })),
    actionButton(s('Add server'), 'primary', () => {
      mcpDraft = newMcpDraft();
      renderSettings();
      firstInputFor('mcp')?.focus();
    }),
  );

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
  return blocks;
}

function renderMcpServer(server: McpServerSummary): HTMLElement {
  // Colapsável como o resto do painel: fechado é uma linha — nome, alvo e
  // estado —, e a lista inteira de servidores cabe na tela.
  const card = document.createElement('details');
  card.className = `account mcp-server ${server.enabled ? 'enabled' : 'disabled'}`;
  card.open = expandedMcp.has(server.name);
  card.addEventListener('toggle', () => {
    if (card.open) {
      expandedMcp.add(server.name);
    } else {
      expandedMcp.delete(server.name);
    }
  });

  const header = document.createElement('summary');
  header.className = 'account-summary';

  const text = document.createElement('div');
  text.className = 'account-summary-text';
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = server.name;
  const target = server.transport === 'stdio' ? server.command : server.url;
  const subtitle = document.createElement('span');
  subtitle.className = 'account-subtitle';
  subtitle.textContent = [s(MCP_TRANSPORT_LABELS[server.transport]), target]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  text.append(name, subtitle);

  // A sonda fala primeiro quando existe: alcançável é o que importa saber.
  const probe = state?.mcp.probes?.[server.name];
  if (probe !== undefined) {
    const probeBadge = document.createElement('span');
    probeBadge.className = `account-state ${probe === 'ok' ? 'probe-ok' : 'probe-warn'}`;
    probeBadge.textContent =
      probe === 'ok' ? s('Reachable') : probe === 'missing' ? s('Command not found') : s('Unreachable');
    header.append(text, probeBadge);
  } else {
    header.append(text);
  }

  const status = document.createElement('span');
  status.className = 'account-state';
  status.textContent = server.enabled ? s('Enabled') : s('Disabled');
  header.append(status);
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
        confirmDialog({
          title: s('Remove MCP server'),
          body: [s('The entry is removed from .mcp.json. Other tools that read the same file lose it too.')],
          confirmLabel: s('Remove'),
          danger: true,
          onConfirm: () => post({ type: 'mcp.remove', payload: { name: server.name } }),
        }),
      ),
    ),
  );
  return card;
}

/** Criar e editar servidor MCP acontecem num diálogo, como agentes e funções. */
function renderMcpDialog(): void {
  document.getElementById('mcp-dialog')?.remove();
  const draft = mcpDraft;
  if (draft === null || !isSettingsOpen()) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'mcp-dialog';
  overlay.className = 'modal account-dialog mcp-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute(
    'aria-label',
    draft.original === null ? s('New MCP server') : sf('Edit {0}', draft.original),
  );

  const card = document.createElement('div');
  card.className = 'modal-card dialog-card roles-card agent-card';

  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.textContent = draft.original === null ? s('New MCP server') : sf('Edit {0}', draft.original);
  header.append(title);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'roles-body';
  body.append(renderMcpForm(draft));
  card.append(body);

  overlay.append(card);
  document.body.append(overlay);
}

function renderMcpForm(draft: McpDraft): HTMLElement {
  const form = document.createElement('section');
  form.className = 'settings-form';

  const update = (patch: Partial<McpDraft>, redraw = false): void => {
    // Mesmo cuidado do formulário de agente: o estado atual, não o snapshot.
    mcpDraft = { ...(mcpDraft ?? draft), ...patch };
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

/** Estado do ditado na renderização anterior, para detectar a transição. */
let wasListening = false;

function renderDictation(speech: PrometheonViewState['speech']): void {
  const listening = speech.state === 'listening';
  const transcribing = speech.state === 'transcribing';

  // O tom acompanha o estado real do motor, e não o clique. A diferença
  // aparece quando o microfone demora a abrir ou falha: tocar no clique
  // avisaria que gravou algo que não começou a gravar.
  if (listening !== wasListening) {
    playDictationTone(listening ? 'up' : 'down');
    wasListening = listening;
  }
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
  // Durante o ditado o texto tem lugar próprio no campo, e o final apenas
  // fecha o que as revisões vinham escrevendo. Inserir no cursor aqui
  // duplicaria a fala inteira.
  if (dictationAnchor !== null) {
    applyPartial(text);
    dictationAnchor = null;
    dom.input.focus();
    persistUi();
    return;
  }

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

/**
 * Trecho do campo que pertence ao ditado em curso.
 *
 * Guardado porque cada revisão **substitui** a anterior em vez de continuá-la:
 * o modelo reescreve o que já tinha ouvido quando o resto da frase esclarece o
 * sentido. Sem uma âncora fixa, cada revisão seria acrescentada e a mesma frase
 * apareceria repetida, crescendo a cada segundo.
 *
 * Fica `null` fora do ditado, e é o que faz o texto final saber se deve
 * substituir ou inserir no cursor.
 */
let dictationAnchor: { start: number; length: number } | null = null;

/**
 * Aviso sonoro de início e fim do ditado.
 *
 * Sintetizado, e não um arquivo: dois tons curtos são meia dúzia de linhas de
 * Web Audio, enquanto um `.wav` empacotado precisaria passar pela política de
 * conteúdo da webview e viraria mais um recurso a versionar.
 *
 * O som importa porque o gesto é sem retorno visual imediato: quem clica e
 * começa a falar não olha para o botão, e sem confirmação audível a primeira
 * frase é dita para um microfone que talvez nem tenha aberto. Subindo indica
 * que abriu, descendo que fechou — a direção é reconhecível sem aprender nada.
 */
function playDictationTone(direction: 'up' | 'down'): void {
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();

    const [from, to] = direction === 'up' ? [520, 780] : [780, 520];
    const now = audio.currentTime;

    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(to, now + 0.08);

    // Envelope curto com decaimento suave. Um tom que corta seco produz um
    // clique audível — o degrau na forma de onda vira ruído de banda larga.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.15);

    // Fecha o contexto depois do som: cada um consome um recurso de áudio do
    // navegador, e abrir um por ditado sem fechar esgota o limite numa sessão
    // longa.
    oscillator.onended = () => {
      void audio.close().catch(() => undefined);
    };
  } catch {
    // Sem saída de áudio, ou política do navegador barrando som sem gesto.
    // O ditado funciona igual; o aviso sonoro é um extra.
  }
}

function applyPartial(text: string): void {
  const input = dom.input;

  if (dictationAnchor === null) {
    // Primeira revisão: abre espaço a partir do cursor, respeitando o que a
    // pessoa já tinha escrito à mão.
    const start = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, start);
    const spacer = before === '' || before.endsWith(' ') || before.endsWith('\n') ? '' : ' ';

    input.value = `${before}${spacer}${input.value.slice(start)}`;
    dictationAnchor = { start: start + spacer.length, length: 0 };
  }

  const { start, length } = dictationAnchor;
  const before = input.value.slice(0, start);
  const after = input.value.slice(start + length);

  input.value = `${before}${text}${after}`;
  dictationAnchor.length = text.length;

  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
  autoGrow();
  updateSendState();
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

/** Sessão em renomeação na lista; só uma por vez. */
let renamingSessionId: string | null = null;

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

  // Em edição, a linha inteira vira o campo: renomear acontece onde o nome
  // está, sem diálogo e sem tirar a lista da frente.
  if (renamingSessionId === session.id) {
    item.className = 'session-row';
    item.append(renameSessionInput(session));
    return item;
  }

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

  // Renomear troca a linha pelo campo, no lugar em que o nome já está.
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'session-action';
  rename.title = s('Rename this conversation');
  rename.setAttribute('aria-label', sf('Rename {0}', session.title));
  rename.append(...nodes(icon('pencil')));
  rename.addEventListener('click', (event) => {
    event.stopPropagation();
    renamingSessionId = session.id;
    renderSessions();
  });

  // Excluir pede uma segunda intenção no próprio item: um diálogo do sistema
  // aqui tiraria o foco do popover e ele fecharia antes da resposta.
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'session-delete';
  remove.title = s('Delete this session');
  remove.setAttribute('aria-label', sf('Delete {0}', session.title));
  remove.append(...nodes(icon('trash')));

  let armed = false;
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!armed) {
      armed = true;
      remove.classList.add('armed');
      remove.textContent = s('Delete?');
      return;
    }
    post({ type: 'chat.deleteSession', payload: { conversationId: session.id } });
  });

  // As ações ficam num grupo posicionado sobre a hora: no hover ela some e
  // eles aparecem no mesmo lugar, sem a linha mudar de largura.
  const actions = document.createElement('span');
  actions.className = 'session-actions';
  // No Web Chat o título é do Hub: a lista oferece abrir e apagar, não renomear.
  actions.append(...(state?.chatType === 'web' ? [] : [rename]), remove);

  item.className = 'session-row';
  item.append(button, actions);
  return item;
}

/** Campo que substitui a linha durante a renomeação. Enter salva, Esc desiste. */
function renameSessionInput(session: ConversationSummary): HTMLInputElement {
  let draft = session.title;
  let done = false;

  const finish = (commit: boolean): void => {
    if (done) {
      return;
    }
    done = true;
    renamingSessionId = null;
    const title = draft.replace(/\s+/g, ' ').trim();
    if (commit && title !== '' && title !== session.title) {
      post({ type: 'chat.renameSession', payload: { conversationId: session.id, title } });
    }
    renderSessions();
  };

  const input = textInput({
    name: 'session-rename',
    value: session.title,
    maxLength: MAX_SESSION_TITLE,
    onInput: (value) => {
      draft = value;
    },
  });
  input.className = 'field-input session-rename-input';
  input.setAttribute('aria-label', s('Rename this conversation'));
  // O clique dentro do campo não pode chegar ao documento: lá ele fecharia o
  // popover inteiro e levaria a edição junto.
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  // O `focus` imediato não pega: o nó ainda não está no documento.
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
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
/**
 * Passo de edição, com o diff dobrado.
 *
 * Vermelho o que saiu, verde o que entrou — a convenção do git, que quem lê
 * código já sabe ler sem legenda. Fica fechado por padrão: uma conversa com
 * cinco edições abertas vira um arquivo inteiro rolando na tela.
 */
function editStep(
  step: AgentStep,
  dot: HTMLElement,
  tool: HTMLElement,
  target: HTMLElement,
  detail: HTMLElement,
): HTMLElement {
  const removed = step.edit?.removed ?? '';
  const added = step.edit?.added ?? '';

  const item = document.createElement('details');
  item.className = `step step-tool-item status-${step.status}`;

  const summary = document.createElement('summary');
  summary.className = 'step-row';
  const caret = document.createElement('span');
  caret.className = 'step-caret';
  caret.append(...nodes(icon('chevronRight')));
  summary.append(dot, tool, target, detail, caret);

  const counts = document.createElement('div');
  counts.className = 'step-output-caption';
  const out = removed === '' ? 0 : removed.split('\n').length;
  const inn = added === '' ? 0 : added.split('\n').length;
  counts.textContent = sf('{0} removed, {1} added', out, inn);

  const diff = document.createElement('pre');
  diff.className = 'step-diff';
  for (const [text, kind] of [
    [removed, 'del'],
    [added, 'ins'],
  ] as const) {
    if (text === '') {
      continue;
    }
    for (const line of text.split('\n')) {
      const row = document.createElement('span');
      row.className = `diff-line diff-${kind}`;
      // O sinal é conteúdo, não enfeite: copiar o bloco tem de sair como um
      // patch legível.
      row.textContent = `${kind === 'del' ? '-' : '+'} ${line}`;
      diff.append(row);
    }
  }

  item.append(summary, counts, diff);
  return item;
}

/**
 * Passo de comando: o comando num bloco, o resultado em outro logo abaixo.
 *
 * É a forma do Claude Code, e ela existe por um motivo prático: comando e
 * saída são duas coisas para ler, não uma linha resumida. Enquanto roda, o
 * bloco do comando já está na tela — quem acompanha vê o que está sendo
 * executado antes de existir resultado nenhum.
 */
function commandStep(
  step: AgentStep,
  dot: HTMLElement,
  tool: HTMLElement,
  detail: HTMLElement,
): HTMLElement {
  const item = document.createElement('div');
  item.className = `step step-command status-${step.status}`;

  const head = document.createElement('div');
  head.className = 'step-row';
  head.append(dot, tool, detail);

  const command = document.createElement('pre');
  command.className = 'step-command-line';
  command.textContent = step.command ?? '';

  item.append(head, command);

  const output = step.output ?? '';
  if (output === '') {
    // Sem saída ainda: o comando está rodando, ou terminou calado. Um bloco
    // vazio embaixo pareceria resultado, e não a falta dele.
    return item;
  }

  const lines = step.outputLines ?? 0;
  const caption = document.createElement('div');
  caption.className = 'step-output-caption';
  caption.textContent = lines > 0 ? sf('Output ({0} lines)', lines) : s('Output');

  const body = document.createElement('pre');
  body.className = 'step-output step-command-output';
  body.textContent = output;
  item.append(caption, body);

  if (step.truncated === true) {
    item.append(truncationNote(step));
  }
  return item;
}

/** O aviso de corte, com o botão que abre a cópia integral quando ela existe. */
function truncationNote(step: AgentStep): HTMLElement {
  const note = document.createElement('div');
  note.className = 'step-truncated';
  note.textContent = sf('Showing the first {0} KB.', Math.round(MAX_STEP_OUTPUT_CHARS / 1024));

  // O botão só aparece quando a cópia integral existe de fato. Oferecer uma
  // aba que abriria vazia seria pior do que não oferecer nada.
  if (step.fullOutput === true) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = s('Open full output');
    open.addEventListener('click', () =>
      post({
        type: 'chat.openStepOutput',
        payload: { stepId: step.id, label: `${step.tool}-${step.title}` },
      }),
    );
    note.append(' ', open);
  }
  return note;
}

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

  // A edição tem prioridade sobre a saída da ferramenta: "arquivo atualizado
  // com sucesso" não deixa ninguém revisar nada, e o que mudou é justamente o
  // que a pessoa quer ver sem sair da conversa.
  if (step.edit !== undefined) {
    return editStep(step, dot, tool, target, detail);
  }

  const hasOutput = step.output !== undefined && step.output !== '';
  const hasCommand = step.command !== undefined && step.command !== '';

  // Comando executado: o que foi rodado em cima, o que voltou embaixo. O
  // título corta na primeira linha porque precisa caber numa, e um
  // `cd "…/worktrees/…" && npm run x` truncado esconde justamente o que
  // interessa — ver o comando inteiro não pode depender de abrir o passo.
  if (hasCommand) {
    return commandStep(step, dot, tool, detail);
  }

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

  // Rótulo da saída antes do bloco, no espírito do "Bash tool output" do Claude
  // Code: dá o tamanho do que está dobrado ali antes de a pessoa expandir.
  const caption = document.createElement('div');
  caption.className = 'step-output-caption';
  const lines = step.outputLines ?? 0;
  caption.textContent =
    lines > 0
      ? sf('{0} tool output ({1} lines)', step.tool, lines)
      : sf('{0} tool output', step.tool);
  item.append(summary, caption);

  const output = document.createElement('pre');
  output.className = 'step-output';
  output.textContent = step.output ?? '';
  item.append(output);

  if (step.truncated === true) {
    item.append(truncationNote(step));
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
  if (consoleSessionId !== null && step.sessionId === consoleSessionId) {
    renderAgentConsole();
  }
  scrollToEnd();
}

// ---------- Console por agente ----------

/**
 * Sessão cujo console está aberto; `null` é a conversa normal.
 *
 * A visão de um agente mostra só o que ele fez — a fila de ferramentas, sem o
 * texto da resposta no meio. É a pergunta "o que este agente está fazendo
 * agora?", que a conversa responde mal porque intercala tudo numa timeline só.
 */
let consoleSessionId: string | null = null;
/** Os workers estão abertos um a um, ou dobrados numa linha só. */
let workersExpanded = false;

/**
 * Recado do Prometheon dobrado: a primeira linha fica à vista como resumo, o
 * resto abre no clique.
 */
function collapsedReport(content: string): HTMLElement {
  const at = content.indexOf('\n');
  const head = at === -1 ? content : content.slice(0, at);
  const rest = at === -1 ? '' : content.slice(at + 1).trim();

  const details = document.createElement('details');
  details.className = 'report';
  const summary = document.createElement('summary');
  summary.append(renderMarkdown(head));
  details.append(summary);

  if (rest !== '') {
    const inner = document.createElement('div');
    inner.className = 'report-body';
    inner.append(renderMarkdown(rest));
    details.append(inner);
  }
  return details;
}

/** Texto cru das mensagens que ainda estão chegando, por id. */
const streaming = new Map<string, string>();

/**
 * Escreve o conteúdo de uma mensagem: formatado quando está pronto, cru
 * enquanto chega.
 */
function setContent(node: HTMLElement, content: string, isStreaming: boolean): void {
  if (isStreaming) {
    node.textContent = content;
    return;
  }
  node.replaceChildren(renderMarkdown(content));
}

function openAgentConsole(sessionId: string | null): void {
  consoleSessionId = sessionId;
  renderAgentViews();
  renderAgentConsole();
  renderTalkTarget();
  applyConsoleVisibility();
  scrollToEnd();
}

function applyConsoleVisibility(): void {
  const open = consoleSessionId !== null;
  // O Web sem Hub já esconde a conversa por conta própria; o console não pode
  // trazê-la de volta ao fechar.
  const webBlocked = state?.chatType === 'web' && state.hub.state !== 'connected';
  dom.agentConsole.hidden = !open;
  dom.messages.hidden = open || webBlocked;
  if (open) {
    // O vazio da conversa não fala do console: some para não dizer "nenhuma
    // mensagem" bem em cima de uma lista de passos que está cheia.
    dom.emptyState.hidden = true;
  }
}

/** Agente aberto no console, mesmo depois que o run dele terminou. */
function consoleAgent(): ActiveAgentSummary | null {
  if (consoleSessionId === null) {
    return null;
  }
  return (
    state?.activeAgents.find((agent) => agent.sessionId === consoleSessionId) ?? {
      sessionId: consoleSessionId,
      agentId: '',
      displayName: s('Agent'),
      role: 'worker',
      status: 'completed',
      task: null,
    }
  );
}

/**
 * Abas de visão. Só existem com um console aberto: enquanto a conversa é a do
 * agente principal, uma aba solitária escrita "Main" seria ruído.
 */
function renderAgentViews(): void {
  const agent = consoleAgent();
  dom.agentViews.hidden = agent === null;
  if (agent === null) {
    dom.agentViews.replaceChildren();
    return;
  }

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'agent-view';
  main.textContent = s('Main');
  main.addEventListener('click', () => openAgentConsole(null));

  const current = document.createElement('button');
  current.type = 'button';
  current.className = 'agent-view active';
  current.textContent = agent.displayName;
  current.setAttribute('aria-current', 'true');

  dom.agentViews.replaceChildren(main, current);
}

/**
 * O worker para quem o composer está falando agora, se houver.
 *
 * Só existe com a aba de um worker aberta e a conversa dele viva. Sem os dois,
 * o composer volta ao seu destino de sempre: o agente principal.
 */
function talkTarget(): ActiveAgentSummary | null {
  const agent = consoleAgent();
  if (agent === null || agent.role === 'main' || agent.talkable !== true) {
    return null;
  }
  return agent;
}

/** Diz no composer com quem se está falando: o worker aberto, ou o principal. */
function renderTalkTarget(): void {
  const target = talkTarget();
  dom.input.placeholder =
    target === null
      ? s('Ask Prometheon…  (Enter to send · paste to attach an image)')
      : sf('Message {0}…  (Enter to send)', target.displayName);
  dom.composerCard.classList.toggle('talking-to-agent', target !== null);
  // Trocar o agente principal enquanto se fala com um worker mudaria quem
  // responde na outra aba, sem nada na tela ligando uma coisa à outra.
  menus.mainAgent.setDisabled(target !== null || state?.chatType === 'web');
  if (target !== null) {
    menus.mainAgent.setLabel(target.displayName);
  }
}

/** Passos de uma sessão, na ordem em que aconteceram. */
function stepsOfSession(sessionId: string): readonly AgentStep[] {
  // Worker traz os passos consigo: o trabalho dele nunca entrou na conversa do
  // orquestrador, e é justamente por isso que ele precisa de tela própria.
  const worker = state?.activeAgents.find((agent) => agent.sessionId === sessionId);
  if (worker?.steps !== undefined) {
    return worker.steps;
  }
  const steps: AgentStep[] = [];
  for (const message of state?.messages ?? []) {
    for (const step of message.steps ?? []) {
      if (step.sessionId === sessionId) {
        steps.push(step);
      }
    }
  }
  return steps.sort((left, right) => left.startedAt - right.startedAt);
}

function renderAgentConsole(): void {
  const agent = consoleAgent();
  if (agent === null) {
    dom.agentConsole.replaceChildren();
    return;
  }

  const header = document.createElement('div');
  header.className = 'agent-console-header';
  const title = document.createElement('span');
  title.className = 'agent-console-title';
  title.textContent = agent.displayName;
  const status = document.createElement('span');
  status.className = `agent-status agent-${agent.status}`;
  status.textContent = s(agent.status);
  header.append(title, status);

  if (agent.task !== null && agent.task !== '') {
    const task = document.createElement('span');
    task.className = 'agent-console-task';
    task.textContent = agent.task;
    header.append(task);
  }

  const steps = stepsOfSession(agent.sessionId);
  const list = document.createElement('div');
  list.className = 'steps';
  if (steps.length === 0 && (agent.messages ?? []).length === 0) {
    const empty = document.createElement('p');
    empty.className = 'settings-empty';
    empty.textContent = s('This agent has not run any tool yet.');
    list.append(empty);
  } else {
    // Passos e falas numa linha do tempo só, na ordem em que aconteceram: o
    // pedido feito no meio do trabalho só faz sentido lido entre o que veio
    // antes e o que veio depois dele.
    const timeline: { at: number; node: HTMLElement }[] = [
      ...steps.map((step) => ({ at: step.startedAt, node: renderStep(step) })),
      ...(agent.messages ?? []).map((message) => ({
        at: message.at,
        node: renderWorkerMessage(message),
      })),
    ];
    timeline.sort((left, right) => left.at - right.at);
    list.append(...timeline.map((item) => item.node));
  }

  const parts: HTMLElement[] = [header, list];

  // O que já foi escrito e ainda não teve vez. Sem isto a mensagem parece
  // perdida: o worker segue no turno anterior e nada na tela diz por quê.
  const queued = agent.queued ?? [];
  if (queued.length > 0) {
    const waiting = document.createElement('ul');
    waiting.className = 'queued agent-queued';
    waiting.append(
      ...queued.map((content) => {
        const item = document.createElement('li');
        item.className = 'queued-item';
        const text = document.createElement('span');
        text.className = 'queued-text';
        text.textContent = content;
        text.title = content;
        const note = document.createElement('span');
        note.className = 'queued-note';
        note.textContent = s('Waiting for the current turn to end');
        item.append(text, note);
        return item;
      }),
    );
    parts.push(waiting);
  }

  dom.agentConsole.replaceChildren(...parts);
}

/** Uma fala da conversa direta com o worker: a sua, ou a resposta dele. */
function renderWorkerMessage(message: WorkerMessage): HTMLElement {
  const item = document.createElement('article');
  item.className = `message message-${message.role === 'user' ? 'user' : 'agent'} worker-message`;

  const header = document.createElement('header');
  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = message.role === 'user' ? s('You') : (consoleAgent()?.displayName ?? '');
  const time = document.createElement('time');
  time.textContent = formatTime(message.at);
  header.append(author, time);

  const body = document.createElement('div');
  body.className = 'content';
  body.append(renderMarkdown(message.text));

  item.append(header, body);
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
    message.author === 'user' ? s('You') : (message.agentName ?? capitalize(message.author));
  header.append(author);

  if (message.author === 'agent' && message.agentId !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'agent-badge';
    badge.textContent = message.agentId;
    header.append(badge);
  }

  // O modelo fica ao lado do motor: a mesma resposta pode vir de um modelo
  // diferente amanhã, e saber com qual ela foi feita importa ao reler.
  if (message.agentModel !== undefined && message.agentModel !== '') {
    const model = document.createElement('span');
    model.className = 'agent-badge model-badge';
    model.textContent = modelWithoutWindow(message.agentModel);
    header.append(model);
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
  if (message.author === 'system') {
    // Relatório de worker vem inteiro, e inteiro ele é longo. Fechado, a
    // conversa continua legível e a linha de cima já diz quem terminou; quem
    // quiser ler o material abre.
    body.append(collapsedReport(message.content));
  } else {
    setContent(body, message.content, message.status === 'streaming');
  }
  // Enquanto não há uma palavra sequer, a mensagem inteira — cabeçalho e tudo
  // — fica fora da tela: um cartão com nome, modelo e hora sem resposta abaixo
  // é moldura vazia. Quem diz que o agente está trabalhando é a timeline de
  // passos e o indicador no fim da conversa.
  const empty = message.status === 'streaming' && message.content === '';
  item.hidden = empty && (message.steps ?? []).length === 0;

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

  // Um orquestrador que dispara cinco pesquisadores viraria cinco linhas
  // empurrando a conversa para fora da tela. Os workers entram numa linha só,
  // que abre quando se quer olhar de perto — o principal fica sempre à vista,
  // porque é ele que responde.
  const workers = agents.filter((agent) => agent.role === 'worker');
  const visible =
    workers.length > 1 && !workersExpanded
      ? agents.filter((agent) => agent.role !== 'worker')
      : agents;

  const rows = visible.map((agent) => {
      const item = document.createElement('li');
      item.className = `agent agent-${agent.status}`;
      if (agent.sessionId === consoleSessionId) {
        item.classList.add('agent-open');
      }

      // O nome é o botão: clicar abre o console daquele agente, e clicar de
      // novo volta para a conversa. O `Stop` continua sendo um alvo separado —
      // abrir e interromper não podem morar no mesmo clique.
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'agent-name';
      name.textContent = agent.displayName;
      name.title = s('Open this agent’s console');
      name.addEventListener('click', () =>
        openAgentConsole(consoleSessionId === agent.sessionId ? null : agent.sessionId),
      );

      // A função do agente no Prometheon vem primeiro — "Orquestrador" diz
      // mais sobre ele do que "principal", que é só o posto nesta execução.
      const role = document.createElement('span');
      role.className = `agent-role agent-role-${agent.role}`;
      role.textContent = agent.roleLabel ?? s(agent.role);

      const status = document.createElement('span');
      status.className = 'agent-status';
      status.textContent = s(agent.status);

      // Motor e modelo numa linha apagada: é o "por onde" da execução.
      const engine = document.createElement('span');
      engine.className = 'agent-engine';
      engine.textContent = [agent.engine, agent.model]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' · ');

      const task = document.createElement('span');
      task.className = 'agent-task';
      task.textContent = agent.task ?? '';
      task.title = agent.task ?? '';

      // Interromper só existe enquanto há execução: um botão desabilitado ao
      // lado de um agente ocioso é ruído com cara de ação disponível.
      const running =
        agent.status === 'starting' ||
        agent.status === 'working' ||
        agent.status === 'waiting' ||
        agent.status === 'blocked';

      item.append(name, role, status, engine, task);

      if (running) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'agent-stop';
        stop.textContent = s('Stop');
        stop.addEventListener('click', () =>
          post({ type: 'agents.stop', payload: { sessionId: agent.sessionId } }),
        );
        item.append(stop);
      }
      return item;
  });

  if (workers.length > 1) {
    rows.splice(rows.length, 0, workersBundle(workers));
  }

  dom.agentsList.replaceChildren(...rows);
}

/**
 * A linha que representa os workers em conjunto. Fechada, diz quantos são e
 * quantos ainda trabalham; aberta, some e dá lugar a cada um deles.
 */
function workersBundle(workers: readonly ActiveAgentSummary[]): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'agent agent-bundle';

  const busy = workers.filter(
    (agent) =>
      agent.status === 'starting' ||
      agent.status === 'working' ||
      agent.status === 'waiting' ||
      agent.status === 'blocked',
  ).length;

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'agent-name';
  name.textContent = workersExpanded
    ? s('Hide delegated agents')
    : sf('{0} delegated agents', workers.length);
  name.setAttribute('aria-expanded', String(workersExpanded));
  name.addEventListener('click', () => {
    workersExpanded = !workersExpanded;
    renderAgents(state?.activeAgents ?? []);
  });

  const status = document.createElement('span');
  status.className = 'agent-status';
  status.textContent = busy === 0 ? s('idle') : sf('{0} working', busy);

  // Os nomes ficam na linha de apoio: sem eles, "3 agentes" não diz quem.
  const engine = document.createElement('span');
  engine.className = 'agent-engine';
  engine.textContent = workers.map((agent) => agent.displayName).join(' · ');

  item.append(name, status, engine);
  return item;
}

/** Traz para a tela a mensagem que estava escondida esperando conteúdo. */
function revealMessage(body: HTMLElement): void {
  body.hidden = false;
  const message = body.closest('.message');
  if (message instanceof HTMLElement) {
    message.hidden = false;
  }
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
  const empty = dom.input.value.trim() === '' && drafts.length === 0;
  // O Web só bloqueia por falta de Hub ou de projeto — não por ser Web. O campo
  // já carrega essa decisão, e repeti-la aqui deixaria os dois fora de sincronia.
  dom.sendMessage.disabled = dom.input.disabled || (state?.busy ?? false) || empty;
}

function render(next: PrometheonViewState): void {
  state = next;
  const isWeb = next.chatType === 'web';

  for (const segment of dom.segments) {
    const active = segment.dataset['chatType'] === next.chatType;
    segment.classList.toggle('active', active);
    segment.setAttribute('aria-selected', String(active));
  }

  // Um redesenho no meio da digitação não pode roubar o que está sendo escrito.
  if (dom.sessionTitleInput.hidden) {
    dom.sessionTitleText.textContent = next.conversationTitle;
    dom.sessionTitle.title = next.conversationTitle;
  }
  // Conversa do Hub é renomeada no site; aqui o título é só leitura.
  dom.sessionTitle.disabled = next.chatType === 'web' || next.conversationId === null;
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

  // Conectado ao Hub, o Web Chat mostra a conversa como o Local: o painel deixa
  // de ser a tela de conexão e vira só a barra de escolha do projeto.
  const hubReady = next.hub.state === 'connected';
  dom.webPanel.hidden = !isWeb;
  dom.messages.hidden = isWeb && !hubReady;
  // Agentes ativos são do agente local; no Web quem executa é o Hub.
  dom.agentsSection.hidden = isWeb;
  renderWebProject(next, isWeb && hubReady);

  // O console é do agente local. Trocar para o Web o fecha, senão a barra de
  // visão apontaria para uma sessão que não existe deste lado.
  if (isWeb) {
    consoleSessionId = null;
  }

  if (isWeb && !hubReady) {
    updateEmptyState();
  } else {
    renderMessages(next.messages);
  }

  renderAgentViews();
  renderAgentConsole();
  applyConsoleVisibility();

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
  menus.mainAgent.update(mainAgentOptions(next), next.mainAgentId);

  // O seletor de esforço só existe para agente que tem esse controle — quem
  // decide é o adaptador, declarando (ou não) os rótulos dele.
  const effortLabels = effortLabelsFor(next);
  dom.effortAnchor.hidden = effortLabels === undefined;
  if (effortLabels !== undefined) {
    menus.effort.update(effortOptions(effortLabels), next.effort ?? 'medium');
  }

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
  renderQueued(next.queued);
  renderSettings();
  renderDictation(next.speech);
  renderContextIndicator();
  if (isCommandPanelOpen()) {
    renderCommandPanel();
  }
  // No Web só escreve quem tem Hub e projeto: sem um dos dois a mensagem não
  // teria onde ser gravada.
  const canWriteWeb = hubReady && next.webProjectId !== null;
  const blocked = isWeb && !canWriteWeb;
  dom.input.disabled = blocked;
  // Anexo do Web ainda passa pela API de arquivos do Hub, que não está ligada.
  dom.attachButton.disabled = isWeb || drafts.length >= MAX_ATTACHMENTS_PER_MESSAGE;
  // Modo, autonomia e agente principal são do agente local; no Web quem decide
  // isso é o Hub, e um seletor que não muda nada mentiria sobre o que faz.
  menus.workMode.setDisabled(isWeb);
  menus.autonomy.setDisabled(isWeb);
  // Depois do `update`, que repõe o rótulo do agente principal: com um worker
  // aberto, quem manda no pill é para quem a mensagem vai.
  renderTalkTarget();
  // Limpar apaga só a conversa local; no Web isso exigiria apagar no Hub.
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
    case 'step.completed': {
      upsertStep(payload.messageId, payload.step);
      // O primeiro passo já é conteúdo: a partir dele a mensagem tem o que
      // mostrar, mesmo antes da primeira letra da resposta.
      const node = contentNodes.get(payload.messageId);
      if (node !== undefined) {
        const message = node.closest('.message');
        if (message instanceof HTMLElement) {
          message.hidden = false;
        }
      }
      break;
    }

    case 'message.delta': {
      const node = contentNodes.get(payload.messageId);
      if (node !== undefined) {
        // Em streaming o texto continua cru: formatar a cada pedaço faria a
        // marcação piscar enquanto ela ainda está pela metade — um `**` que
        // ainda não fechou não é ênfase, é meia palavra.
        streaming.set(payload.messageId, `${streaming.get(payload.messageId) ?? ''}${payload.delta}`);
        node.textContent = streaming.get(payload.messageId) ?? '';
        // A primeira letra faz a mensagem aparecer: até aqui ela estava fora
        // da tela para não mostrar um cartão sem resposta.
        revealMessage(node);
        scrollToEnd();
      }
      break;
    }

    case 'message.completed': {
      const node = contentNodes.get(payload.messageId);
      if (node !== undefined) {
        streaming.delete(payload.messageId);
        setContent(node, payload.content, false);
        // Resposta vazia continua fora da tela: uma moldura em branco no fim
        // do run faria parecer que algo se perdeu.
        if (payload.content !== '') {
          revealMessage(node);
        }
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

/** Quanto tempo um aviso fica na tela antes de sair sozinho. */
const TOAST_LIFETIME_MS = 6_000;

/**
 * Aviso flutuante, acima de qualquer diálogo aberto.
 *
 * Antes, a mensagem era anexada ao feed do chat — invisível atrás dos modais,
 * que é exatamente onde nascem as validações que mais precisam ser vistas:
 * "dê um nome ao agente" atrás de dois overlays parecia botão quebrado.
 */
function showNotification(text: string, level: 'info' | 'warning' | 'error'): void {
  let stack = document.getElementById('toasts');
  if (stack === null) {
    stack = document.createElement('div');
    stack.id = 'toasts';
    stack.className = 'toasts';
    document.body.append(stack);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${level}`;
  toast.setAttribute('role', level === 'info' ? 'status' : 'alert');
  toast.textContent = text;
  toast.addEventListener('click', () => {
    toast.remove();
  });
  stack.append(toast);
  setTimeout(() => {
    toast.remove();
  }, TOAST_LIFETIME_MS);
}

function send(): void {
  const content = dom.input.value.trim();
  if (state === null || state.chatType === 'web') {
    return;
  }
  if (content === '' && drafts.length === 0) {
    return;
  }

  // Com a aba de um worker aberta, o que se escreve vai para ele. Mandar para
  // o orquestrador o que foi escrito olhando a tela de outro agente é o tipo de
  // engano que só aparece depois, quando a resposta não tem nada a ver.
  const target = talkTarget();
  if (target !== null) {
    if (content === '') {
      return;
    }
    if (drafts.length > 0) {
      showNotification(s('Images only go to the main conversation.'), 'warning');
    }
    if (isListening()) {
      stopDictation();
    }
    dictationAnchor = null;
    post({ type: 'chat.sendToAgent', payload: { sessionId: target.sessionId, content } });
    dom.input.value = '';
    autoGrow();
    persistUi();
    return;
  }

  // Enviar encerra o ditado. Sem isto o microfone segue aberto depois da
  // mensagem ir embora: o indicador do sistema fica aceso, a frase seguinte
  // — dita para outra pessoa, ou para ninguém — entra num campo já vazio, e
  // uma vaga de inferência continua ocupada por uma sessão que ninguém quer.
  if (isListening()) {
    stopDictation();
  }
  dictationAnchor = null;

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

/** Menu do `+`: o que dá para juntar à mensagem antes de enviá-la. */
new ActionMenu(dom.attachButton, dom.attachMenu, () => [
  {
    label: s('Upload from computer'),
    description: s('Attach images to the message.'),
    icon: 'upload',
    run: () => post({ type: 'chat.attachImages' }),
  },
  {
    label: s('Add context'),
    description: s('Mention a file from this project.'),
    icon: 'box',
    run: () => post({ type: 'context.addFile' }),
  },
]);

dom.commandButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleCommandPanel();
});
dom.commandPanel.addEventListener('click', (event) => event.stopPropagation());
dom.commandSearch.addEventListener('input', renderCommandPanel);

dom.contextButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (dom.contextPopover.hidden) {
    openContextPopover();
  } else {
    closeContextPopover();
  }
});
dom.contextPopover.addEventListener('click', (event) => event.stopPropagation());

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

// ---------- Renomear a conversa aberta ----------

/**
 * Abre a edição do título no lugar do rótulo. O input ocupa exatamente o mesmo
 * espaço, para o cabeçalho não pular quando a edição começa.
 */
function startTitleEdit(): void {
  const title = state?.conversationTitle ?? '';
  dom.sessionTitleInput.value = title;
  dom.sessionTitleInput.hidden = false;
  dom.sessionTitle.hidden = true;
  dom.sessionTitleInput.focus();
  dom.sessionTitleInput.select();
}

/** Fecha a edição. `commit` grava; cancelar devolve o título que já valia. */
function endTitleEdit(commit: boolean): void {
  if (dom.sessionTitleInput.hidden) {
    return;
  }
  const typed = dom.sessionTitleInput.value.replace(/\s+/g, ' ').trim();
  const current = state?.conversationTitle ?? '';
  const conversationId = state?.conversationId ?? null;

  dom.sessionTitleInput.hidden = true;
  dom.sessionTitle.hidden = false;

  if (!commit || conversationId === null || typed === '' || typed === current) {
    dom.sessionTitleText.textContent = current;
    return;
  }
  // Otimista: o rótulo já mostra o nome novo, e o snapshot confirma logo.
  dom.sessionTitleText.textContent = typed;
  dom.sessionTitle.title = typed;
  post({ type: 'chat.renameSession', payload: { conversationId, title: typed } });
}

dom.sessionTitle.addEventListener('click', startTitleEdit);

dom.sessionTitleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    endTitleEdit(true);
  } else if (event.key === 'Escape') {
    // Sem o stopPropagation, o Esc do documento fecharia popover ou modal
    // junto — cancelar a renomeação é uma coisa só.
    event.preventDefault();
    event.stopPropagation();
    endTitleEdit(false);
  }
});

// Clicar fora grava: é o gesto que a pessoa espera de um rótulo editável.
dom.sessionTitleInput.addEventListener('blur', () => endTitleEdit(true));

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
  closeAllActionMenus();
  closeCommandPanel();
  closeContextPopover();
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
  // Camadas de cima primeiro: diálogo imperativo, papéis, conta nova, e só
  // então a configuração — cada Esc desfaz exatamente um nível.
  if (closeUiDialog()) {
    return;
  }
  if (skillsPickerTarget !== null && isSettingsOpen()) {
    closeSkillsPicker();
    return;
  }
  if ((rolesDialogOpen || roleDraft !== null) && isSettingsOpen()) {
    if (roleDraft !== null) {
      // Primeiro o rascunho, depois o gerenciador: dois níveis, dois Esc.
      roleDraft = null;
      renderSettings();
    } else {
      closeRolesDialog();
    }
    return;
  }
  if (agentDraft !== null && isSettingsOpen()) {
    agentDraft = null;
    renderSettings();
    return;
  }
  if (mcpDraft !== null && isSettingsOpen()) {
    mcpDraft = null;
    renderSettings();
    return;
  }
  if (workspaceDialogOpen && isSettingsOpen()) {
    closeWorkspaceDialog();
    return;
  }
  if (accountFormOpen && isSettingsOpen()) {
    closeAccountDialog();
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
    case 'speech.partial':
      applyPartial(message.payload.text);
      break;
    case 'composer.insert':
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
