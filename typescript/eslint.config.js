import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import tsdoc from 'eslint-plugin-tsdoc'

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  structuredClone: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
}

const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  {
    rules: {
      // TypeScript reports redeclarations itself and understands value/type merging.
      'no-redeclare': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'examples/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { projectService: true },
      globals: nodeGlobals,
    },
    plugins: {
      '@typescript-eslint': tseslint,
      tsdoc,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': unusedVars,
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'tsdoc/syntax': 'error',
      // The type-aware rules a database library needs: a dropped promise is a write nobody waited for.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/__fixtures__/**', 'test/**/*.ts', 'examples/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['test/build/fixtures/**/*.js'],
    languageOptions: {
      globals: { ...nodeGlobals, require: 'readonly' },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': unusedVars,
    },
  },
]
