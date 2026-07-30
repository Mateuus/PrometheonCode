/**
 * Envelopes de resposta e de erro do Hub API (`Docs/06`).
 *
 * Sucesso: `{ data, meta: { requestId } }`.
 * Erro:    `{ error: { code, message, requestId } }`.
 *
 * `errorCode` é enumerado e **estável**: cliente e extensão decidem
 * comportamento a partir dele, então valor existente nunca muda de significado
 * — quando algo novo aparece, acrescenta-se um código.
 */

import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './primitives.js';

export const ERROR_CODES = [
  // Validação e requisição
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'IDEMPOTENCY_KEY_REUSED',
  'VERSION_CONFLICT',
  'CONFLICT',
  'NOT_FOUND',

  // Autenticação
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'SESSION_REVOKED',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_ALREADY_REGISTERED',
  'PASSWORD_TOO_WEAK',
  'RESET_TOKEN_INVALID',
  'VERIFICATION_TOKEN_INVALID',

  // Device flow
  'DEVICE_AUTHORIZATION_PENDING',
  'DEVICE_AUTHORIZATION_DENIED',
  'DEVICE_CODE_EXPIRED',
  'DEVICE_CODE_INVALID',
  'DEVICE_NOT_FOUND',
  'DEVICE_REVOKED',
  'SLOW_DOWN',

  // Autorização
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'ORGANIZATION_ACCESS_DENIED',
  'PROJECT_ACCESS_DENIED',

  // Organização e membros
  'ORGANIZATION_NOT_FOUND',
  'ORGANIZATION_SLUG_TAKEN',
  'MEMBER_NOT_FOUND',
  'MEMBER_ALREADY_EXISTS',
  'LAST_OWNER_CANNOT_BE_REMOVED',
  'INVITATION_NOT_FOUND',
  'INVITATION_EXPIRED',
  'INVITATION_ALREADY_USED',

  // Projeto e chat
  'PROJECT_NOT_FOUND',
  'PROJECT_SLUG_TAKEN',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_ARCHIVED',
  'MESSAGE_NOT_FOUND',

  // Orquestração
  'TASK_NOT_FOUND',
  'TASK_ALREADY_CLAIMED',
  'TASK_NOT_CLAIMED_BY_ACTOR',
  'TASK_DEPENDENCY_CYCLE',
  'AGENT_RUN_NOT_FOUND',
  'SCOPE_CONFLICT',
  'APPROVAL_NOT_FOUND',

  // Conhecimento
  'KNOWLEDGE_NOT_FOUND',
  'KNOWLEDGE_ALREADY_REVIEWED',
  'KNOWLEDGE_REVIEW_CONFLICT',

  // Planos e assinatura
  'PLAN_NOT_FOUND',
  'PLAN_LIMIT_EXCEEDED',
  'SUBSCRIPTION_NOT_FOUND',

  // Infraestrutura
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'NOT_IMPLEMENTED',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Códigos que o cliente pode resolver repetindo a chamada mais tarde. */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = [
  'RATE_LIMITED',
  'SLOW_DOWN',
  'SERVICE_UNAVAILABLE',
  'DEVICE_AUTHORIZATION_PENDING',
];

export const responseMetaSchema = z.object({
  requestId: requestIdSchema,
});

export type ResponseMeta = z.infer<typeof responseMetaSchema>;

/**
 * Detalhe por campo, usado quando `code` é `VALIDATION_FAILED`. O caminho segue
 * a forma do corpo enviado (`user.email`, `parts.0.text`).
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  requestId: requestIdSchema,
  /** Presente apenas em erros de validação. */
  fields: z.array(fieldErrorSchema).optional(),
  /** Momento em que o servidor liberará a chamada, em `RATE_LIMITED`. */
  retryAfter: isoDateTimeSchema.optional(),
});

export const errorEnvelopeSchema = z.object({
  error: errorBodySchema,
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Envolve um schema de dados no envelope de sucesso. */
export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({
    data,
    meta: responseMetaSchema,
  });
}

/** Resposta de comando sem corpo útil. */
export const emptyDataSchema = z.object({});

export const emptyEnvelopeSchema = successEnvelope(emptyDataSchema);

/** Discrimina sucesso e erro numa mesma resposta HTTP. */
export function responseSchema<T extends z.ZodType>(data: T) {
  return z.union([successEnvelope(data), errorEnvelopeSchema]);
}
