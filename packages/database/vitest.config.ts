// Configuração do Vitest.
//
// Os testes que precisam de MySQL criam e derrubam um banco próprio, o que leva
// mais tempo que um teste unitário — daí os limites folgados. Eles rodam em
// arquivo único (`fileParallelism: false`) para não abrir vários bancos
// temporários ao mesmo tempo no servidor compartilhado.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
