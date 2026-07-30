/**
 * Hand-rolled argument parsing.
 *
 * No commander/yargs/oclif: this CLI is the `npx` funnel for the product, and
 * every dependency is install latency the user pays before they see anything
 * work. The grammar is small enough to specify exactly, which is worth more
 * than the flexibility a framework would add.
 *
 * Deliberate properties:
 *  - Unknown flags are a USAGE error, never silently ignored. A typo'd
 *    `--dry-runn` that quietly applies for real is the worst bug this file
 *    could ship.
 *  - `--no-<flag>` negates any boolean flag, so `--no-color` needs no special
 *    case anywhere else.
 *  - Everything after `--` is positional, so a rollback id starting with `-`
 *    is still addressable.
 *  - Parsing NEVER touches the filesystem, the clock or the environment. It is
 *    a pure function of argv and a spec, which is what makes it testable.
 */

import { UsageError } from './exit.js'

export type FlagType = 'boolean' | 'string'

export interface FlagSpec {
  type: FlagType
  /** Single-character alias, without the dash. */
  alias?: string
  description: string
  /** Shown in help as `--tool <id>`. */
  placeholder?: string
  /** Collect every occurrence instead of last-wins. */
  repeatable?: boolean
}

export interface PositionalSpec {
  name: string
  required: boolean
  description: string
}

export interface CommandSpec {
  name: string
  summary: string
  /** One-line synopsis, e.g. `agentsync apply [--tool <id>] [--yes]`. */
  usage: string
  description?: string
  flags: Record<string, FlagSpec>
  positionals?: PositionalSpec[]
  /** Flags that stand in for a required positional (e.g. `rollback --list`). */
  positionalsSatisfiedBy?: string[]
  examples?: string[]
  /** Exit codes beyond 0/1/2 this command can return, and what they mean. */
  exitNotes?: string[]
}

export type FlagValue = string | boolean | string[]

export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, FlagValue>
  /** argv as received, for diagnostics. */
  argv: string[]
}

export type ParseResult = { ok: true; value: ParsedArgs } | { ok: false; error: UsageError }

/**
 * Flags accepted by every command. Kept separate from per-command flags so
 * `--json` never has to be re-declared and can never mean different things in
 * two places.
 */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: {
    type: 'boolean',
    description: 'Machine-readable output on stdout. Exactly one JSON document, always.',
  },
  color: { type: 'boolean', description: 'Force ANSI colour on; `--no-color` forces it off.' },
  verbose: { type: 'boolean', alias: 'v', description: 'Extra detail on stderr.' },
  quiet: { type: 'boolean', alias: 'q', description: 'Suppress non-essential human output.' },
  help: { type: 'boolean', alias: 'h', description: 'Show help for this command.' },
  version: { type: 'boolean', alias: 'V', description: 'Print the version and exit.' },
  'state-dir': {
    type: 'string',
    placeholder: '<path>',
    description: 'Override the local state directory (default: per-OS, see `doctor`).',
  },
  cwd: { type: 'string', placeholder: '<path>', description: 'Run as if started in this directory.' },
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

interface Resolved {
  name: string
  spec: FlagSpec
  negated: boolean
}

function resolveFlag(token: string, specs: Record<string, FlagSpec>): Resolved | undefined {
  const direct = specs[token]
  if (direct) return { name: token, spec: direct, negated: false }

  if (token.startsWith('no-')) {
    const base = token.slice(3)
    const spec = specs[base]
    // Only booleans can be negated; `--no-tool` is meaningless and is better
    // reported as unknown than silently accepted.
    if (spec && spec.type === 'boolean') return { name: base, spec, negated: true }
  }
  return undefined
}

function resolveAlias(ch: string, specs: Record<string, FlagSpec>): Resolved | undefined {
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias === ch) return { name, spec, negated: false }
  }
  return undefined
}

function parseBooleanLiteral(raw: string, flag: string): boolean {
  const v = raw.toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false
  throw new UsageError(`--${flag} is a true/false flag but got "${raw}".`, {
    hint: `Write \`--${flag}\` to enable it or \`--no-${flag}\` to disable it.`,
  })
}

