// Contratos dos jobs.
//
// Toda fronteira valida em runtime (`Docs/03`), e a fila é uma fronteira: o
// payload foi serializado por outro processo, talvez de outra versão. Payload
// que não passa no schema é **falha permanente** — repetir não conserta um
// corpo malformado, então ele vai direto para a dead-letter em vez de ocupar as
// oito tentativas da fila.
//
// Os schemas ficam aqui, e não em `@prometheon/contracts`, porque não são
// contrato público da API: são o acordo interno entre quem enfileira e quem
// processa.

import { z } from 'zod';

/** ULID em maiúsculas, como o `newId()` do pacote de banco gera. */
export const ulidSchema = z
  .string()
  .length(26)
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID inválido');

/**
 * Campos comuns a todo job: correlação obrigatória (`Docs/11` pede correlação
 * por `requestId`/`organizationId`/`projectId`) e o instante do pedido.
 */
export const jobEnvelopeSchema = z.object({
  /** Atravessa API, worker e log; é o fio que liga o job ao pedido original. */
  correlationId: z.string().min(1).max(64),
  organizationId: ulidSchema.optional(),
  projectId: ulidSchema.nullish(),
  /** Quem pediu: usuário, agente ou o próprio sistema. */
  requestedBy: ulidSchema.nullish(),
  requestedAt: z.iso.datetime().optional(),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

/** `webhooks`: processar uma entrega já recebida e persistida pela API. */
export const webhookJobSchema = jobEnvelopeSchema.extend({
  organizationId: ulidSchema,
  /** Linha de `webhook_deliveries`. */
  deliveryId: ulidSchema,
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'azure_devops']),
  eventType: z.string().min(1).max(96),
  /** ID da entrega no provedor: é a chave natural de deduplicação. */
  externalDeliveryId: z.string().min(1).max(191),
});

export type WebhookJob = z.infer<typeof webhookJobSchema>;

/** `notifications`: uma notificação para um destinatário. */
export const notificationJobSchema = jobEnvelopeSchema.extend({
  organizationId: ulidSchema,
  channel: z.enum(['email', 'in_app', 'webhook']),
  template: z.string().min(1).max(96),
  recipientUserId: ulidSchema.nullish(),
  recipientAddress: z.string().min(1).max(320).nullish(),
  /** Variáveis do template. Nada de segredo aqui. */
  variables: z.record(z.string(), z.unknown()).default({}),
});

export type NotificationJob = z.infer<typeof notificationJobSchema>;

/** `context-summarization`: resumir uma camada de contexto de uma conversa. */
export const contextSummarizationJobSchema = jobEnvelopeSchema.extend({
  organizationId: ulidSchema,
  conversationId: ulidSchema,
  /** Camadas do `Docs/10`. */
  layer: z.enum(['recent', 'rolling', 'session', 'project']),
  /** Última mensagem coberta pelo resumo pedido. */
  upToMessageId: ulidSchema.nullish(),
});

export type ContextSummarizationJob = z.infer<typeof contextSummarizationJobSchema>;

/** `knowledge-indexing`: reindexar um item de conhecimento. */
export const knowledgeIndexingJobSchema = jobEnvelopeSchema.extend({
  organizationId: ulidSchema,
  knowledgeItemId: ulidSchema,
  reason: z.enum(['created', 'updated', 'reviewed', 'deleted', 'backfill']),
});

export type KnowledgeIndexingJob = z.infer<typeof knowledgeIndexingJobSchema>;

/** `retention`: aplicar a política de retenção. */
export const retentionJobSchema = jobEnvelopeSchema.extend({
  /** Ausente significa "todas as organizações". */
  organizationId: ulidSchema.optional(),
  /** Só relata o que apagaria. Útil para conferir política nova. */
  dryRun: z.boolean().default(false),
  /** Linhas por `DELETE`, para não segurar lock longo em tabela grande. */
  batchSize: z.int().min(1).max(10_000).default(1_000),
  /** Teto de linhas por tabela numa execução; o resto fica para a próxima. */
  maxRowsPerTable: z.int().min(1).max(1_000_000).default(50_000),
});

export type RetentionJob = z.infer<typeof retentionJobSchema>;

/** `exports`: materializar um `data_export_jobs`. */
export const exportJobSchema = jobEnvelopeSchema.extend({
  organizationId: ulidSchema,
  exportJobId: ulidSchema,
});

export type ExportJob = z.infer<typeof exportJobSchema>;

/** `deletions`: executar um `deletion_jobs` vencido. */
export const deletionJobSchema = jobEnvelopeSchema.extend({
  organizationId: ulidSchema,
  deletionJobId: ulidSchema,
});

export type DeletionJob = z.infer<typeof deletionJobSchema>;

/** Origem do registro na dead-letter: uma fila BullMQ ou o outbox. */
export const deadLetterSourceSchema = z.enum(['queue', 'outbox']);

/** `dead-letter`: o que sobrou de um job ou evento abandonado. */
export const deadLetterJobSchema = jobEnvelopeSchema.extend({
  source: deadLetterSourceSchema,
  /** Fila de origem, ou `outbox`. */
  origin: z.string().min(1).max(64),
  /** `jobId` do BullMQ ou ID da mensagem do outbox. */
  originId: z.string().min(1).max(191),
  jobName: z.string().min(1).max(96).nullish(),
  attemptsMade: z.int().nonnegative(),
  /** `true` quando a falha foi permanente; `false` quando esgotou tentativas. */
  permanent: z.boolean(),
  errorCode: z.string().min(1).max(96),
  errorMessage: z.string().max(4_000),
  failedAt: z.iso.datetime(),
  /** Payload original, guardado para reprocessar depois da correção. */
  payload: z.unknown().optional(),
});

export type DeadLetterJob = z.infer<typeof deadLetterJobSchema>;
