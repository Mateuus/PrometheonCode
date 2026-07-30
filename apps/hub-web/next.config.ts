import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import type { NextConfig } from 'next';

// O monorepo mantém um único `.env` na raiz. O Next só lê o `.env` da pasta do
// app, então carregamos o da raiz aqui — antes de qualquer código do app rodar.
const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(appDir, '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

/**
 * Cabeçalhos de segurança fixos. A `Content-Security-Policy` não está aqui: ela
 * depende de um nonce por requisição e é montada no middleware.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `sharp` não roda seus scripts de instalação no workspace; nenhuma tela usa
  // otimização de imagem remota, então o otimizador fica desligado.
  images: { unoptimized: true },
  typedRoutes: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
