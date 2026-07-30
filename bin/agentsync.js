#!/usr/bin/env node
/**
 * `agentsync` entry point.
 *
 * Plain JavaScript, outside `rootDir`, so `tsc` never compiles it and the file
 * npm installs as a bin is the file that is checked in. It does two things:
 * find the compiled CLI, and say something useful when it is not there.
 *
 * The dist path is resolved as a URL relative to this module rather than by
 * joining `__dirname`, which keeps it correct on Windows (where a joined path
 * with backslashes is not a valid ESM specifier).
 */

import { existsSync } from 'node:fs'

const entry = new URL('../dist/cli/main.js', import.meta.url)

if (!existsSync(entry)) {
  process.stderr.write(
    'agentsync: the compiled CLI is missing (expected dist/cli/main.js).\n' +
      '  → Run `npm run build` in this checkout, then try again.\n',
  )
  process.exit(1)
}

const { main } = await import(entry.href)
await main(process.argv.slice(2))
