import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/** O `eslint-config-next` 16 já publica flat config; não há `FlatCompat` no meio. */
const spread = (config) => (Array.isArray(config) ? config : [config]);

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'playwright-report/**', 'test-results/**'],
  },
  ...spread(nextCoreWebVitals),
  ...spread(nextTypescript),
  {
    rules: {
      // O produto guarda credencial só em cookie HttpOnly; a regra existe para
      // que uma regressão apareça no lint, não só na revisão.
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Nenhuma credencial ou dado de sessão no localStorage (Docs/05).',
        },
        {
          name: 'sessionStorage',
          message: 'Nenhuma credencial ou dado de sessão no sessionStorage (Docs/05).',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];

export default config;
