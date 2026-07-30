/** Contratos do serviço de e-mail. */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Link principal da mensagem. O transporte de captura o imprime no log para
   * que o fluxo funcione sem servidor SMTP; o transporte SMTP o ignora.
   */
  readonly primaryLink?: string | undefined;
  /** Rótulo do template, usado no log e no nome do arquivo capturado. */
  readonly kind: MailKind;
}

export type MailKind =
  | 'email-verification'
  | 'password-reset'
  | 'organization-invitation'
  | 'registration-attempt';

export interface MailResult {
  readonly transport: MailTransportKind;
  /** Caminho do arquivo, quando o transporte é o de captura. */
  readonly capturedAt?: string | undefined;
  readonly messageId?: string | undefined;
}

export type MailTransportKind = 'smtp' | 'capture';

export interface MailTransport {
  readonly kind: MailTransportKind;
  send: (message: MailMessage, from: string) => Promise<MailResult>;
  /** Confere se o transporte responde. Usado por `/health/ready`. */
  verify: () => Promise<{ ok: boolean; detail: string | null }>;
  close: () => Promise<void>;
}

export interface MailService {
  readonly transport: MailTransportKind;
  send: (message: MailMessage) => Promise<MailResult>;
  verify: () => Promise<{ ok: boolean; detail: string | null }>;
  close: () => Promise<void>;
}
