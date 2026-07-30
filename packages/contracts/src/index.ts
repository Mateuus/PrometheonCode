/**
 * `@prometheon/contracts` — contratos públicos da Hub API em Zod.
 *
 * Este pacote não conhece banco nem framework (regra do `Docs/03`): só define a
 * forma dos dados que atravessam a fronteira e valida em runtime nos dois lados.
 *
 * Convenções: identificador é ULID em string, data é ISO 8601 UTC e dinheiro é
 * inteiro na menor unidade da moeda.
 */

export const API_VERSION = 'v1';
export const API_PREFIX = '/v1';

export * from './audit.js';
export * from './auth.js';
export * from './billing.js';
export * from './conversations.js';
export * from './devices.js';
export * from './envelope.js';
export * from './health.js';
export * from './knowledge.js';
export * from './messages.js';
export * from './organizations.js';
export * from './pagination.js';
export * from './permissions.js';
export * from './primitives.js';
export * from './projects.js';
export * from './realtime.js';
export * from './tasks.js';
