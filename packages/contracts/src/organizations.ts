/**
 * Organizações, membros e convites (`Docs/06`, `Docs/09`).
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import { organizationRoleSchema, permissionSchema } from './permissions.js';
import {
  emailSchema,
  isoDateTimeSchema,
  longTextSchema,
  shortTextSchema,
  slugSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

export const organizationSchema = z.object({
  id: ulidSchema,
  name: shortTextSchema,
  slug: slugSchema,
  description: longTextSchema.nullable(),
  avatarUrl: z.url().nullable(),
  /** Código do plano vigente; ver `billing.ts`. */
  planCode: slugSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  createdBy: ulidSchema,
  version: versionSchema,
});

export type Organization = z.infer<typeof organizationSchema>;

/** Organização acompanhada do papel e das permissões de quem consultou. */
export const organizationWithAccessSchema = organizationSchema.extend({
  role: organizationRoleSchema,
  permissions: z.array(permissionSchema),
});

export type OrganizationWithAccess = z.infer<
  typeof organizationWithAccessSchema
>;

export const createOrganizationRequestSchema = z.object({
  name: shortTextSchema,
  /** Gerado a partir do nome quando não vier. */
  slug: slugSchema.optional(),
  description: longTextSchema.optional(),
});

export const updateOrganizationRequestSchema = z.object({
  name: shortTextSchema.optional(),
  slug: slugSchema.optional(),
  description: longTextSchema.nullable().optional(),
  avatarUrl: z.url().nullable().optional(),
  /** Concorrência otimista: a versão que o cliente leu. */
  version: versionSchema,
});

/**
 * Exclusão de organização.
 *
 * Pede o `slug` de novo de propósito: a confirmação digitada é o que separa
 * "apagar o tenant" de um clique errado, e deixá-la só na interface faria a
 * API aceitar por engano o que a tela protegia.
 */
export const deleteOrganizationRequestSchema = z.object({
  slug: slugSchema,
  version: versionSchema,
});

export const organizationPageSchema = cursorPageSchema(
  organizationWithAccessSchema,
);

export const organizationListQuerySchema = cursorPageQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
});

// ---------------------------------------------------------------------------
// Membros
// ---------------------------------------------------------------------------

export const MEMBER_STATUSES = ['active', 'invited', 'suspended'] as const;

export const memberStatusSchema = z.enum(MEMBER_STATUSES);

export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const organizationMemberSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  user: publicUserSchema,
  role: organizationRoleSchema,
  status: memberStatusSchema,
  invitedBy: ulidSchema.nullable(),
  joinedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  version: versionSchema,
});

export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

export const memberListQuerySchema = cursorPageQuerySchema.extend({
  role: organizationRoleSchema.optional(),
  status: memberStatusSchema.optional(),
  search: z.string().trim().max(120).optional(),
});

export const memberPageSchema = cursorPageSchema(organizationMemberSchema);

export const updateMemberRequestSchema = z.object({
  role: organizationRoleSchema.optional(),
  status: memberStatusSchema.optional(),
  version: versionSchema,
});

// ---------------------------------------------------------------------------
// Convites
// ---------------------------------------------------------------------------

export const INVITATION_STATUSES = [
  'pending',
  'accepted',
  'revoked',
  'expired',
] as const;

export const invitationStatusSchema = z.enum(INVITATION_STATUSES);

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  email: emailSchema,
  role: organizationRoleSchema,
  status: invitationStatusSchema,
  invitedBy: publicUserSchema,
  /** Projetos aos quais o convidado entra já com acesso. */
  projectIds: z.array(ulidSchema),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
});

export type Invitation = z.infer<typeof invitationSchema>;

export const createInvitationRequestSchema = z.object({
  email: emailSchema,
  role: organizationRoleSchema,
  projectIds: z.array(ulidSchema).max(50).default([]),
  message: z.string().trim().max(1000).optional(),
});

export const invitationListQuerySchema = cursorPageQuerySchema.extend({
  status: invitationStatusSchema.optional(),
});

export const invitationPageSchema = cursorPageSchema(invitationSchema);

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(16).max(512),
});

export const acceptInvitationResponseSchema = z.object({
  organization: organizationWithAccessSchema,
  member: organizationMemberSchema,
});
