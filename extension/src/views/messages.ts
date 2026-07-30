import { IMAGE_MIME_TYPES, type ChatEvent, type ImageAttachment } from '../chat/types';
import type { PrometheonViewState } from '../core/state';
import {
  AUTONOMY_LEVELS,
  CHAT_TYPES,
  WORK_MODES,
  type ActiveAgentSummary,
  type ActivityStatus,
  type Autonomy,
  type ChatType,
  type HubConnectionStatus,
  type SerializedError,
  type UiNotification,
  type WorkMode,
} from '../core/types';

export type WorkspaceSetupChoice = 'current' | 'external' | 'skip';

/** Anexo como a webview o envia: sem `id`, que é atribuído pela extensão. */
export type DraftAttachment = Omit<ImageAttachment, 'id'>;

export type WebviewToExtensionMessage =
  | { readonly type: 'ui.ready' }
  | {
      readonly type: 'chat.send';
      readonly payload: {
        readonly content: string;
        readonly attachments: readonly DraftAttachment[];
      };
    }
  | { readonly type: 'chat.cancel'; readonly payload: { readonly runId: string } }
  | { readonly type: 'chat.newLocal' }
  | { readonly type: 'chat.clearLocal' }
  | { readonly type: 'chat.openSession'; readonly payload: { readonly conversationId: string } }
  | { readonly type: 'chat.attachImages' }
  | { readonly type: 'speech.start' }
  | { readonly type: 'speech.stop' }
  | { readonly type: 'speech.cancel' }
  | { readonly type: 'accounts.refresh' }
  | { readonly type: 'accounts.add' }
  | { readonly type: 'accounts.login'; readonly payload: { readonly profileId: string } }
  | { readonly type: 'accounts.logout'; readonly payload: { readonly profileId: string } }
  | { readonly type: 'accounts.remove'; readonly payload: { readonly profileId: string } }
  | { readonly type: 'chat.selectType'; readonly payload: { readonly chatType: ChatType } }
  | { readonly type: 'settings.setWorkMode'; readonly payload: { readonly mode: WorkMode } }
  | { readonly type: 'settings.setAutonomy'; readonly payload: { readonly autonomy: Autonomy } }
  | { readonly type: 'settings.selectMainAgent'; readonly payload: { readonly agentId: string } }
  | { readonly type: 'settings.open' }
  | {
      readonly type: 'workspace.initialize';
      readonly payload: { readonly choice: WorkspaceSetupChoice };
    }
  | { readonly type: 'agents.stop'; readonly payload: { readonly sessionId: string } }
  | { readonly type: 'hub.connect.request' };

export type ExtensionToWebviewMessage =
  | { readonly type: 'state.snapshot'; readonly payload: PrometheonViewState }
  | { readonly type: 'chat.event'; readonly payload: ChatEvent }
  | { readonly type: 'chat.error'; readonly payload: SerializedError }
  | { readonly type: 'agents.updated'; readonly payload: readonly ActiveAgentSummary[] }
  | { readonly type: 'hub.status'; readonly payload: HubConnectionStatus }
  | {
      readonly type: 'attachments.added';
      readonly payload: { readonly attachments: readonly ImageAttachment[] };
    }
  /** Texto ditado, para o cliente inserir no rascunho onde está o cursor. */
  | { readonly type: 'speech.transcript'; readonly payload: { readonly text: string } }
  | { readonly type: 'activity'; readonly payload: ActivityStatus }
  | { readonly type: 'accounts.open' }
  | { readonly type: 'notification'; readonly payload: UiNotification };

/** Limite defensivo: a webview não deve conseguir enviar payload gigante. */
export const MAX_MESSAGE_LENGTH = 32_000;

/** Limites dos anexos. Imagens ficam em base64 no estado local do workspace. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_LENGTH = 120;
export const MAX_IMAGE_DIMENSION = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Tamanho real dos bytes decodificados; o valor informado pela webview é ignorado. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * Valida um anexo vindo da webview. Nada é normalizado em silêncio: mime fora da
 * lista, base64 malformado ou tamanho acima do limite derrubam a mensagem
 * inteira, como no resto desta fronteira.
 */
