// Lint dos pacotes do Hub (apps/ e packages/).
//
// A extensão do VS Code tem a própria configuração em extension/eslint.config.mjs:
// ela está fora do workspace pnpm e usa outro alvo de compilação. Unificar as
// duas é assunto de quando a extensão migrar para cá.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'extension/**',
      'scripts/**',
      // Tem configuração própria: Next.js exige plugins que ainda dependem do
      // ESLint 9, enquanto a raiz já usa a 10.
      'apps/hub-web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // O projeto inteiro trata a fronteira com o mundo externo como `unknown` e
      // valida em runtime; um `any` aqui apaga justamente essa garantia.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_' },
      ],
      // Promise ignorada é erro silencioso: o processo segue como se tivesse dado
      // certo. Marcar com `void` quando o descarte for intencional.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Ler `raw['type']` de um índice é o estilo do projeto na fronteira com
      // dados externos, e deixa explícito que o campo pode não existir.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // Número em template não tem armadilha de formatação; objeto e nulo têm.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Desligada de propósito: o projeto usa `noUncheckedIndexedAccess`, então o
      // compilador já obriga a encarar todo acesso indexado. Proibir `!` em cima
      // disso só empurra para alternativas mais verbosas sem ganho de segurança
      // — em `ENCODING[mod]`, com `mod` calculado por módulo, não há caso nulo.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Testes e arquivos de configuração ficam fora do `tsconfig.json` de build,
    // então o lint com informação de tipo não consegue analisá-los. Aqui valem
    // as regras sintáticas, que é o que faz diferença nesses arquivos.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.ts', '**/*.config.mts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Ferramentas de linha de comando falam com a pessoa pelo stdout: é a
    // interface delas, não um `console.log` esquecido.
    files: ['**/src/seed.ts', '**/src/migrate.ts', '**/src/cli/**'],
    rules: { 'no-console': 'off' },
  },
);
