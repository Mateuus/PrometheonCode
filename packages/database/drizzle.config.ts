// Configuração do Drizzle Kit.
//
// As migrations são artefatos versionados em `drizzle/`: `db:generate` compara
// o schema TypeScript com o snapshot e escreve o SQL. Nada é gerado em runtime
// — o runner só aplica o que está commitado.

import { defineConfig } from 'drizzle-kit';

import { readDatabaseEnv } from './src/env.js';

const env = readDatabaseEnv();

export default defineConfig({
  dialect: 'mysql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  dbCredentials: {
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
  },
});
