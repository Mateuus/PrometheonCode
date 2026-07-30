/**
 * Health e versão (`Docs/06`).
 *
 * `ready` só confere se as dependências respondem; nada de consulta cara.
 * A configuração exposta aqui é sempre a versão redigida (`Docs/09`).
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './primitives.js';

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.int().nonnegative(),
});

export const dependencyCheckSchema = z.object({
  name: z.enum(['mysql', 'redis', 'smtp']),
  status: z.enum(['ok', 'degraded', 'down']),
  latencyMs: z.number().nonnegative().nullable(),
  detail: z.string().max(255).nullable(),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.array(dependencyCheckSchema),
  checkedAt: isoDateTimeSchema,
});

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export const versionResponseSchema = z.object({
  service: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  commit: z.string().max(64).nullable(),
  builtAt: isoDateTimeSchema.nullable(),
  environment: z.enum(['development', 'test', 'staging', 'production']),
  apiVersion: z.literal('v1'),
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;
