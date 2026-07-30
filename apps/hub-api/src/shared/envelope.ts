/**
 * Envelope de resposta do `Docs/06`.
 *
 * Sucesso é sempre `{ data, meta: { requestId } }` — inclusive quando `data` é
 * um objeto vazio. Uniformidade aqui vale mais que economia de bytes: o cliente
 * tem um único caminho de leitura, e `requestId` acompanha toda resposta, o que
 * transforma um relato de bug em uma busca no log.
 */

import type { FastifyRequest } from 'fastify';

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly meta: { readonly requestId: string };
}

export function envelope<T>(requestId: string, data: T): SuccessEnvelope<T> {
  return { data, meta: { requestId } };
}

/** Atalho para o handler: `return ok(request, payload)`. */
export function ok<T>(request: FastifyRequest, data: T): SuccessEnvelope<T> {
  return envelope(request.id, data);
}

/** Comando sem corpo útil. */
export function okEmpty(request: FastifyRequest): SuccessEnvelope<Record<string, never>> {
  return envelope(request.id, {});
}