function setFlag(out: Record<string, FlagValue>, resolved: Resolved, value: FlagValue): void {
  if (resolved.spec.repeatable && typeof value === 'string') {
    const prior = out[resolved.name]
    out[resolved.name] = Array.isArray(prior) ? [...prior, value] : [value]
    return
  }
  out[resolved.name] = value
}

/**
 * Levenshtein distance, used only to suggest a name after a typo — an
 * approximate answer beyond distance 3 is worthless, so no optimisation here
 * would buy anything.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i, ...Array<number>(n).fill(0)]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(
        (cur[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      )
    }
    prev = cur
  }
  return prev[n] as number
}

export function suggest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    const d = editDistance(input, c)
    if (d < bestScore) {
      best = c
      bestScore = d
    }
  }
  // Scale the threshold with input length: distance 3 on a 4-character name is
  // noise, distance 3 on `rollbakc` is a typo.
  const limit = Math.max(1, Math.min(3, Math.floor(input.length / 3) + 1))
  return best !== undefined && bestScore <= limit ? best : undefined
}

/**
 * Locate the sub-command: the first bare word that is not the value of a
 * preceding global string flag. `agentsync --state-dir /tmp/x status` must
 * resolve to `status`, not to `/tmp/x`.
 */
export function findCommand(
  argv: string[],
  globals: Record<string, FlagSpec>,
): { command: string; index: number } | undefined {
  let i = 0
  while (i < argv.length) {
    const t = argv[i] as string
    if (t === '--') return undefined

    if (t.startsWith('--')) {
      const body = t.slice(2)
      if (body.includes('=')) {
        i++
        continue
      }
      const r = resolveFlag(body, globals)
      i += r && r.spec.type === 'string' ? 2 : 1
      continue
    }

    if (t.startsWith('-') && t.length > 1) {
      const chars = [...t.slice(1)]
      const last = chars[chars.length - 1]
      const r = last !== undefined ? resolveAlias(last, globals) : undefined
      i += r && r.spec.type === 'string' ? 2 : 1
      continue
    }

    return { command: t, index: i }
  }
  return undefined
}

// ---------------------------------------------------------------------------

export interface ParseOptions {
  commands: Record<string, CommandSpec>
  /** Used when argv contains no command at all. */
  defaultCommand?: string
  globals?: Record<string, FlagSpec>
}

export function parse(argv: string[], options: ParseOptions): ParseResult {
  try {
    return { ok: true, value: parseOrThrow(argv, options) }
  } catch (err) {
    if (err instanceof UsageError) return { ok: false, error: err }
    throw err
  }
}

