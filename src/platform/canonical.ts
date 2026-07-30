/**
 * Canonical serialization.
 *
 * The whole product hinges on "did this config change?" being answerable by
 * comparing two hashes computed on two different operating systems. That only
 * works if serialization is byte-identical everywhere, which means we cannot
 * use `JSON.stringify` directly:
 *
 *  - `JSON.stringify` preserves *insertion* order, so `{a,b}` and `{b,a}` —
 *    semantically identical configs — hash differently.
 *  - A file round-tripped through a Windows checkout with `core.autocrlf=true`
 *    comes back with `\r\n` inside every multi-line string value. Same config,
 *    different bytes.
 *  - Editors on Windows love to prepend a UTF-8 BOM.
 *
 * `canonicalJson` fixes all three: recursive key sort by UTF-16 code unit, LF
 * inside string values, never a BOM, two-space indent.
 */

import { createHash } from 'node:crypto'

export interface CanonicalJsonOptions {
  /** Spaces per indent level. Default 2. */
  indent?: number
  /** Append a single trailing LF. Default true (POSIX text file convention). */
  trailingNewline?: boolean
  /**
   * Rewrite CRLF and lone CR inside *string values* to LF. Default true.
   * This is the git-autocrlf defense; turn it off only if a value is
   * genuinely binary-ish and must survive byte-for-byte.
   */
  normalizeStringEol?: boolean
  /**
   * Drop a leading U+FEFF from string values. Default false — inside JSON a
   * BOM is real data. `canonicalizeText` strips it at the document level,
   * which is where it actually shows up.
   */
  stripBomInStrings?: boolean
}

export interface CanonicalTextOptions {
  /** Append a trailing LF if missing (and collapse multiple). Default true. */
  trailingNewline?: boolean
  /** Strip trailing whitespace on each line. Default false — markdown uses it. */
  trimTrailingWhitespace?: boolean
}

const DEFAULTS = {
  indent: 2,
  trailingNewline: true,
  normalizeStringEol: true,
  stripBomInStrings: false,
} as const

export class CanonicalJsonError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`${message} (at ${path || '<root>'})`)
    this.name = 'CanonicalJsonError'
    this.path = path
  }
}

/**
 * Sort by UTF-16 code unit. Deliberately NOT `Array#sort()`'s default (which is
 * also code-unit order, but relies on implicit string coercion) and absolutely
 * not `localeCompare` — locale-aware collation differs between machines and
 * would make the hash depend on the user's ICU data.
 */
export function compareKeys(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const CRLF_OR_CR = /\r\n?/g

function normalizeString(s: string, opts: Required<CanonicalJsonOptions>): string {
  let out = s
  if (opts.stripBomInStrings && out.charCodeAt(0) === 0xfeff) out = out.slice(1)
  if (opts.normalizeStringEol && out.includes('\r')) out = out.replace(CRLF_OR_CR, '\n')
  return out
}

function isPlainIterableRejected(v: object): string | null {
  if (v instanceof Map) return 'Map is not canonically serializable; convert to a plain object first'
  if (v instanceof Set) return 'Set is not canonically serializable; convert to a sorted array first'
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    return 'Binary data is not canonically serializable; encode it (base64) first'
  }
  return null
}

