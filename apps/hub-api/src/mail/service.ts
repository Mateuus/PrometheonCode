/**
 * Serviço de e-mail.
 *
 * Fica entre os módulos e o transporte: quem chama sabe montar a mensagem, não
 * sabe (nem precisa saber) se ela vai por SMTP ou para um arquivo.
 */

import { child } from '@prometheon/logger';

import { defaultCaptureDirectory, resolveTransport } from './transport.js';
import type { MailMessage, MailResult, MailService, MailTransport } from './types.js';
import type { AppConfig } from '../config/index.js';

export interface CreateMailServiceOptions {
  readonly config: AppConfig;
  readonly mode: 'auto' | 'smtp' | 'capture';
  readonly captureDirectory?: string | undefined;
}

export async function createMailService(
  options: CreateMailServiceOptions,
): Promise<MailService> {
  const logger = child('mail');
  const directory = options.captureDirectory ?? defaultCaptureDirectory();
  const transport: MailTransport = await resolveTransport(
    options.config,
    options.mode,
    directory,
    logger,
  );

  return {
    transport: transport.kind,
    async send(message: MailMessage): Promise<MailResult> {
      try {
        return await transport.send(message, options.config.smtp.from);
      } catch (error) {
        // Falha de envio não derruba o fluxo que a disparou: registrar e
        // reenviar é melhor que perder um cadastro por causa do servidor de
        // e-mail. Quem chama decide o que dizer ao usuário.
        logger.error({ err: error, mailKind: message.kind }, 'failed to deliver email');

        throw error;
      }
    },
    verify: () => transport.verify(),
    close: () => transport.close(),
  };
}
