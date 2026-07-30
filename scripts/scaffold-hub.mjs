#!/usr/bin/env node
// Gera os package.json e tsconfig.json dos pacotes do Hub.
//
// Existe para que todos nasçam com a mesma configuração: o mesmo alvo de
// TypeScript, os mesmos scripts e o mesmo estilo de exports. Rodar de novo
// sobrescreve apenas esses dois arquivos por pacote — o código-fonte não é
// tocado.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependências entre pacotes; o resto cada um declara por conta. */
const PACKAGES = [
  { dir: 'packages/config', name: '@prometheon/config', deps: ['zod'] },
  { dir: 'packages/logger', name: '@prometheon/logger', deps: ['pino'] },
  { dir: 'packages/contracts', name: '@prometheon/contracts', deps: ['zod'] },
  {
    dir: 'packages/database',
    name: '@prometheon/database',
    deps: ['typeorm', 'mysql2'],
    scripts: {
      'db:migrate': 'tsx src/migrate.ts',
      'db:seed': 'tsx src/seed.ts',
    },
  },
  { dir: 'packages/permissions', name: '@prometheon/permissions', deps: [] },
  { dir: 'packages/testing', name: '@prometheon/testing', deps: [] },
];

const APPS = [
  { dir: 'apps/hub-api', name: '@prometheon/hub-api' },
  { dir: 'apps/hub-worker', name: '@prometheon/hub-worker' },
];

const workspaceVersion = 'workspace:*';

function packageJson({ name, deps = [], scripts = {}, isApp = false }) {
  const dependencies = Object.fromEntries(
    deps.map((dependency) =>
      dependency.startsWith('@prometheon/')
        ? [dependency, workspaceVersion]
        : [dependency, 'latest'],
    ),
  );
  return {
    name,
    version: '0.0.1',
    private: true,
    type: 'module',
    ...(isApp
      ? { main: './dist/server.js' }
      : {
          exports: {
            '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          },
          types: './dist/index.d.ts',
        }),
    scripts: {
      build: 'tsc -b',
      typecheck: 'tsc --noEmit',
      test: 'vitest run --passWithNoTests',
      ...scripts,
    },
    dependencies,
    devDependencies: {},
  };
}

function tsconfig(dir) {
  return {
    extends: `${relative(join(root, dir), root).replace(/\\/g, '/')}/tsconfig.base.json`,
    compilerOptions: {
      rootDir: './src',
      outDir: './dist',
      tsBuildInfoFile: './dist/.tsbuildinfo',
    },
    include: ['src/**/*.ts'],
  };
}

let created = 0;
for (const entry of [...PACKAGES, ...APPS.map((app) => ({ ...app, isApp: true }))]) {
  const target = join(root, entry.dir);
  mkdirSync(join(target, 'src'), { recursive: true });
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(packageJson(entry), null, 2)}\n`,
  );
  writeFileSync(
    join(target, 'tsconfig.json'),
    `${JSON.stringify(tsconfig(entry.dir), null, 2)}\n`,
  );
  created += 1;
  console.log(`ok  ${entry.dir}  ${entry.name}`);
}
console.log(`\n${created} pacotes preparados.`);
