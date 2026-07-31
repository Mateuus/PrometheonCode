/** Schemas das rotas de papéis de agente. */

import {
  agentRoleListSchema,
  agentRoleSchema,
  errorEnvelopeSchema,
  replaceAgentRolesSchema,
  successEnvelope,
  ulidSchema,
} from '@prometheon/contracts';
import { z } from 'zod';

export { replaceAgentRolesSchema };

export const organizationParamsSchema = z.object({ orgId: ulidSchema });

export const agentRoleEnvelope = successEnvelope(agentRoleSchema);

/**
 * Lista simples em vez de página com cursor: o limite de sessenta papéis é o
 * mesmo da extensão, e paginar sessenta itens só acrescentaria um estado que
 * ninguém precisa carregar.
 */
export const agentRoleListEnvelope = successEnvelope(agentRoleListSchema);

export const agentRoleErrorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
} as const;