function parseAttachment(raw: unknown): DraftAttachment | null {
  if (!isRecord(raw)) {
    return null;
  }
  const mimeType = oneOf(raw['mimeType'], IMAGE_MIME_TYPES);
  const data = raw['data'];
  if (mimeType === null || typeof data !== 'string') {
    return null;
  }
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
    return null;
  }
  const byteSize = base64ByteLength(data);
  if (byteSize > MAX_ATTACHMENT_BYTES) {
    return null;
  }
  const name = nonEmptyString(raw['name'], MAX_ATTACHMENT_NAME_LENGTH);
  if (name === null) {
    return null;
  }
  const width = pixelCount(raw['width']);
  const height = pixelCount(raw['height']);
  if (width === null || height === null) {
    return null;
  }
  return {
    name: fileName(name),
    mimeType,
    data,
    byteSize,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/** Dimensão opcional: inteiro positivo dentro de um limite plausível. */
function pixelCount(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_IMAGE_DIMENSION
    ? value
    : null;
}

function parseAttachments(raw: unknown): readonly DraftAttachment[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return null;
  }
  const parsed: DraftAttachment[] = [];
  for (const item of raw) {
    const attachment = parseAttachment(item);
    if (attachment === null) {
      return null;
    }
    parsed.push(attachment);
  }
  return parsed;
}

/** Caracteres de controle não têm uso em um nome mostrado na interface. */
function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 32 || code === 127;
}

/** Só o nome do arquivo: caminho vindo da webview nunca é usado como caminho. */
function fileName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const cleaned = [...base].filter((char) => !isControl(char)).join('').trim();
  return cleaned === '' ? 'image' : cleaned;
}

function nonEmptyString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > maxLength ? null : trimmed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

const SETUP_CHOICES: readonly WorkspaceSetupChoice[] = ['current', 'external', 'skip'];

/**
 * Valida em runtime tudo o que vem da webview. TypeScript não protege esta
 * fronteira: a mensagem chega como `unknown` e qualquer campo inesperado deve
 * derrubar a mensagem inteira, não ser normalizado silenciosamente.
 */
export function parseWebviewMessage(raw: unknown): WebviewToExtensionMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    return null;
  }
  const payload = isRecord(raw['payload']) ? raw['payload'] : undefined;

  switch (raw['type']) {
    case 'ui.ready':
    case 'chat.newLocal':
    case 'chat.clearLocal':
    case 'chat.attachImages':
    case 'speech.start':
    case 'speech.stop':
    case 'speech.cancel':
    case 'accounts.refresh':
    case 'accounts.add':
    case 'settings.open':
    case 'hub.connect.request':
      return { type: raw['type'] };

    case 'chat.send': {
      if (payload === undefined || typeof payload['content'] !== 'string') {
        return null;
      }
      const content = payload['content'].trim();
      if (content.length > MAX_MESSAGE_LENGTH) {
        return null;
      }
      const attachments = parseAttachments(payload['attachments']);
      if (attachments === null) {
        return null;
      }
      // Uma mensagem só de imagens é válida; uma mensagem sem nada, não.
      if (content.length === 0 && attachments.length === 0) {
        return null;
      }
      return { type: 'chat.send', payload: { content, attachments } };
    }

    case 'accounts.login':
    case 'accounts.logout':
    case 'accounts.remove': {
      const profileId = payload === undefined ? null : nonEmptyString(payload['profileId'], 128);
      return profileId === null ? null : { type: raw['type'], payload: { profileId } };
    }

    case 'chat.openSession': {
      const conversationId = payload === undefined ? null : nonEmptyString(payload['conversationId'], 128);
      return conversationId === null
        ? null
        : { type: 'chat.openSession', payload: { conversationId } };
    }

    case 'chat.cancel': {
      const runId = payload === undefined ? null : nonEmptyString(payload['runId']);
      return runId === null ? null : { type: 'chat.cancel', payload: { runId } };
    }

    case 'chat.selectType': {
      const chatType = payload === undefined ? null : oneOf(payload['chatType'], CHAT_TYPES);
      return chatType === null ? null : { type: 'chat.selectType', payload: { chatType } };
    }

    case 'settings.setWorkMode': {
      const mode = payload === undefined ? null : oneOf(payload['mode'], WORK_MODES);
      return mode === null ? null : { type: 'settings.setWorkMode', payload: { mode } };
    }

    case 'settings.setAutonomy': {
      const autonomy = payload === undefined ? null : oneOf(payload['autonomy'], AUTONOMY_LEVELS);
      return autonomy === null ? null : { type: 'settings.setAutonomy', payload: { autonomy } };
    }

    case 'settings.selectMainAgent': {
      const agentId = payload === undefined ? null : nonEmptyString(payload['agentId'], 128);
      return agentId === null ? null : { type: 'settings.selectMainAgent', payload: { agentId } };
    }

    case 'workspace.initialize': {
      const choice = payload === undefined ? null : oneOf(payload['choice'], SETUP_CHOICES);
      return choice === null ? null : { type: 'workspace.initialize', payload: { choice } };
    }

    case 'agents.stop': {
      const sessionId = payload === undefined ? null : nonEmptyString(payload['sessionId'], 128);
      return sessionId === null ? null : { type: 'agents.stop', payload: { sessionId } };
    }

    default:
      return null;
  }
}
