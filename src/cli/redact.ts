/**
 * Redaction. The CLI prints config values; config values contain credentials.
 *
 * Three independent signals, because any one of them alone has a hole:
 *
 *  1. ADAPTER RULES — `KeyRule.secret === true` is the authoritative answer for
 *     paths the adapter models (`mcpServers.*.env.**`, `oauthAccount`, ...).
 *     Hole: only covers paths somebody thought to declare.
 *  2. KEY SHAPE — a key called `githubToken` is a token regardless of which
 *     adapter it came from. Hole: a secret in a key called `value`.
 *  3. VALUE SHAPE — `ghp_...`, `sk-...`, a JWT, a PEM block. Narrowly scoped on
 *     purpose: a generic "long and high-entropy" test would redact SHA-256
 *     hashes and plan ids, which are the things a user most needs to read.
 *
 * Redaction applies to `--json` output too. `--json` is for scripting, and
 * scripts get piped into logs; "machine-readable" is not a licence to leak.
 *
 * `${secret:ref}` references are deliberately NOT redacted. They are symbolic
 * by construction — that indirection is the entire point of the vault — and
 * showing `GITHUB_TOKEN -> ${secret:github.token}` is exactly the diff a user
 * needs to review.
 */

import type { KeyRule } from '../core/types.js'
import { ruleFor } from '../core/reconcile.js'

/** ASCII on purpose: this string lands in Windows consoles and CI logs. */
export const REDACTED = '[redacted]'

/**
 * Key names that carry credentials. Matched against a single dot-path segment,
 * case-insensitively, after splitting camelCase and snake/kebab boundaries.
 */
const SECRET_WORDS = [
  'apikey',
  'api_key',
  'accesskey',
  'secretkey',
  'privatekey',
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'bearer',
  'sessionkey',
  'clientsecret',
  'refreshtoken',
  'accesstoken',
  'cookie',
  'signature',
  'pat',
]

/** Words that look secret-ish but are not, and would cause noisy over-redaction. */
const ALLOW_WORDS = new Set(['tokenizer', 'tokens', 'authorized', 'authority', 'secrets'])

function normalizeSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Does this single path segment name a secret?
 *
 * Word-boundary matched rather than substring matched: `tokenizer` is not a
 * token and `authorized_users` is not a credential, and redacting them would
 * train users to ignore the marker.
 */
export function isSecretKeyName(segment: string): boolean {
  const normalized = normalizeSegment(segment)
  if (normalized === '') return false
  const words = normalized.split(/\s+/)
  if (words.some((w) => ALLOW_WORDS.has(w))) return false

  const joined = words.join('')
  if (SECRET_WORDS.includes(joined)) return true
  return words.some((w) => SECRET_WORDS.includes(w))
}

/** Any segment of the dot path naming a secret taints the whole subtree. */
export function isSecretPath(path: string, rules?: KeyRule[]): boolean {
  if (path !== '' && path.split('.').some(isSecretKeyName)) return true
  if (!rules || rules.length === 0) return false
  try {
    return ruleFor(rules, path).secret === true
  } catch {
    // `ruleFor` throws when an adapter has no `**` fallback. A missing rule is
    // not evidence that a value is safe, but it is also not evidence that it is
    // secret — fall back to the shape tests above, which already ran.
    return false
  }
}

/** `${secret:github.token}` — a reference, never a value. Safe to display. */
const SECRET_REF_ONLY = /^\s*\$\{secret:[a-zA-Z0-9._-]+\}\s*$/

const VALUE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/, label: 'PEM private key' },
  { re: /^gh[pousr]_[A-Za-z0-9]{16,}$/, label: 'GitHub token' },
  { re: /^github_pat_[A-Za-z0-9_]{20,}$/, label: 'GitHub fine-grained PAT' },
  { re: /^sk-[A-Za-z0-9_-]{16,}$/, label: 'OpenAI-style key' },
  { re: /^sk-ant-[A-Za-z0-9_-]{16,}$/, label: 'Anthropic key' },
  { re: /^xox[baprs]-[A-Za-z0-9-]{10,}$/, label: 'Slack token' },
  { re: /^AKIA[0-9A-Z]{16}$/, label: 'AWS access key id' },
  { re: /^ya29\.[A-Za-z0-9_-]{20,}$/, label: 'Google OAuth token' },
  { re: /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/, label: 'JWT' },
  { re: /^glpat-[A-Za-z0-9_-]{16,}$/, label: 'GitLab PAT' },
  { re: /^npm_[A-Za-z0-9]{30,}$/, label: 'npm token' },
]

/**
 * Recognised credential shapes only. Deliberately not an entropy heuristic —
 * see the header: redacting every 64-char hex string would hide exactly the
 * content hashes this CLI exists to explain.
 */
export function looksLikeSecretValue(value: string): string | undefined {
  if (SECRET_REF_ONLY.test(value)) return undefined
  for (const { re, label } of VALUE_PATTERNS) if (re.test(value)) return label
  return undefined
}

export interface RedactOptions {
  /** Adapter rules, consulted via `ruleFor` for `secret: true`. */
  rules?: KeyRule[]
  /** Dot path of `value` within its document. `''` for a whole document. */
  path?: string
}

/**
 * Deep-redact a value for display. Structure is preserved — a user must still
 * be able to see that `env` gained three keys and what they are called, just
 * not what they contain.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  return walk(value, options.path ?? '', options.rules, false)
}

function walk(value: unknown, path: string, rules: KeyRule[] | undefined, inherited: boolean): unknown {
  const tainted = inherited || isSecretPath(path, rules)

  if (typeof value === 'string') {
    if (SECRET_REF_ONLY.test(value)) return value
    if (tainted) return REDACTED
    return looksLikeSecretValue(value) ? REDACTED : value
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, path === '' ? String(i) : `${path}.${i}`, rules, tainted))
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === '' ? k : `${path}.${k}`
      out[k] = walk(v, childPath, rules, tainted || isSecretKeyName(k))
    }
    return out
  }

  // Numbers, booleans and null carry no credential worth hiding, and blanking
  // them destroys the reader's ability to see the shape of the change.
  return value
}

/**
 * Convenience for the diff renderer: was anything actually redacted?
 * Used to print the "N values hidden" footer rather than silently altering
 * what the user is reviewing.
 */
export function countRedactions(value: unknown): number {
  let n = 0
  const visit = (v: unknown): void => {
    if (v === REDACTED) n++
    else if (Array.isArray(v)) v.forEach(visit)
    else if (v !== null && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return n
}
