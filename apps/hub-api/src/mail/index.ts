export { createMailService, type CreateMailServiceOptions } from './service.js';
export {
  createCaptureTransport,
  createSmtpTransport,
  defaultCaptureDirectory,
  resolveTransport,
} from './transport.js';
export {
  invitationEmail,
  passwordResetEmail,
  registrationAttemptEmail,
  verificationEmail,
  type InvitationTemplateInput,
  type PasswordResetTemplateInput,
  type RegistrationAttemptTemplateInput,
  type VerificationTemplateInput,
} from './templates.js';
export type {
  MailKind,
  MailMessage,
  MailResult,
  MailService,
  MailTransport,
  MailTransportKind,
} from './types.js';
