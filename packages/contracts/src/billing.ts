/**
 * Planos e assinatura da organização.
 *
 * Hoje existe um único plano gratuito, de preço zero. O contrato já nasce
 * preparado para mais de um plano e para limites por plano, para que aparecer
 * um plano pago não vire mudança quebrando cliente.
 *
 * Os campos espelham as colunas de `plans` e o vínculo `organizations.plan_id`
 * — não há tabela de assinatura separada, e inventar uma no contrato só criaria
 * um campo que ninguém consegue preencher com a verdade.
 *
 * Preço é inteiro na menor unidade da moeda (`Docs/03`); `null` em um limite
 * significa "sem teto".
 */

import { z } from 'zod';

import { publicUserSchema } from './auth.js';
import {
  isoDateTimeSchema,
  longTextSchema,
  moneySchema,
  shortTextSchema,
  slugSchema,
  ulidSchema,
  versionSchema,
} from './primitives.js';

/** Periodicidade da cobrança. `none` é o plano gratuito. */
export const BILLING_PERIODS = ['none', 'monthly', 'yearly'] as const;

export const billingPeriodSchema = z.enum(BILLING_PERIODS);

export type BillingPeriod = z.infer<typeof billingPeriodSchema>;

/** Teto de uso; `null` é ilimitado. */
const limit = () => z.int().nonnegative().nullable();

/**
 * Tetos que o servidor cobra na criação.
 *
 * `retentionDays` fica de fora porque não barra nada: é política de retenção
 * aplicada pelo worker, não limite de criação.
 */
export const PLAN_LIMIT_KEYS = [
  'maxMembers',
  'maxProjects',
  'maxKnowledgeItems',
  'maxAgentRunsPerMonth',
  'maxStorageBytes',
] as const;

export const planLimitKeySchema = z.enum(PLAN_LIMIT_KEYS);

export type PlanLimitKey = z.infer<typeof planLimitKeySchema>;

export const planLimitsSchema = z.object({
  maxMembers: limit(),
  maxProjects: limit(),
  /** Itens de conhecimento por organização. */
  maxKnowledgeItems: limit(),
  maxAgentRunsPerMonth: limit(),
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
  id: ulidSchema,
  /** Identificador estável do plano, usado em `organization.planCode`. */
  code: slugSchema,
  name: shortTextSchema,
  description: longTextSchema.nullable(),
  price: moneySchema,
  billingPeriod: billingPeriodSchema,
  limits: planLimitsSchema,
  features: z.array(planFeatureSchema),
  /** Plano atribuído a toda organização recém-criada. */
  isDefault: z.boolean(),
  /** Plano inativo não pode ser escolhido, mas continua valendo para quem tem. */
  isActive: z.boolean(),
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

/**
 * O vínculo entre a organização e o plano.
 *
 * Não é uma linha própria no banco: é `organizations.plan_id` visto de fora.
 * `version` é a da organização, e é ela que a troca de plano usa no controle
 * otimista de concorrência.
 */
export const subscriptionSchema = z.object({
  organizationId: ulidSchema,
  planCode: slugSchema,
  status: subscriptionStatusSchema,
  /** Desde quando a organização existe sob algum plano. */
  startedAt: isoDateTimeSchema,
  /** `null` em plano gratuito, que não tem ciclo de cobrança. */
  currentPeriodEnd: isoDateTimeSchema.nullable(),
  version: versionSchema,
});

export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * Consumo atual medido contra os limites do plano.
 *
 * Só entra aqui o que o servidor sabe contar de verdade. Um número inventado
 * numa tela de limite é pior que a ausência dele: ele decide compra.
 */
export const usageSchema = z.object({
  members: z.int().nonnegative(),
  projects: z.int().nonnegative(),
  knowledgeItems: z.int().nonnegative(),
  agentRunsThisMonth: z.int().nonnegative(),
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
  /** Versão da organização que o administrador leu. */
  version: versionSchema,
});

export type ChangePlanRequest = z.infer<typeof changePlanRequestSchema>;

export const planChangeResultSchema = z.object({
  subscription: subscriptionSchema,
  plan: planSchema,
  /** Quem trocou; a mesma informação que foi para a auditoria. */
  changedBy: publicUserSchema.nullable(),
  previousPlanCode: slugSchema,
});

/**
 * Detalhe de um limite estourado.
 *
 * Vai no corpo do erro `PLAN_LIMIT_EXCEEDED` para que o cliente possa dizer
 * exatamente qual teto bateu, sem interpretar texto.
 */
export const planLimitViolationSchema = z.object({
  limit: planLimitKeySchema,
  planCode: slugSchema,
  allowed: z.int().nonnegative(),
  current: z.int().nonnegative(),
});

export type PlanLimitViolation = z.infer<typeof planLimitViolationSchema>;
