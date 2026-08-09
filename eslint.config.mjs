import { defineConfig, globalIgnores } from 'eslint/config'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import typescriptEslint from 'typescript-eslint'

const nextWithMigrationWarnings = nextCoreWebVitals.map((config) =>
  config.plugins?.['react-hooks']
    ? {
        ...config,
        rules: {
          ...config.rules,
          // React 19's compiler-oriented rules were not part of the previous
          // Next 14 lint gate. Keep them visible during incremental cleanup
          // without turning a framework security upgrade into a 200-file rewrite.
          'react-hooks/set-state-in-effect': 'warn',
          'react-hooks/refs': 'warn',
          'react-hooks/purity': 'warn',
          'react-hooks/preserve-manual-memoization': 'warn',
          'react-hooks/immutability': 'warn',
          'react-hooks/use-memo': 'warn',
        },
      }
    : config,
)

export default defineConfig([
  ...nextWithMigrationWarnings,
  ...typescriptEslint.configs.recommended,
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/out/**',
    '**/build/**',
    '**/dist/**',
    'prisma/migrations/**',
    'public/**',
    'android/**',
    'ios/**',
    'worker/node_modules/**',
    'scripts/**',
    '**/*.config.js',
    '**/*.config.mjs',
    'next-env.d.ts',
  ]),
  {
    rules: {
      'no-empty-pattern': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
])
