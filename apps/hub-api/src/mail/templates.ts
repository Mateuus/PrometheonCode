/**
 * Templates de e-mail, em texto e HTML.
 *
 * O conteúdo é em inglês porque é interface do produto (`CLAUDE.md`). Os dois
 * formatos são obrigatórios: cliente que bloqueia HTML precisa do texto, e o
 * texto também é o que o transporte de captura grava em disco.
 *
 * Regra que atravessa o arquivo: **o token aparece no corpo da mensagem e em
 * nenhum outro lugar** — nem em log, nem em métrica, nem em auditoria.
 */

import type { MailMessage } from './types.js';

/** Escapa o que for interpolado no HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function minutesOrHours(seconds: number): string {
  if (seconds < 3_600) {
    return `${String(Math.round(seconds / 60))} minutes`;
  }

  if (seconds < 86_400) {
    return `${String(Math.round(seconds / 3_600))} hours`;
  }

  return `${String(Math.round(seconds / 86_400))} days`;
}

/** Moldura comum: um HTML simples, sem imagem externa e sem script. */
function layout(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#0f1115;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e8eb">',
    '<div style="max-width:520px;margin:0 auto;background:#161a21;border-radius:12px;padding:32px">',
    '<p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8b93a1">Prometheon</p>',
    bodyHtml,
    '<hr style="border:none;border-top:1px solid #262b33;margin:32px 0 16px">',
    '<p style="margin:0;font-size:12px;color:#8b93a1">If you did not expect this message, you can ignore it.</p>',
    '</div></body></html>',
  ].join('');
}

function button(url: string, label: string): string {
  return [
    `<p style="margin:0 0 24px"><a href="${escapeHtml(url)}"`,
    ' style="display:inline-block;padding:12px 20px;background:#e2603a;color:#fff;',
    'text-decoration:none;border-radius:8px;font-weight:600">',
    `${escapeHtml(label)}</a></p>`,
  ].join('');
}

export interface VerificationTemplateInput {
  readonly name: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
}

export function verificationEmail(input: VerificationTemplateInput): MailMessage & { to: string } {
  const validity = minutesOrHours(input.expiresInSeconds);
  const text = [
    `Hi ${input.name},`,
    '',
    'Confirm your email address to finish setting up your Prometheon account:',
    '',
    input.verificationUrl,
    '',
    `The link is valid for ${validity} and can only be used once.`,
    '',
    'If you did not create this account, you can ignore this message.',
    '',
    '— Prometheon',
  ].join('\n');

  const html = layout(
    'Confirm your email address',
    [
      '<h1 style="margin:0 0 16px;font-size:22px">Confirm your email address</h1>',
      `<p style="margin:0 0 24px;line-height:1.6">Hi ${escapeHtml(input.name)}, confirm your address to finish setting up your Prometheon account.</p>`,
      button(input.verificationUrl, 'Confirm email address'),
      `<p style="margin:0;font-size:13px;color:#8b93a1;line-height:1.6">The link is valid for ${validity} and can only be used once.</p>`,
    ].join(''),
  );

  return {
    to: '',
    kind: 'email-verification',
    subject: 'Confirm your Prometheon email address',
    text,
    html,
    primaryLink: input.verificationUrl,
  };
}

export interface PasswordResetTemplateInput {
  readonly name: string;
  readonly resetUrl: string;
  readonly expiresInSeconds: number;
}

