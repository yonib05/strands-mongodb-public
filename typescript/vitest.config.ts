import { defineConfig } from 'vitest/config'

const tier = (name: string) => ({
  extends: true,
  test: {
    name,
    include: [`test/integ/${name}/**/*.test.ts`],
    fileParallelism: false,
    testTimeout: 180_000,
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
