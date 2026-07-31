import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Os testes de integração criam bancos descartáveis e falam com o Redis
    // real. Rodá-los em paralelo multiplicaria conexões sem ganho algum.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      // O log da aplicação não ajuda a ler a saída do teste; a suíte que
      // precisa dele liga por conta própria.
      LOG_LEVEL: 'silent',
      // Rate limit desligado por padrão: com ele ligado, uma suíte contamina a
      // seguinte pelo balde compartilhado no Redis. `rate-limit.test.ts` liga
      // explicitamente.
      RATE_LIMIT_ENABLED: 'false',
    },
  },
});
