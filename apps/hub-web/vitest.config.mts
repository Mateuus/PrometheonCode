import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // O Vite resolve os `paths` do tsconfig nativamente; o plugin equivalente
  // varria o repositório inteiro atrás de tsconfigs de terceiros.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // O Playwright vive em `e2e/` e roda por `pnpm test:e2e`.
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
  },
});
