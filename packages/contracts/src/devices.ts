/**
 * Dispositivos e presença (`Docs/06`, `Docs/08`, `Docs/09`).
 *
 * Um dispositivo é uma instalação da extensão ou da CLI. Ele se registra pelo
 * device flow, manda heartbeat e aparece na presença do projeto.
 */

import { z } from 'zod';

import { deviceKindSchema, publicUserSchema } from './auth.js';
import { cursorPageQuerySchema, cursorPageSchema } from './pagination.js';
import {
  isoDateTimeSchema,
  shortTextSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

export const DEVICE_STATUSES = ['online', 'idle', 'offline', 'revoked'] as const;

export const deviceStatusSchema = z.enum(DEVICE_STATUSES);

export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

export const deviceSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  owner: publicUserSchema,
  name: shortTextSchema,
  kind: deviceKindSchema,
  platform: z.string().max(64).nullable(),
  clientVersion: z.string().max(64).nullable(),
  status: deviceStatusSchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  version: versionSchema,
});

export type Device = z.infer<typeof deviceSchema>;

export const registerDeviceRequestSchema = z.object({
  name: shortTextSchema,
  kind: deviceKindSchema,
  platform: z.string().max(64).optional(),
  clientVersion: z.string().max(64).optional(),
  /**
   * Impressão estável da instalação, para reconhecer o mesmo dispositivo depois
   * de uma reinstalação. Nunca contém identificador de hardware.
   */
  installationId: z.string().min(8).max(128),
});

export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const deviceHeartbeatRequestSchema = z.object({
  status: z.enum(['online', 'idle']),
  /** Projetos que o dispositivo tem abertos agora. */
  projectIds: z.array(ulidSchema).max(50).default([]),
  activeAgentRunIds: z.array(ulidSchema).max(50).default([]),
  clientVersion: z.string().max(64).optional(),
});

export const deviceHeartbeatResponseSchema = z.object({
  /** Intervalo até o próximo heartbeat, em segundos. */
  nextHeartbeatIn: z.int().positive(),
  /** O servidor pede que o dispositivo pare — token revogado ou versão velha. */
  shouldStop: z.boolean(),
});

export const deviceListQuerySchema = cursorPageQuerySchema.extend({
  status: deviceStatusSchema.optional(),
  kind: deviceKindSchema.optional(),
  userId: ulidSchema.optional(),
});

export const devicePageSchema = cursorPageSchema(deviceSchema);

/** Presença de uma pessoa num projeto, agregada a partir dos dispositivos. */
export const presenceEntrySchema = z.object({
  user: publicUserSchema,
  projectId: ulidSchema,
  status: z.enum(['online', 'idle', 'offline']),
  deviceIds: z.array(ulidSchema),
  activeAgentRuns: z.int().nonnegative(),
  lastSeenAt: isoDateTimeSchema,
});

export type PresenceEntry = z.infer<typeof presenceEntrySchema>;

export const presenceListSchema = z.object({
  entries: z.array(presenceEntrySchema),
});
