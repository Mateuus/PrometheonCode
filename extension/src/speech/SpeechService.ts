import type { Logger } from '../logger';
import { SpeechNotConfiguredError } from '../utils/errors';
import type { SpeechProvider, SpeechState } from './types';

/**
 * Orquestra o ditado. Existe mesmo sem motor: a interface precisa de um estado
 * coerente para mostrar o botão desabilitado com a razão certa, em vez de
 * falhar quando o usuário aperta o atalho.
 *
 * Nenhum provedor é registrado por padrão. As opções avaliadas foram: um módulo
 * nativo de captura por plataforma (caro, exige build no CI), um comando externo
 * configurável (ffmpeg + whisper local) e o Prometheon Hub. A escolha ficou para
 * depois — daí este serviço nascer plugável, e não amarrado a um deles.
 *
 * O que não é opção: a API `speech` do VS Code. A extensão `ms-vscode.vscode-speech`
 * apenas **registra** um provider (`contributes.speechProviders`) para o workbench
 * consumir; ela não expõe API pública, e a proposta `speech` não tem lado de
 * consumo para extensões de terceiros.
 */
export class SpeechService {
  private provider: SpeechProvider | null = null;
  private currentState: SpeechState = 'idle';
  private partialSubscription: { dispose(): void } | null = null;
  private partialListener: ((text: string) => void) | null = null;

  constructor(private readonly logger: Logger) {}

  /** Registra o motor de voz. Trocar de provedor cancela o que estiver ativo. */
  async register(provider: SpeechProvider | null): Promise<void> {
    if (this.currentState !== 'idle') {
      await this.cancel();
    }
    this.partialSubscription?.dispose();
    this.partialSubscription = null;
    this.provider = provider;
    this.subscribeToPartials();
    this.logger.info(
      provider === null ? 'Ditado sem motor registrado.' : `Motor de ditado: ${provider.id}.`,
    );
  }

  /**
   * Escuta o texto provisório, revisado enquanto a pessoa fala.
   *
   * Só chega alguma coisa quando o motor registrado sabe produzi-lo — o
   * `onPartial` é opcional no contrato. Com um motor que só transcreve no fim,
   * este ouvinte simplesmente nunca é chamado, e a interface se vira com o
   * texto que vem do `stop`.
   */
  onPartial(listener: (text: string) => void): void {
    this.partialListener = listener;
    this.subscribeToPartials();
  }

  private subscribeToPartials(): void {
    if (this.partialSubscription !== null || this.provider === null) {
      return;
    }

    const listener = this.partialListener;
    if (listener === null || this.provider.onPartial === undefined) {
      return;
    }

    this.partialSubscription = this.provider.onPartial(listener);
  }

  get state(): SpeechState {
    return this.currentState;
  }

  /**
   * Motivo concreto de o ditado não estar disponível.
   *
   * A interface mostrava sempre "nenhum motor configurado", que descreve o
   * estado e esconde a causa. Com um motor registrado que apenas não consegue
   * subir, essa frase manda a pessoa procurar uma configuração que já existe.
   */
  unavailableReason(): string | undefined {
    return this.provider?.unavailableReason?.();
  }

  async isAvailable(): Promise<boolean> {
    if (this.provider === null) {
      return false;
    }
    try {
      return await this.provider.isAvailable();
    } catch (error) {
      this.logger.warn(`Motor de ditado indisponível: ${String(error)}`);
      return false;
    }
  }

  async start(): Promise<void> {
    const provider = this.require();
    if (this.currentState !== 'idle') {
      return;
    }
    if (!(await provider.isAvailable())) {
      throw new SpeechNotConfiguredError(
        `${provider.displayName} is not ready. Check its configuration and try again.`,
      );
    }
    await provider.start();
    this.currentState = 'listening';
  }

  /** Encerra e transcreve. Devolve `null` quando não havia nada gravado. */
  async stop(): Promise<string | null> {
    const provider = this.require();
    if (this.currentState !== 'listening') {
      return null;
    }
    this.currentState = 'transcribing';
    try {
      const transcript = await provider.stop();
      return transcript === null || transcript.trim() === '' ? null : transcript.trim();
    } finally {
      this.currentState = 'idle';
    }
  }

  async cancel(): Promise<void> {
    if (this.provider === null || this.currentState === 'idle') {
      this.currentState = 'idle';
      return;
    }
    try {
      await this.provider.cancel();
    } catch (error) {
      this.logger.warn(`Falha ao cancelar o ditado: ${String(error)}`);
    } finally {
      this.currentState = 'idle';
    }
  }

  private require(): SpeechProvider {
    if (this.provider === null) {
      throw new SpeechNotConfiguredError();
    }
    return this.provider;
  }
}
