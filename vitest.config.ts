import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // The conformance suite is OS-gated: most of it `describe.runIf`s itself
    // away except on its target platform. Leaving it in the default run meant
    // the `unit` job on Linux failed for a Linux-only reason, masking whatever
    // the dedicated `conformance / linux` job would have said. It runs from its
    // own CI jobs, by explicit path.
    exclude: ['**/node_modules/**', 'src/platform/__tests__/conformance.test.ts'],
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
