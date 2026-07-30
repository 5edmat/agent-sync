/**
 * Exit codes and the error type that carries one.
 *
 * Exit codes are part of the CLI's public contract — CI jobs and shell scripts
 * branch on them — so they are enumerated here once and never invented inline.
 *
 *   0  OK                      the thing the user asked for happened
 *   1  ERROR                   it failed for a reason we can describe
 *   2  USAGE                   the command line itself was wrong
 *   3  NOTHING_TO_DO           already in the desired state; not a failure
 *   4  BLOCKED_BY_PROVENANCE   we know what to write but refuse to guess where
 *
 * 3 and 4 exist because collapsing them into 0/1 loses the two facts a script
 * most wants: "no work needed" is success-shaped but distinguishable, and
 * "refused because the path table is unverified on this OS" is a platform
 * limitation the user can act on, not a bug in their config.
 */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOTHING_TO_DO: 3,
  BLOCKED_BY_PROVENANCE: 4,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export const EXIT_MEANING: Record<ExitCode, string> = {
  0: 'ok',
  1: 'error',
  2: 'usage error',
  3: 'nothing to do',
  4: 'blocked by provenance',
}

export interface CliErrorOptions {
  code?: ExitCode
  /** One line telling the user what to do next. Required in spirit. */
  hint?: string
  /** Extra context lines, printed indented under the message. */
  details?: string[]
  cause?: unknown
}

/**
 * An error the CLI knows how to print. Anything thrown that is NOT a CliError
 * is treated as a bug and printed with its stack, because a user should never
 * have to read a stack trace for a condition we anticipated.
 */
export class CliError extends Error {
  readonly code: ExitCode
  readonly hint: string | undefined
  readonly details: string[]
  override readonly cause: unknown

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message)
    this.name = 'CliError'
    this.code = options.code ?? EXIT.ERROR
    this.hint = options.hint
    this.details = options.details ?? []
    this.cause = options.cause
  }
}

/** Bad command line. Always exit 2, never anything else. */
export class UsageError extends CliError {
  constructor(message: string, options: Omit<CliErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: EXIT.USAGE })
    this.name = 'UsageError'
  }
}
