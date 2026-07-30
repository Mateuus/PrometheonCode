// `@prometheon/database` — entidades TypeORM, migrations, outbox e seed do Hub.
//
// Quem consome (hub-api, hub-worker) importa daqui: as entidades tipadas, o
// `DataSource` já configurado em UTC/utf8mb4, o gerador de ULID e as consultas
// do outbox. Tipos de banco não devem vazar para contratos públicos (`Docs/03`):
// mapeie para os tipos de `@prometheon/contracts` na fronteira.

export * from './entities/index.js';
export * from './client.js';
export * from './id.js';
export * from './outbox.js';
export * from './permissions.js';
export { MIGRATIONS } from './migrations/index.js';
export { runMigrations, type MigrationResult } from './migrate.js';
export { runSeed, seedDatabase, type SeedResult } from './seed.js';
export { readDatabaseEnv, readSecretsMasterKey, envValue, type DatabaseEnv } from './env.js';
