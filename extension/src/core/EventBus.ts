import * as vscode from 'vscode';
import type { AgentQuestionRequest } from '../agents/questions';
import type { ChatEvent, ImageAttachment } from '../chat/types';
import type { LanguageChoice } from '../i18n/language';
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
  /** Texto que o composer deve receber no ponto do cursor. */
  'composer.insert': { readonly text: string };
  'activity.changed': ActivityStatus;
  /** O idioma mudou; a webview precisa do HTML refeito. */
  'language.changed': LanguageChoice;
  /** Abre o modal de pergunta do agente. */
  'question.ask': AgentQuestionRequest;
  /** Fecha o modal, respondido ou não. */
  'question.close': string;
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
