/**
 * Planos e assinatura da organização.
 *
 * Hoje existe um único plano gratuito, de preço zero. O contrato já nasce
 * preparado para mais de um plano e para limites por plano, para que aparecer
 * um plano pago não vire mudança quebrando cliente.
 *
 * Preço é inteiro na menor unidade da moeda (`Docs/03`); `null` em um limite
 * significa "sem teto".
 */

import { z } from 'zod';

import {
  isoDateTimeSchema,
  longTextSchema,
  moneySchema,
  shortTextSchema,
  slugSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

export const BILLING_INTERVALS = ['month', 'year', 'lifetime'] as const;

export const billingIntervalSchema = z.enum(BILLING_INTERVALS);

export type BillingInterval = z.infer<typeof billingIntervalSchema>;

/** Teto de uso; `null` é ilimitado. */
const limit = () => z.int().nonnegative().nullable();

export const planLimitsSchema = z.object({
  maxMembers: limit(),
  maxProjects: limit(),
  maxDevicesPerUser: limit(),
  maxConcurrentAgentRuns: limit(),
  maxConversationsPerProject: limit(),
  maxKnowledgeItemsPerProject: limit(),
  /** Minutos de execução de agente remoto por mês. */
  maxMonthlyAgentMinutes: limit(),
  maxStorageBytes: limit(),
  /** Dias de retenção de conversa e de auditoria. */
  retentionDays: limit(),
});

export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const PLAN_FEATURES = [
  'web_chat',
  'local_chat_sync',
  'remote_agents',
  'knowledge_review',
  'git_integrations',
  'audit_log',
  'sso',
  'priority_support',
] as const;

export const planFeatureSchema = z.enum(PLAN_FEATURES);

export type PlanFeature = z.infer<typeof planFeatureSchema>;

export const planSchema = z.object({
  /** Identificador estável do plano, usado em `organization.planCode`. */
  code: slugSchema,
  name: shortTextSchema,
  description: longTextSchema.nullable(),
  price: moneySchema,
  interval: billingIntervalSchema,
  limits: planLimitsSchema,
  features: z.array(planFeatureSchema),
  /** Plano atribuído a toda organização recém-criada. */
  isDefault: z.boolean(),
  /** Planos ocultos existem para contrato negociado e não aparecem na lista. */
  isPublic: z.boolean(),
  sortOrder: z.int().nonnegative(),
});

export type Plan = z.infer<typeof planSchema>;

export const planListSchema = z.object({
  plans: z.array(planSchema),
});

export const SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'canceled',
] as const;

export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const subscriptionSchema = z.object({
  id: ulidSchema,
  organizationId: ulidSchema,
  planCode: slugSchema,
  status: subscriptionStatusSchema,
  /** Assentos contratados; `null` quando o plano não cobra por assento. */
  seats: z.int().positive().nullable(),
  currentPeriodStart: isoDateTimeSchema,
  /** `null` em plano vitalício ou gratuito sem ciclo. */
  currentPeriodEnd: isoDateTimeSchema.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  version: versionSchema,
});

export type Subscription = z.infer<typeof subscriptionSchema>;

/** Consumo atual medido contra os limites do plano. */
export const usageSchema = z.object({
  members: z.int().nonnegative(),
  projects: z.int().nonnegative(),
  devices: z.int().nonnegative(),
  concurrentAgentRuns: z.int().nonnegative(),
  monthlyAgentMinutes: z.int().nonnegative(),
  storageBytes: z.int().nonnegative(),
  measuredAt: isoDateTimeSchema,
});

export type Usage = z.infer<typeof usageSchema>;

export const subscriptionOverviewSchema = z.object({
  subscription: subscriptionSchema,
  plan: planSchema,
  usage: usageSchema,
});

export type SubscriptionOverview = z.infer<typeof subscriptionOverviewSchema>;

export const changePlanRequestSchema = z.object({
  planCode: slugSchema,
  seats: z.int().positive().optional(),
  version: versionSchema,
});

/**
 * Plano gratuito do MVP. Fica aqui, no contrato, porque a extensão e o Hub Web
 * precisam saber os limites antes de qualquer chamada.
 */
export const FREE_PLAN: Plan = planSchema.parse({
  code: 'free',
  name: 'Free',
  description: 'Plano único do MVP, sem cobrança.',
  price: { amount: 0, currency: 'USD' },
  interval: 'month',
  limits: {
    maxMembers: 10,
    maxProjects: 5,
    maxDevicesPerUser: 3,
    maxConcurrentAgentRuns: 2,
    maxConversationsPerProject: 200,
    maxKnowledgeItemsPerProject: 500,
    maxMonthlyAgentMinutes: 600,
    maxStorageBytes: 1_073_741_824,
    retentionDays: 90,
  },
  features: ['web_chat', 'local_chat_sync', 'knowledge_review', 'audit_log'],
  isDefault: true,
  isPublic: true,
  sortOrder: 0,
});
