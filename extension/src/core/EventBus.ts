import * as vscode from 'vscode';
import type { ChatEvent, ImageAttachment } from '../chat/types';
import type { PrometheonViewState } from './state';
import type {
  ActiveAgentSummary,
  ActivityStatus,
  HubConnectionStatus,
  SerializedError,
  UiNotification,
} from './types';

/** Contrato dos eventos internos. A webview só recebe o que o provider repassa. */
export interface PrometheonEventMap {
  'state.changed': PrometheonViewState;
  'chat.event': ChatEvent;
  'chat.error': SerializedError;
  'agents.updated': readonly ActiveAgentSummary[];
  'hub.status': HubConnectionStatus;
  'attachments.added': readonly ImageAttachment[];
  'speech.transcript': string;
  'activity.changed': ActivityStatus;
  notification: UiNotification;
}

type Listener<K extends keyof PrometheonEventMap> = (payload: PrometheonEventMap[K]) => void;

/**
 * Barramento de eventos tipado sobre vscode.EventEmitter. Existe para que os
 * serviços de domínio não precisem conhecer a webview nem uns aos outros.
 */
export class EventBus implements vscode.Disposable {
  private readonly emitters = new Map<keyof PrometheonEventMap, vscode.EventEmitter<never>>();

  on<K extends keyof PrometheonEventMap>(event: K, listener: Listener<K>): vscode.Disposable {
    return this.emitterFor(event).event(listener as (payload: never) => void);
  }

  emit<K extends keyof PrometheonEventMap>(event: K, payload: PrometheonEventMap[K]): void {
    this.emitterFor(event).fire(payload as never);
  }

  private emitterFor(event: keyof PrometheonEventMap): vscode.EventEmitter<never> {
    let emitter = this.emitters.get(event);
    if (emitter === undefined) {
      emitter = new vscode.EventEmitter<never>();
      this.emitters.set(event, emitter);
    }
    return emitter;
  }

  dispose(): void {
    for (const emitter of this.emitters.values()) {
      emitter.dispose();
    }
    this.emitters.clear();
  }
}