function parseOrThrow(argv: string[], options: ParseOptions): ParsedArgs {
  const globals = options.globals ?? GLOBAL_FLAGS
  const { commands } = options

  const found = findCommand(argv, globals)
  let command: string
  let commandIndex: number

  if (found === undefined) {
    command = options.defaultCommand ?? 'help'
    commandIndex = -1
  } else {
    command = found.command
    commandIndex = found.index
    if (!commands[command]) {
      const knownCommands = Object.keys(commands)
      const near = suggest(command, knownCommands)
      throw new UsageError(`Unknown command "${command}".`, {
        ...(near ? { hint: `Did you mean \`agentsync ${near}\`?` } : {}),
        details: [`Known commands: ${knownCommands.join(', ')}`],
      })
    }
  }

  const spec = commands[command]
  const known: Record<string, FlagSpec> = { ...globals, ...(spec?.flags ?? {}) }
  const knownNames = Object.keys(known)

  const flags: Record<string, FlagValue> = {}
  const positionals: string[] = []
  let sawTerminator = false
  let i = 0

  while (i < argv.length) {
    const index = i
    const token = argv[i] as string
    i++

    if (sawTerminator) {
      positionals.push(token)
      continue
    }
    if (token === '--') {
      sawTerminator = true
      continue
    }
    if (index === commandIndex) continue

    // ---- long flags ------------------------------------------------------
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const name = eq === -1 ? body : body.slice(0, eq)
      const inline = eq === -1 ? undefined : body.slice(eq + 1)

      if (name === '') throw new UsageError(`"${token}" is not a valid flag.`)

      const resolved = resolveFlag(name, known)
      if (!resolved) {
        const near = suggest(name, knownNames)
        throw new UsageError(`Unknown flag "--${name}" for \`agentsync ${command}\`.`, {
          ...(near ? { hint: `Did you mean \`--${near}\`?` } : {}),
          details: [`Accepted here: ${knownNames.map((n) => `--${n}`).join(', ')}`],
        })
      }

      if (resolved.spec.type === 'boolean') {
        let value: boolean
        if (inline === undefined) {
          value = !resolved.negated
        } else {
          const literal = parseBooleanLiteral(inline, resolved.name)
          value = resolved.negated ? !literal : literal
        }
        setFlag(flags, resolved, value)
        continue
      }

      if (inline !== undefined) {
        setFlag(flags, resolved, inline)
        continue
      }
      const next = argv[i]
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError(`--${resolved.name} needs a value.`, {
          hint: `Try \`--${resolved.name} ${resolved.spec.placeholder ?? '<value>'}\`.`,
        })
      }
      i++
      setFlag(flags, resolved, next)
      continue
    }

    // ---- short flags, possibly clustered ---------------------------------
    if (token.startsWith('-') && token.length > 1) {
      const chars = [...token.slice(1)]
      for (let c = 0; c < chars.length; c++) {
        const ch = chars[c] as string
        const resolved = resolveAlias(ch, known)
        if (!resolved) {
          const shorts = knownNames
            .filter((n) => known[n]?.alias)
            .map((n) => `-${known[n]?.alias} (--${n})`)
          throw new UsageError(`Unknown flag "-${ch}" for \`agentsync ${command}\`.`, {
            details: [`Accepted short flags here: ${shorts.length ? shorts.join(', ') : '(none)'}`],
          })
        }
        if (resolved.spec.type === 'boolean') {
          setFlag(flags, resolved, true)
          continue
        }
        // A value-taking short flag consumes the rest of the cluster, or the
        // next token if it is last. Same rule as every POSIX tool.
        const rest = chars.slice(c + 1).join('')
        if (rest.length > 0) {
          setFlag(flags, resolved, rest)
          break
        }
        const next = argv[i]
        if (next === undefined || (next.startsWith('-') && next !== '-')) {
          throw new UsageError(`-${ch} (--${resolved.name}) needs a value.`, {
            hint: `Try \`--${resolved.name} ${resolved.spec.placeholder ?? '<value>'}\`.`,
          })
        }
        i++
        setFlag(flags, resolved, next)
        break
      }
      continue
    }

    positionals.push(token)
  }

  // ---- required positionals ----------------------------------------------
  if (spec?.positionals && !flags['help'] && !flags['version']) {
    const satisfied = (spec.positionalsSatisfiedBy ?? []).some((f) => flags[f] === true)
    const required = spec.positionals.filter((p) => p.required)
    if (!satisfied && positionals.length < required.length) {
      const missing = required.slice(positionals.length).map((p) => `<${p.name}>`)
      throw new UsageError(`\`agentsync ${command}\` needs ${missing.join(' ')}.`, {
        hint: `Usage: ${spec.usage}`,
      })
    }
  }

  return { command, positionals, flags, argv }
}

// ---------------------------------------------------------------------------
// Typed accessors. Every command reads flags through these, so a flag declared
// 'string' can never be read as a boolean by accident.
// ---------------------------------------------------------------------------

export function boolFlag(args: ParsedArgs, name: string, fallback = false): boolean {
  const v = args.flags[name]
  return typeof v === 'boolean' ? v : fallback
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[v.length - 1]
  return undefined
}

export function listFlag(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name]
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [v]
  return []
}

/** `--color` / `--no-color` as a tri-state: on, off, or unspecified. */
export function triStateFlag(args: ParsedArgs, name: string): boolean | undefined {
  const v = args.flags[name]
  return typeof v === 'boolean' ? v : undefined
}
