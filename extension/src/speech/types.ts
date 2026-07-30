/**
 * Contrato de ditado. A captura de áudio nunca acontece na webview — o iframe
 * dela não tem acesso ao microfone —, então quem grava e transcreve é sempre um
 * provedor do lado da extensão.
 */

export type SpeechState = 'idle' | 'listening' | 'transcribing';

export interface SpeechProvider {
  readonly id: string;
  readonly displayName: string;

  /** Motor pronto para uso: binários presentes, permissões concedidas, etc. */
  isAvailable(): Promise<boolean>;
  /** Começa a gravar. Rejeita se o motor não estiver disponível. */
  start(): Promise<void>;
  /** Encerra a gravação e devolve o texto transcrito, ou `null` se não houver. */
  stop(): Promise<string | null>;
  /** Descarta a gravação em andamento sem transcrever. */
  cancel(): Promise<void>;
}
