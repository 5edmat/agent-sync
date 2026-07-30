/**
 * Colour and glyph decisions, made once and injected everywhere.
 *
 * Two rules this file exists to guarantee:
 *
 *  1. NOTHING escape-shaped reaches a pipe. `agentsync diff | grep` and
 *     `agentsync status > out.txt` must produce clean text, so the decision is
 *     driven by the real stream's `isTTY` plus `NO_COLOR`, never by a hunch.
 *  2. NOTHING non-ASCII reaches a console that cannot draw it. Windows
 *     `cmd.exe` at code page 437 renders box-drawing characters as mojibake,
 *     which makes a diagnostic tool look broken at exactly the moment the user
 *     is already suspicious. So glyphs are a separate decision from colour.
 *
 * Both decisions are returned with a `reason` string, because `doctor` prints
 * them — "why is my output not coloured" is a real support question.
 */

/** Precedence, highest first. Explicit flags beat env; NO_COLOR beats FORCE_COLOR. */
export interface ColorInput {
  env: NodeJS.ProcessEnv
  isTTY: boolean
  /** `--color` / `--no-color`. `undefined` means the user did not say. */
  flag?: boolean | undefined
}

export interface ColorDecision {
  enabled: boolean
  reason: string
}

export function decideColor(input: ColorInput): ColorDecision {
  const { env, isTTY, flag } = input

  if (flag === false) return { enabled: false, reason: '--no-color was passed' }
  if (flag === true) return { enabled: true, reason: '--color was passed' }

  // no-color.org: present AND non-empty disables. An empty value is explicitly
  // NOT a signal, so `NO_COLOR=` does not silently turn colour off.
  const noColor = env['NO_COLOR']
  if (noColor !== undefined && noColor !== '') {
    return { enabled: false, reason: 'NO_COLOR is set' }
  }

  if (env['TERM'] === 'dumb') return { enabled: false, reason: 'TERM=dumb' }

  const force = env['FORCE_COLOR']
  if (force !== undefined && force !== '' && force !== '0' && force.toLowerCase() !== 'false') {
    return { enabled: true, reason: 'FORCE_COLOR is set' }
  }

  if (!isTTY) return { enabled: false, reason: 'output is not a terminal' }

  return { enabled: true, reason: 'writing to a terminal' }
}

// ---------------------------------------------------------------------------
// Styler
// ---------------------------------------------------------------------------

export interface Style {
  readonly enabled: boolean
  bold(s: string): string
  dim(s: string): string
  underline(s: string): string
  red(s: string): string
  green(s: string): string
  yellow(s: string): string
  blue(s: string): string
  magenta(s: string): string
  cyan(s: string): string
  gray(s: string): string
  /** Bold white on red. Reserved for code-execution risk — nothing else. */
  alarm(s: string): string
  /** Inverse video, for column headers. */
  invert(s: string): string
}

const wrap = (enabled: boolean, open: string, close: string) => (s: string) =>
  enabled ? `\u001B[${open}m${s}\u001B[${close}m` : s

export function makeStyle(enabled: boolean): Style {
  return {
    enabled,
    bold: wrap(enabled, '1', '22'),
    dim: wrap(enabled, '2', '22'),
    underline: wrap(enabled, '4', '24'),
    red: wrap(enabled, '31', '39'),
    green: wrap(enabled, '32', '39'),
    yellow: wrap(enabled, '33', '39'),
    blue: wrap(enabled, '34', '39'),
    magenta: wrap(enabled, '35', '39'),
    cyan: wrap(enabled, '36', '39'),
    gray: wrap(enabled, '90', '39'),
    alarm: (s) => (enabled ? `\u001B[1;97;41m${s}\u001B[0m` : s),
    invert: wrap(enabled, '7', '27'),
  }
}

/** A styler that is a pure identity function. Convenience for tests and --json. */
export const PLAIN: Style = makeStyle(false)

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

export interface UnicodeDecision {
  enabled: boolean
  reason: string
}

export function decideUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): UnicodeDecision {
  const forced = env['AGENTSYNC_ASCII']
  if (forced !== undefined && forced !== '' && forced !== '0') {
    return { enabled: false, reason: 'AGENTSYNC_ASCII is set' }
  }
  if (platform === 'win32') {
    // Windows Terminal, VS Code's terminal and ConEmu all handle UTF-8 well.
    // Raw conhost at CP437 does not, and there is no reliable probe for it, so
    // the safe default on Windows is ASCII unless one of these says otherwise.
    if (env['WT_SESSION'] || env['TERM_PROGRAM'] || env['ConEmuANSI'] === 'ON' || env['TERM']) {
      return { enabled: true, reason: 'a UTF-8 capable Windows terminal was detected' }
    }
    return { enabled: false, reason: 'Windows console without a detected UTF-8 terminal' }
  }
  return { enabled: true, reason: 'POSIX terminal' }
}

export interface Symbols {
  ok: string
  warn: string
  fail: string
  info: string
  bullet: string
  arrow: string
  added: string
  removed: string
  changed: string
  hazard: string
  boxH: string
  boxV: string
  boxTL: string
  boxTR: string
  boxBL: string
  boxBR: string
}

const UNICODE_SYMBOLS: Symbols = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: 'i',
  bullet: '•',
  arrow: '→',
  added: '+',
  removed: '-',
  changed: '~',
  hazard: '⚠',
  boxH: '─',
  boxV: '│',
  boxTL: '┌',
  boxTR: '┐',
  boxBL: '└',
  boxBR: '┘',
}

const ASCII_SYMBOLS: Symbols = {
  ok: 'v',
  warn: '!',
  fail: 'x',
  info: 'i',
  bullet: '*',
  arrow: '->',
  added: '+',
  removed: '-',
  changed: '~',
  hazard: '!!',
  boxH: '-',
  boxV: '|',
  boxTL: '+',
  boxTR: '+',
  boxBL: '+',
  boxBR: '+',
}

export function symbolsFor(unicode: boolean): Symbols {
  return unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS
}

// ---------------------------------------------------------------------------
// Width helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Printable width, ignoring escape sequences. Good enough for ASCII tables. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length
}

export function padEnd(s: string, width: number): string {
  const pad = width - visibleWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

export function padStart(s: string, width: number): string {
  const pad = width - visibleWidth(s)
  return pad > 0 ? ' '.repeat(pad) + s : s
}
