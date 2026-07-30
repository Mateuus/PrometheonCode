/**
 * Transportes de e-mail.
 *
 * Dois, e a escolha entre eles é automática:
 *
 * - **SMTP** (`nodemailer`), configurado por `SMTP_*`. Em desenvolvimento aponta
 *   para `127.0.0.1:1025`, o Maildev do compose.
 * - **Captura em disco**, para quando não há SMTP algum. Ele grava a mensagem
 *   inteira em um arquivo e registra o link no log. Isso não é conforto: nesta
 *   máquina o Docker está parado, o Maildev não sobe, e sem esse transporte o
 *   cadastro simplesmente não teria como ser concluído.
 *
 * O diretório de captura fica em `os.tmpdir()` por padrão, **fora do
 * repositório**. As mensagens carregam links com token de uso único — que é
 * credencial — e o `CLAUDE.md` proíbe segredo em arquivo do repositório.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@prometheon/logger';
import nodemailer, { type Transporter } from 'nodemailer';

import type { AppConfig } from '../config/index.js';
import type { MailMessage, MailResult, MailTransport } from './types.js';

/** Sanitiza o que vai virar nome de arquivo. */
function slugForFile(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/**
 * Transporte de captura.
 *
 * Grava `.eml` (a mensagem como um cliente de e-mail a leria) e `.json` (os
 * campos separados, para o teste automatizado ler sem parsear MIME).
 */
export function createCaptureTransport(
  directory: string,
  logger: Logger,
): MailTransport {
  let ensured = false;

  async function ensureDirectory(): Promise<void> {
    if (!ensured) {
      await mkdir(directory, { recursive: true });
      ensured = true;
    }
  }

  return {
    kind: 'capture',
    async send(message: MailMessage, from: string): Promise<MailResult> {
      await ensureDirectory();

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(directory, `${stamp}_${message.kind}_${slugForFile(message.to)}`);
      const raw = [
        `From: ${from}`,
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        message.text,
      ].join('\r\n');

      await writeFile(`${base}.eml`, raw, 'utf8');
      await writeFile(
        `${base}.json`,
        JSON.stringify(
          {
            from,
            to: message.to,
            subject: message.subject,
            kind: message.kind,
            primaryLink: message.primaryLink ?? null,
            text: message.text,
            html: message.html,
            capturedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );

      // O link é o único campo impresso: ele é o que destrava o fluxo em
      // desenvolvimento. Nada mais do corpo vai para o log.
      logger.info(
        { mailKind: message.kind, file: `${base}.eml`, link: message.primaryLink ?? null },
        'email captured to disk (no SMTP transport available)',
      );

      return { transport: 'capture', capturedAt: `${base}.eml` };
    },
    async verify() {
      await ensureDirectory();

      return { ok: true, detail: `capturing to ${directory}` };
    },
    async close() {
      // Nada a fechar.
    },
  };
}

/** Transporte SMTP do `nodemailer`. */
export function createSmtpTransport(config: AppConfig, logger: Logger): MailTransport {
  const transporter: Transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    ...(config.smtp.user !== undefined && config.smtp.user !== ''
      ? { auth: { user: config.smtp.user, pass: config.smtp.password ?? '' } }
      : {}),
    // O Maildev local não faz TLS; em produção `secure` liga o TLS de verdade.
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });

  return {
    kind: 'smtp',
    async send(message: MailMessage, from: string): Promise<MailResult> {
      // `sendMail` é tipado como `any` pelo nodemailer; só o `messageId`
      // interessa, e ele é lido com o tipo declarado explicitamente.
      const info = (await transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      })) as { messageId?: string };

      // Sem link e sem corpo: o log guarda que a mensagem saiu, não o que ela diz.
      logger.info({ mailKind: message.kind, messageId: info.messageId }, 'email sent over smtp');

      return { transport: 'smtp', messageId: info.messageId };
    },
    async verify() {
      try {
        await transporter.verify();

        return { ok: true, detail: `${config.smtp.host}:${String(config.smtp.port)}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    close: () => {
      transporter.close();

      return Promise.resolve();
    },
  };
}

export function defaultCaptureDirectory(): string {
  return join(tmpdir(), 'prometheon-mail');
}

/**
 * Escolhe o transporte.
 *
 * Em `auto`, tenta o SMTP e cai para a captura quando ele não responde — é o
 * caminho que mantém o cadastro funcionando com o Docker parado.
 */
export async function resolveTransport(
  config: AppConfig,
  mode: 'auto' | 'smtp' | 'capture',
  captureDirectory: string,
  logger: Logger,
): Promise<MailTransport> {
  if (mode === 'capture') {
    return createCaptureTransport(captureDirectory, logger);
  }

  const smtp = createSmtpTransport(config, logger);
  const probe = await smtp.verify();

  if (probe.ok) {
    logger.info({ host: config.smtp.host, port: config.smtp.port }, 'smtp transport ready');

    return smtp;
  }

  await smtp.close();

  if (mode === 'smtp') {
    // Pedido explícito de SMTP: falhar aqui é melhor que fingir que enviou.
    logger.error({ reason: probe.detail }, 'smtp transport is unreachable');

    return smtp;
  }

  logger.warn(
    { reason: probe.detail, directory: captureDirectory },
    'smtp unreachable; falling back to the on-disk capture transport',
  );

  return createCaptureTransport(captureDirectory, logger);
}
