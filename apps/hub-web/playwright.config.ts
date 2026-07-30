import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.HUB_WEB_PORT ?? 3550);
const baseURL = process.env.HUB_WEB_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // Usa o Edge já instalado na máquina em vez de baixar um Chromium próprio.
  projects: [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
  // Sobe o próprio dev server. Enquanto a Hub API não existe, o app roda em modo
  // de dados de exemplo (ver `src/lib/api/README-provisorio` no código).
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
