/**
 * Utilidades compartilhadas de teste do Hub.
 *
 * O objetivo é um só: testes que tocam MySQL e Redis precisam de um lugar
 * descartável para trabalhar, e precisam sumir do servidor quando terminam. Sem
 * isso, cada suíte inventa seu próprio banco temporário e o servidor de
 * desenvolvimento vira um cemitério de `*_test_1730`.
 *
 * Nada aqui depende de framework de teste: são funções chamadas de `beforeAll`
 * e `afterAll`, sirva qual for o runner.
 */

export {
  createDisposableDatabase,
  type DisposableDatabase,
} from './database.js';

export { createDisposableRedis, type DisposableRedis } from './redis.js';

export { servicesAvailable, describeUnavailable, type ServiceStatus } from './availability.js';
