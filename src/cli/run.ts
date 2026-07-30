/**
 * The dispatcher.
 *
 * `run(argv, deps)` is the whole CLI as a function: it takes an argument
 * vector and an injected environment, and returns an exit code. It never calls
 * `process.exit`, never reads `process.argv`, and never writes to a stream it
 * was not handed. `main.ts` is the only file that knows those things exist.
 *
 * That shape is what lets the test suite drive every command, every exit code
 * and every byte of output without spawning anything.
 */

import type { CliDeps } from './deps.js'
import type { CommandSpec, ParsedArgs } from './args.js'
import { boolFlag, parse } from './args.js'
import { makeContext, type Ctx } from './context.js'
import { CliError, EXIT, UsageError, type ExitCode } from './exit.js'
import { helpJson, helpSpec, renderCommandHelp, renderTopLevelHelp, versionSpec } from './help.js'

import { initCommand, initSpec } from './commands/init.js'
import { statusCommand, statusSpec } from './commands/status.js'
import { diffCommand, diffSpec } from './commands/diff.js'
import { applyCommand, applySpec } from './commands/apply.js'
import { rollbackCommand, rollbackSpec } from './commands/rollback.js'
import { doctorCommand, doctorSpec } from './commands/doctor.js'
import { devicesCommand, devicesSpec } from './commands/devices.js'

export const COMMANDS: Record<string, CommandSpec> = {
  init: initSpec,
  status: statusSpec,
  diff: diffSpec,
  apply: applySpec,
  rollback: rollbackSpec,
  doctor: doctorSpec,
  devices: devicesSpec,
  help: helpSpec,
  version: versionSpec,
}

type Handler = (ctx: Ctx) => Promise<number>

const HANDLERS: Record<string, Handler> = {
  init: initCommand,
  status: statusCommand,
  diff: diffCommand,
  apply: applyCommand,
  rollback: rollbackCommand,
  doctor: doctorCommand,
  devices: devicesCommand,
}

export async function run(argv: string[], deps: CliDeps): Promise<ExitCode> {
  const parsed = parse(argv, { commands: COMMANDS, defaultCommand: 'help' })

  if (!parsed.ok) {
    // A usage error has no context yet — build a minimal one so the message
    // still honours --json and --no-color if those tokens parsed.
    const ctx = makeContext(deps, { command: 'help', positionals: [], flags: shallowFlags(argv), argv })
    reportError(ctx, parsed.error)
    return EXIT.USAGE
  }

  const args = parsed.value
  const ctx = makeContext(deps, args)

  try {
    if (boolFlag(args, 'version') || args.command === 'version') {
      if (ctx.json) ctx.emit({ ok: true, command: 'version', exitCode: EXIT.OK, version: deps.version })
      else ctx.out(deps.version)
      return EXIT.OK
    }

    if (args.command === 'help' || boolFlag(args, 'help')) {
      return renderHelp(ctx, args)
    }

    const handler = HANDLERS[args.command]
    if (!handler) {
      throw new UsageError(`Command "${args.command}" has no handler.`, {
        hint: 'This is a bug in agentsync — please report it.',
      })
    }

    const code = await handler(ctx)
    return normalizeExit(code)
  } catch (err) {
    reportError(ctx, err)
    return err instanceof CliError ? err.code : EXIT.ERROR
  }
}

// ---------------------------------------------------------------------------

function renderHelp(ctx: Ctx, args: ParsedArgs): ExitCode {
  // `agentsync help diff` and `agentsync diff --help` are the same request.
  const topic = args.command === 'help' ? args.positionals[0] : args.command
  const spec = topic !== undefined ? COMMANDS[topic] : undefined

  if (ctx.json) {
    if (spec) {
      ctx.emit({
        ok: true,
        command: 'help',
        exitCode: EXIT.OK,
        topic: spec.name,
        summary: spec.summary,
        usage: spec.usage,
        flags: spec.flags,
        positionals: spec.positionals ?? [],
      })
    } else {
      ctx.emit(helpJson(COMMANDS, ctx.deps.version))
    }
    return EXIT.OK
  }

  if (spec && spec.name !== 'help') renderCommandHelp(ctx, spec)
  else renderTopLevelHelp(ctx, COMMANDS)
  return EXIT.OK
}

/**
 * Best-effort flag extraction for the pre-parse error path. Only recognises the
 * two flags that change how an error is *presented*, so a broken command line
 * still respects `--json` and `--no-color`.
 */
function shallowFlags(argv: string[]): Record<string, boolean> {
  const flags: Record<string, boolean> = {}
  for (const t of argv) {
    if (t === '--json') flags['json'] = true
    if (t === '--no-color') flags['color'] = false
    if (t === '--color') flags['color'] = true
  }
  return flags
}

export function reportError(ctx: Ctx, err: unknown): void {
  const s = ctx.style
  const isCli = err instanceof CliError
  const message = err instanceof Error ? err.message : String(err)
  const code: ExitCode = isCli ? err.code : EXIT.ERROR
  const hint = isCli ? err.hint : undefined
  const details = isCli ? err.details : []

  if (ctx.json && !ctx.emitted()) {
    ctx.emit({
      ok: false,
      command: ctx.args.command,
      exitCode: code,
      error: {
        name: err instanceof Error ? err.name : 'Error',
        message,
        hint: hint ?? null,
        details,
      },
    })
  }

  // Diagnostics always go to stderr, including in --json mode: a script reading
  // stdout gets clean JSON, and a human watching the terminal still sees why.
  ctx.err(`${s.red(`${ctx.sym.fail} ${isCli ? '' : 'Unexpected error: '}`)}${message}`)
  for (const d of details) ctx.err(`    ${s.gray(d)}`)
  if (hint) ctx.err(`  ${s.cyan(ctx.sym.arrow)} ${hint}`)

  if (!isCli) {
    ctx.err(
      `  ${s.gray('This one was not anticipated. Re-run with --verbose for a stack trace, and please report it.')}`,
    )
    if (ctx.verbose && err instanceof Error && err.stack) {
      ctx.err(s.gray(err.stack))
    }
  } else if (ctx.verbose && err.cause instanceof Error && err.cause.stack) {
    ctx.err(s.gray(err.cause.stack))
  }
}

function normalizeExit(code: number): ExitCode {
  switch (code) {
    case EXIT.OK:
    case EXIT.ERROR:
    case EXIT.USAGE:
    case EXIT.NOTHING_TO_DO:
    case EXIT.BLOCKED_BY_PROVENANCE:
      return code
    default:
      // A handler returning something outside the contract is a bug; failing
      // loudly beats a script silently branching on an undocumented number.
      return EXIT.ERROR
  }
}