export function passwordResetEmail(input: PasswordResetTemplateInput): MailMessage & { to: string } {
  const validity = minutesOrHours(input.expiresInSeconds);
  const text = [
    `Hi ${input.name},`,
    '',
    'Someone asked to reset the password of your Prometheon account. Use the link below to choose a new one:',
    '',
    input.resetUrl,
    '',
    `The link is valid for ${validity} and can only be used once.`,
    '',
    'If it was not you, no action is needed — your password has not changed.',
    '',
    '— Prometheon',
  ].join('\n');

  const html = layout(
    'Reset your password',
    [
      '<h1 style="margin:0 0 16px;font-size:22px">Reset your password</h1>',
      `<p style="margin:0 0 24px;line-height:1.6">Hi ${escapeHtml(input.name)}, use the button below to choose a new password.</p>`,
      button(input.resetUrl, 'Choose a new password'),
      `<p style="margin:0 0 8px;font-size:13px;color:#8b93a1;line-height:1.6">The link is valid for ${validity} and can only be used once.</p>`,
      '<p style="margin:0;font-size:13px;color:#8b93a1;line-height:1.6">If it was not you, your password has not changed.</p>',
    ].join(''),
  );

  return {
    to: '',
    kind: 'password-reset',
    subject: 'Reset your Prometheon password',
    text,
    html,
    primaryLink: input.resetUrl,
  };
}

export interface InvitationTemplateInput {
  readonly organizationName: string;
  readonly inviterName: string;
  readonly role: string;
  readonly invitationUrl: string;
  readonly expiresInSeconds: number;
}

export function invitationEmail(input: InvitationTemplateInput): MailMessage & { to: string } {
  const validity = minutesOrHours(input.expiresInSeconds);
  const text = [
    `${input.inviterName} invited you to join ${input.organizationName} on Prometheon as ${input.role}.`,
    '',
    'Accept the invitation:',
    '',
    input.invitationUrl,
    '',
    `The invitation expires in ${validity}.`,
    '',
    '— Prometheon',
  ].join('\n');

  const html = layout(
    `Join ${input.organizationName}`,
    [
      `<h1 style="margin:0 0 16px;font-size:22px">Join ${escapeHtml(input.organizationName)}</h1>`,
      `<p style="margin:0 0 24px;line-height:1.6">${escapeHtml(input.inviterName)} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as <strong>${escapeHtml(input.role)}</strong>.</p>`,
      button(input.invitationUrl, 'Accept invitation'),
      `<p style="margin:0;font-size:13px;color:#8b93a1;line-height:1.6">The invitation expires in ${validity}.</p>`,
    ].join(''),
  );

  return {
    to: '',
    kind: 'organization-invitation',
    subject: `You have been invited to ${input.organizationName} on Prometheon`,
    text,
    html,
    primaryLink: input.invitationUrl,
  };
}

export interface RegistrationAttemptTemplateInput {
  readonly name: string;
  readonly signInUrl: string;
  readonly passwordResetUrl: string;
}

/**
 * Enviado quando alguém tenta registrar um e-mail que já tem conta.
 *
 * É a contrapartida da resposta uniforme do `POST /v1/auth/register`: a API não
 * conta a quem chamou que o endereço existe, mas o dono do endereço precisa
 * saber que alguém tentou. Sem esta mensagem, a proteção contra enumeração
 * viraria silêncio para quem tem direito à informação.
 */
export function registrationAttemptEmail(
  input: RegistrationAttemptTemplateInput,
): MailMessage & { to: string } {
  const text = [
    `Hi ${input.name},`,
    '',
    'Someone tried to create a Prometheon account with this email address, but an account already exists.',
    '',
    `Sign in: ${input.signInUrl}`,
    `Forgot your password? ${input.passwordResetUrl}`,
    '',
    'If it was you, just sign in. If it was not, no action is needed — nothing has changed.',
    '',
    '— Prometheon',
  ].join('\n');

  const html = layout(
    'An account already exists',
    [
      '<h1 style="margin:0 0 16px;font-size:22px">An account already exists</h1>',
      `<p style="margin:0 0 24px;line-height:1.6">Hi ${escapeHtml(input.name)}, someone tried to create a Prometheon account with this address, but you already have one.</p>`,
      button(input.signInUrl, 'Sign in'),
      `<p style="margin:0;font-size:13px;color:#8b93a1;line-height:1.6">Forgot your password? <a style="color:#e2603a" href="${escapeHtml(input.passwordResetUrl)}">Reset it here</a>.</p>`,
    ].join(''),
  );

  return {
    to: '',
    kind: 'registration-attempt',
    subject: 'About your Prometheon account',
    text,
    html,
    primaryLink: input.signInUrl,
  };
}
