import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Filesystem tests create and tear down real temp dirs; keep files isolated
    // in separate forks so a leaked cwd/umask in one file cannot poison another.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/platform/**/*.ts'],
      exclude: ['src/platform/__tests__/**'],
    },
  },
})
