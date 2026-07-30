import { defineConfig } from 'vitest/config'

/**
 * The cross-OS conformance suite, run on its own.
 *
 * It needs a separate config rather than a path filter because the default
 * config EXCLUDES it — and an exclude wins over an explicitly named file, so
 * `vitest run <path>` finds nothing. Keeping the two configs apart is also the
 * honest shape: this suite asserts real syscall behaviour on a real OS, and it
 * is expected to be mostly skipped anywhere but its target platform.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/platform/__tests__/conformance.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
