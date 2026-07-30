/**
 * The per-invocation context every command receives.
 *
 * The stream discipline is enforced here rather than trusted to each command:
 *
 *   ctx.out   human output           -> stdout
 *   ctx.err   diagnostics, prompts   -> stderr
 *   ctx.emit  the JSON document      -> stdout, exactly once, and only in --json
 *
 * `--json` silences `ctx.out` entirely. That is the property that makes
 * `agentsync status --json | jq` safe: there is no way for a stray human line
 * to end up interleaved with the document, because the human channel is closed.
 */

import type { ParsedArgs } from './args.js'
import { boolFlag, stringFlag, triStateFlag } from './args.js'
import type { CliDeps } from './deps.js'
import {
  decideColor,
  decideUnicode,
  makeStyle,
  symbolsFor,
  type ColorDecision,
  type Style,
  type Symbols,
  type UnicodeDecision,
} from './ansi.js'

export interface Ctx {
  deps: CliDeps
  args: ParsedArgs
  json: boolean
  quiet: boolean
  verbose: boolean
  style: Style
  sym: Symbols
  color: ColorDecision
  unicode: UnicodeDecision
  /** Effective working directory (`--cwd` or the process's). */
  cwd: string
  /** `--state-dir`, or `AGENTSYNC_STATE_DIR`, or undefined for the OS default. */
  stateDirOverride: string | undefined
  /** Human output. Silenced by `--json`. */
  out(line?: string): void
  /** Non-essential human output: tips, next steps, separators. Silenced by `--quiet` too. */
  note(line?: string): void
  err(line?: string): void
  emit(payload: Record<string, unknown>): void
  /** True once `emit` has run, so error handling never doubles the document. */
  emitted(): boolean
}

export function makeContext(deps: CliDeps, args: ParsedArgs): Ctx {
  const json = boolFlag(args, 'json')
  const quiet = boolFlag(args, 'quiet')
  const verbose = boolFlag(args, 'verbose')

  const color = decideColor({
    env: deps.env,
    isTTY: deps.io.stdoutIsTTY,
    flag: triStateFlag(args, 'color'),
  })
  // Colour is never emitted in --json: the consumer is a parser, and an escape
  // sequence inside a JSON string is a corrupted field, not a styled one.
  const style = makeStyle(color.enabled && !json)
  const unicode = decideUnicode(deps.env, deps.platform)

  let didEmit = false

  return {
    deps,
    args,
    json,
    quiet,
    verbose,
    style,
    sym: symbolsFor(unicode.enabled),
    color,
    unicode,
    cwd: stringFlag(args, 'cwd') ?? deps.cwd,
    stateDirOverride: stringFlag(args, 'state-dir') ?? deps.env['AGENTSYNC_STATE_DIR'],
    out(line = '') {
      if (json) return
      deps.io.stdout.write(`${line}\n`)
    },
    note(line = '') {
      if (json || quiet) return
      deps.io.stdout.write(`${line}\n`)
    },
    err(line = '') {
      deps.io.stderr.write(`${line}\n`)
    },
    emit(payload) {
      if (!json || didEmit) return
      didEmit = true
      deps.io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    },
    emitted() {
      return didEmit
    },
  }
}
