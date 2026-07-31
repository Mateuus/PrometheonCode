/** Erros do módulo de mensagens. */

import { badRequest, type ApiError } from '../../shared/errors.js';

/**
 * Resumo operacional longo demais.
 *
 * O `Docs/07` proíbe gravar raciocínio privado de modelo e admite apenas o
 * resumo operacional permitido. O teto é a parte mecânica dessa regra: um
 * resumo é curto por definição, e um texto de dezenas de milhares de caracteres
 * chamado de "resumo" é, na prática, a cadeia de raciocínio bruta.
 */
export function reasoningSummaryTooLong(limit: number, index: number): ApiError {
  return badRequest(
    'VALIDATION_FAILED',
    'A reasoning summary must stay an operational summary. Raw model reasoning is never stored.',
    {
      fields: [
        {
          path: `parts.${String(index)}.summary`,
          message: `must be at most ${String(limit)} characters`,
        },
      ],
    },
  );
}

/** Somente mensagem de agente carrega resumo de raciocínio. */
export function reasoningSummaryRequiresAgent(index: number): ApiError {
  return badRequest(
    'VALIDATION_FAILED',
    'Only agent messages carry a reasoning summary.',
    {
      fields: [
        { path: `parts.${String(index)}.type`, message: 'requires authorType "agent"' },
      ],
    },
  );
}

export function agentRunRequired(): ApiError {
  return badRequest('VALIDATION_FAILED', 'An agent message must name the agent run.', {
    fields: [{ path: 'authorAgentRunId', message: 'is required when authorType is "agent"' }],
  });
}

/**
 * Anexo referenciado antes de existir.
 *
 * `message_attachments.message_id` é obrigatório, então o anexo nasce junto da
 * mensagem — não há como referenciar um que já esteja no servidor enquanto a
 * rota de upload não existir. Recusar é melhor que aceitar e perder o anexo.
 */
export function attachmentsNotSupported(): ApiError {
  return badRequest(
    'VALIDATION_FAILED',
    'Attachment upload is not available yet, so attachments cannot be referenced.',
    { fields: [{ path: 'attachmentIds', message: 'must be empty' }] },
  );
}
