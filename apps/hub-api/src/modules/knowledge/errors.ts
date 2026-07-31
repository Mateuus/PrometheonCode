/** Erros do módulo de conhecimento. */

import { badRequest, conflict, forbidden, notFound, type ApiError } from '../../shared/errors.js';

export function knowledgeNotFound(): ApiError {
  return notFound('KNOWLEDGE_NOT_FOUND', 'This knowledge item does not exist.');
}

export function projectNotFound(): ApiError {
  return notFound('PROJECT_NOT_FOUND', 'This project does not exist.');
}

export function noPendingVersion(): ApiError {
  return conflict(
    'KNOWLEDGE_NO_PENDING_VERSION',
    'There is no version awaiting review for this knowledge item.',
  );
}

export function reviewConflict(): ApiError {
  return conflict(
    'KNOWLEDGE_REVIEW_CONFLICT',
    'This knowledge item changed since you read it. Reload the diff and review again.',
  );
}

/**
 * Aprovação sem procedência.
 *
 * O `Docs/10` exige que toda proposta traga fontes e que cada fonte seja
 * marcada como extraída ou inferida. Aprovar uma afirmação sem isso a
 * transforma em fato oficial que ninguém consegue rastrear — e conhecimento
 * inferido apresentado como fato é como um grafo envenena as decisões do time.
 */
export function provenanceRequired(): ApiError {
  return badRequest(
    'KNOWLEDGE_PROVENANCE_REQUIRED',
    'This version has no declared source. Add at least one source, marked as extracted or inferred, before approving it.',
    {
      fields: [{ path: 'sources', message: 'at least one declared source is required to approve' }],
    },
  );
}

/**
 * Quem propôs não carimba a própria proposta.
 *
 * Revisar é ler o que outra pessoa escreveu. Autoaprovação só é aceitável para
 * quem tem `knowledge.approve` — e ainda assim fica registrada como tal na
 * auditoria e em `knowledge_reviews`.
 */
export function selfApprovalDenied(): ApiError {
  return forbidden(
    'You proposed this version. Approving your own proposal requires the knowledge.approve permission.',
  );
}
