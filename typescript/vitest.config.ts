import { defineConfig } from 'vitest/config'

const tier = (name: string) => ({
  extends: true,
  test: {
    name,
    include: [`test/integ/${name}/**/*.test.ts`],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})

export default defineConfig({
  test: {
    unstubEnvs: true,
    restoreMocks: true,
    setupFiles: ['./test/setup.ts'],
    reporters: ['default', './test/gate/reporter.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.test.ts', 'test/__tests__/**/*.test.ts'],
          // A cold import under load outlasts the 5 s default.
          testTimeout: 20_000,
        },
      },
      tier('contract'),
      tier('integration'),
      tier('autoembed'),
      tier('interop'),
      {
        extends: true,
        test: { name: 'build', include: ['test/build/**/*.test.ts'], testTimeout: 600_000, hookTimeout: 600_000 },
      },
      { extends: true, test: { name: 'compat', include: ['test/compat/**/*.test.ts'] } },
      // Subprocess tests of the examples, the README snippets and the scripts, kept out of `unit` so that stays fast.
      {
        extends: true,
        test: { name: 'docs', include: ['test/docs/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000 },
      },
      { extends: true, test: { name: 'gate', include: ['test/gate/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/__fixtures__/**'],
      // The 70% per-file floor is scripts/check-file-coverage.mjs.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
})
