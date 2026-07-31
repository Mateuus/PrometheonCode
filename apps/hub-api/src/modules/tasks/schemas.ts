/** Schemas das rotas de tarefa. */

import {
  claimTaskRequestSchema,
  createTaskRequestSchema,
  errorEnvelopeSchema,
  releaseTaskRequestSchema,
  successEnvelope,
  taskListQuerySchema,
  taskPageSchema,
  taskSchema,
  ulidSchema,
  updateTaskRequestSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export {
  claimTaskRequestSchema,
  createTaskRequestSchema,
  releaseTaskRequestSchema,
  taskListQuerySchema,
  updateTaskRequestSchema,
};

export const projectParamsSchema = z.object({ projectId: ulidSchema });

export const taskParamsSchema = z.object({ taskId: ulidSchema });

export const taskEnvelope = successEnvelope(taskSchema);

export const taskPageEnvelope = successEnvelope(taskPageSchema);

export const taskErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
