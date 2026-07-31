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

  /**
   * Texto provisório, revisado enquanto a pessoa fala.
   *
   * Opcional porque nem todo motor consegue: um que só transcreve arquivo
   * fechado entrega o texto uma vez, no `stop`. Onde existe, a diferença para
   * quem usa é grande — o campo vai sendo preenchido durante a fala em vez de
   * ficar vazio até o fim.
   *
   * Cada revisão **substitui** a anterior por inteiro, e não a continua: o
   * modelo reconsidera o que já ouviu à luz do que veio depois, e "ele" vira
   * "eles" quando o plural chega três palavras adiante. Tratar as revisões como
   * acréscimo congelaria cada engano no lugar.
   */
  onPartial?(listener: (text: string) => void): { dispose(): void };

  /**
   * Por que o motor não está disponível, quando não está.
   *
   * Existe porque "nenhum motor configurado" não ajuda ninguém a resolver nada:
   * o motivo real é sempre concreto — falta Python na máquina, a preparação do
   * ambiente falhou, o processo não subiu — e é isso que precisa chegar à tela.
   * Devolve `undefined` quando o motor está bem.
   */
  unavailableReason?(): string | undefined;
}
