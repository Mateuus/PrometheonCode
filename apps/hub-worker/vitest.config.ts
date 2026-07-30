// Configuração do Vitest do worker.
//
// Os testes conversam com MySQL e Redis de verdade: criam banco descartável,
// migram, usam um prefixo de chave próprio e limpam tudo no final. Isso é mais
// lento que teste unitário — daí os limites folgados — e roda em arquivo único
// (`fileParallelism: false`) para não abrir vários bancos temporários ao mesmo
// tempo no servidor compartilhado.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 180_000,
  },
});