/**
 * Deterministic JSON. Two structurally equal values produce identical bytes on
 * every OS, regardless of key insertion order.
 *
 * Semantics that differ from `JSON.stringify` on purpose:
 *  - object keys are sorted recursively
 *  - `NaN` / `Infinity` throw instead of silently becoming `null`; a config
 *    that silently mutates during a sync is worse than a loud failure
 *  - `BigInt`, `Map`, `Set`, and typed arrays throw rather than guess
 *  - cycles throw with the offending path
 *  - `-0` normalizes to `0`
 */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const opts: Required<CanonicalJsonOptions> = { ...DEFAULTS, ...options }
  if (!Number.isInteger(opts.indent) || opts.indent < 0 || opts.indent > 10) {
    throw new CanonicalJsonError(`indent must be an integer in 0..10, got ${String(opts.indent)}`, '')
  }
  const pad = ' '.repeat(opts.indent)
  const seen = new Set<object>()

  const enc = (v: unknown, depth: number, path: string): string | undefined => {
    // Honor toJSON before anything else, exactly like JSON.stringify does.
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      v = (v as { toJSON: (k?: string) => unknown }).toJSON()
    }

    if (v === null) return 'null'

    switch (typeof v) {
      case 'boolean':
        return v ? 'true' : 'false'
      case 'number': {
        if (!Number.isFinite(v)) {
          throw new CanonicalJsonError(`non-finite number ${String(v)} cannot be canonicalized`, path)
        }
        return Object.is(v, -0) ? '0' : String(v)
      }
      case 'string':
        return JSON.stringify(normalizeString(v, opts))
      case 'bigint':
        throw new CanonicalJsonError('bigint cannot be canonicalized; use a string', path)
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined
      case 'object':
        break
      default:
        return undefined
    }

    const obj = v as object
    const rejected = isPlainIterableRejected(obj)
    if (rejected) throw new CanonicalJsonError(rejected, path)

    if (seen.has(obj)) throw new CanonicalJsonError('circular reference', path)
    seen.add(obj)
    try {
      const childPad = opts.indent ? pad.repeat(depth + 1) : ''
      const closePad = opts.indent ? pad.repeat(depth) : ''
      const nl = opts.indent ? '\n' : ''
      const sep = opts.indent ? ',\n' : ','

      if (Array.isArray(obj)) {
        if (obj.length === 0) return '[]'
        const items = obj.map((item, i) => {
          // Array holes and undefined become null — same as JSON.stringify,
          // and the only choice that preserves array length/index meaning.
          const s = enc(item, depth + 1, `${path}[${i}]`)
          return childPad + (s === undefined ? 'null' : s)
        })
        return `[${nl}${items.join(sep)}${nl}${closePad}]`
      }

      const keys = Object.keys(obj).sort(compareKeys)
      const parts: string[] = []
      for (const key of keys) {
        const s = enc((obj as Record<string, unknown>)[key], depth + 1, path ? `${path}.${key}` : key)
        if (s === undefined) continue // undefined-valued keys are dropped
        parts.push(`${childPad}${JSON.stringify(normalizeString(key, opts))}:${opts.indent ? ' ' : ''}${s}`)
      }
      if (parts.length === 0) return '{}'
      return `{${nl}${parts.join(sep)}${nl}${closePad}}`
    } finally {
      seen.delete(obj)
    }
  }

  const body = enc(value, 0, '')
  if (body === undefined) {
    throw new CanonicalJsonError('top-level value is not JSON-serializable', '')
  }
  return opts.trailingNewline ? `${body}\n` : body
}

/**
 * Canonicalize a *text* document (CLAUDE.md, .cursorrules, an agent prompt).
 * Same guarantees as `canonicalJson` at the document level: no BOM, LF only,
 * one trailing newline.
 */
export function canonicalizeText(text: string, options: CanonicalTextOptions = {}): string {
  const trailingNewline = options.trailingNewline ?? true
  const trimTrailing = options.trimTrailingWhitespace ?? false

  let out = stripBom(text)
  out = out.replace(CRLF_OR_CR, '\n')
  if (trimTrailing) out = out.replace(/[ \t]+$/gm, '')
  if (trailingNewline) {
    out = out.replace(/\n+$/, '')
    if (out.length > 0) out += '\n'
  }
  return out
}

/** Remove a leading UTF-8/UTF-16 BOM. Never adds one. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Parse arbitrary JSON text (BOM-tolerant) and re-emit it canonically.
 * This is what turns "bytes as they sit on disk" into "bytes we hash".
 */
export function canonicalizeJsonText(text: string, options?: CanonicalJsonOptions): string {
  return canonicalJson(JSON.parse(stripBom(text)) as unknown, options)
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Content hash of a value. `sha256:<hex>` so the algorithm is visible in
 * stored plans and can be migrated later without ambiguity.
 */
export function canonicalHash(value: unknown, options?: CanonicalJsonOptions): string {
  return `sha256:${sha256Hex(Buffer.from(canonicalJson(value, options), 'utf8'))}`
}

/** Hash raw text after document-level canonicalization (LF, no BOM). */
export function canonicalTextHash(text: string, options?: CanonicalTextOptions): string {
  return `sha256:${sha256Hex(Buffer.from(canonicalizeText(text, options), 'utf8'))}`
}

/** Structural equality via canonical bytes. Key order and EOL insensitive. */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}
