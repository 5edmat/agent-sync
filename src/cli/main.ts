/**
 * The process boundary.
 *
 * The only file allowed to know about `process`. Everything below it takes an
 * injected `CliDeps`, which is what makes the whole CLI testable in-process.
 */

import { nodeDeps } from './deps.js'
import { run } from './run.js'
import { EXIT } from './exit.js'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // `agentsync diff | head` closes the pipe under us. Crashing with EPIPE at
  // that point would be a bug report about a command that worked perfectly.
  const swallowEpipe = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EPIPE') throw err
  }
  process.stdout.on('error', swallowEpipe)
  process.stderr.on('error', swallowEpipe)

  const deps = await nodeDeps()

  let code: number
  try {
    code = await run(argv, deps)
  } catch (err) {
    // run() catches its own errors; reaching here means the failure was in
    // dependency construction or in the error reporter itself.
    process.stderr.write(`agentsync: ${(err as Error).message}\n`)
    code = EXIT.ERROR
  }

  // Set exitCode rather than calling exit(): stdout may still be flushing, and
  // process.exit() truncates it. Node exits with this code once the loop drains.
  process.exitCode = code
  return code
}
