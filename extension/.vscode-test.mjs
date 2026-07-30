import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Workspace descartável para os testes que tocam o disco.
 *
 * O `.git` vazio é intencional: faz a detecção de repositório passar, para que a
 * inicialização não abra o diálogo modal do Git durante os testes. O `.gitignore`
 * já vem com conteúdo para provarmos que ele é preservado.
 */
const fixture = join(import.meta.dirname, '.vscode-test', 'fixture');
rmSync(fixture, { recursive: true, force: true });
mkdirSync(join(fixture, '.git'), { recursive: true });
writeFileSync(join(fixture, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');

export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: fixture,
  mocha: {
    timeout: 20_000,
  },
});
