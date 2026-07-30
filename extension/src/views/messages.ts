import type { ChatEvent } from '../chat/types';
import type { PrometheonViewState } from '../core/state';
import {
  AUTONOMY_LEVELS,
  CHAT_TYPES,
  WORK_MODES,
  type ActiveAgentSummary,
  type Autonomy,
  type ChatType,
  type HubConnectionStatus,
  type SerializedError,
  type UiNotification,
  type WorkMode,
} from '../core/types';

export type WorkspaceSetupChoice = 'current' | 'external' | 'skip';

export type WebviewToExtensionMessage =
  | { readonly type: 'ui.ready' }
  | { readonly type: 'chat.send'; readonly payload: { readonly content: string } }
  | { readonly type: 'chat.cancel'; readonly payload: { readonly runId: string } }
  | { readonly type: 'chat.newLocal' }
  | { readonly type: 'chat.clearLocal' }
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
  | { readonly type: 'notification'; readonly payload: UiNotification };

/** Limite defensivo: a webview não deve conseguir enviar payload gigante. */
export const MAX_MESSAGE_LENGTH = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
    case 'settings.open':
    case 'hub.connect.request':
      return { type: raw['type'] };

    case 'chat.send': {
      if (payload === undefined || typeof payload['content'] !== 'string') {
        return null;
      }
      const content = payload['content'].trim();
      if (content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
        return null;
      }
      return { type: 'chat.send', payload: { content } };
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
