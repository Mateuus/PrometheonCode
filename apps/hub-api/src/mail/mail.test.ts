/**
 * Templates e transporte de captura.
 *
 * Não precisa de banco nem de Redis: é o pedaço do serviço de e-mail que precisa
 * funcionar mesmo com o Docker parado, e o teste reflete isso.
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@prometheon/logger';
import { describe, expect, it } from 'vitest';

import {
  invitationEmail,
  passwordResetEmail,
  registrationAttemptEmail,
  verificationEmail,
} from './templates.js';
import { createCaptureTransport } from './transport.js';

const silentLogger = createLogger({ level: 'silent', env: 'test' });

describe('templates de e-mail', () => {
  it('a verificação traz o link nas duas versões e diz a validade', () => {
    const message = verificationEmail({
      name: 'Ada',
      verificationUrl: 'https://hub.example/verify-email?token=abc',
      expiresInSeconds: 86_400,
    });

    expect(message.kind).toBe('email-verification');
    expect(message.text).toContain('https://hub.example/verify-email?token=abc');
    expect(message.html).toContain('https://hub.example/verify-email?token=abc');
    expect(message.text).toContain('1 days');
    expect(message.primaryLink).toBe('https://hub.example/verify-email?token=abc');
  });

  it('a recuperação de senha diz que nada mudou se não foi o usuário', () => {
    const message = passwordResetEmail({
      name: 'Ada',
      resetUrl: 'https://hub.example/reset-password?token=xyz',
      expiresInSeconds: 1_800,
    });

    expect(message.text).toContain('30 minutes');
    expect(message.text).toContain('your password has not changed');
  });

  it('o convite nomeia a organização, quem convidou e o papel', () => {
    const message = invitationEmail({
      organizationName: 'Acme',
      inviterName: 'Ada',
      role: 'developer',
      invitationUrl: 'https://hub.example/invitations/accept?token=inv',
      expiresInSeconds: 604_800,
    });

    expect(message.subject).toContain('Acme');
    expect(message.text).toContain('Ada');
    expect(message.text).toContain('developer');
    expect(message.text).toContain('7 days');
  });

  it('escapa o que é interpolado no HTML', () => {
    const message = invitationEmail({
      organizationName: '<script>alert(1)</script>',
      inviterName: 'Ada & Cia',
      role: 'viewer',
      invitationUrl: 'https://hub.example/invitations/accept?token=inv',
      expiresInSeconds: 3_600,
    });

    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('Ada &amp; Cia');
  });

  it('a tentativa de registro em conta existente não revela nada a quem tentou', () => {
    const message = registrationAttemptEmail({
      name: 'Ada',
      signInUrl: 'https://hub.example/sign-in',
      passwordResetUrl: 'https://hub.example/forgot-password',
    });

    expect(message.kind).toBe('registration-attempt');
    // O assunto é neutro: quem vê a caixa de entrada de outra pessoa por cima do
    // ombro não descobre o que aconteceu.
    expect(message.subject).toBe('About your Prometheon account');
  });
});

describe('transporte de captura', () => {
  it('grava a mensagem em disco e devolve o caminho', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prometheon-mail-unit-'));
    const transport = createCaptureTransport(directory, silentLogger);

    const result = await transport.send(
      {
        ...verificationEmail({
          name: 'Ada',
          verificationUrl: 'https://hub.example/verify-email?token=abc',
          expiresInSeconds: 3_600,
        }),
        to: 'ada@example.test',
      },
      'Prometheon <no-reply@example.test>',
    );

    expect(result.transport).toBe('capture');
    expect(result.capturedAt).toBeDefined();

    const files = await readdir(directory);

    expect(files.filter((name) => name.endsWith('.eml'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(1);

    const raw = await readFile(result.capturedAt as string, 'utf8');

    expect(raw).toContain('To: ada@example.test');
    expect(raw).toContain('Subject: Confirm your Prometheon email address');

    const jsonName = files.find((name) => name.endsWith('.json')) as string;
    const parsed = JSON.parse(await readFile(join(directory, jsonName), 'utf8')) as {
      to: string;
      primaryLink: string;
    };

    expect(parsed.to).toBe('ada@example.test');
    expect(parsed.primaryLink).toBe('https://hub.example/verify-email?token=abc');
  });

  it('o `verify` do transporte de captura sempre responde que está pronto', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'prometheon-mail-unit-'));
    const transport = createCaptureTransport(directory, silentLogger);
    const result = await transport.verify();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain(directory);
  });
});
