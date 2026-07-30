/**
 * Shape-independent secret detection.
 *
 * WHY THIS EXISTS, AND WHY IT DUPLICATES `KeyRule`
 * -----------------------------------------------
 * `never-sync` KeyRules are the primary defence, and they work — but only when
 * the document is the shape the rules were written for. Adapters accept two
 * incompatible desired-state shapes today:
 *
 *   flat    { mcpServers: { github: { env: { GITHUB_TOKEN } } } }
 *   nested  { stores: { "cursor:user:mcp": { mcpServers: { … } } } }
 *
 * The rule `mcpServers.*.env.**` matches the first and NOT the second, so the
 * identical secret is blocked in one shape and classified `portable` in the
 * other. Verified, not theorised.
 *
 * Any defence that depends on the caller having passed the right shape is not a
 * defence. This one walks whatever it is given and matches on key NAME and
 * value SHAPE, so it holds for both shapes and for shapes nobody has invented
 * yet. It is deliberately redundant with the rules: the rules provide precision,
 * this provides a floor.
 *
 * Bias: false positives are cheap (a user overrides once), a false negative
 * ships someone's production token to a server. Tuned accordingly.
 */

const SECRET_KEY_WORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'privatekey',
  'private_key',
  'clientsecret',
  'client_secret',
  'credential',
  'auth',
  'bearer',
  'session',
  'cookie',
  'signature',
]

/** Keys that contain a secret word but are not themselves secrets. */
const ALLOW = [
  /^auth(entication)?_?(type|method|mode|url|endpoint|provider)$/i,
  /^token_?(count|limit|budget|window|type)$/i,
  /^session_?(timeout|id|name)$/i,
  /^.*_?enabled$/i,
]

/** High-confidence value shapes, matched even when the key looks innocuous. */
const SECRET_VALUE_SHAPES: Array<[RegExp, string]> = [
  [/^gh[pousr]_[A-Za-z0-9]{16,}$/, 'GitHub token'],
  [/^sk-[A-Za-z0-9-_]{16,}$/, 'OpenAI-style key'],
  [/^sk-ant-[A-Za-z0-9-_]{16,}$/, 'Anthropic key'],
  [/^xox[baprs]-[A-Za-z0-9-]{10,}$/, 'Slack token'],
  [/^AKIA[0-9A-Z]{16}$/, 'AWS access key id'],
  [/^ya29\.[A-Za-z0-9._-]{20,}$/, 'Google OAuth token'],
  [/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
]

export interface SecretFinding {
  path: string
  reason: string
  /** How it was caught. `value` findings are high confidence. */
  via: 'key-name' | 'value-shape'
}

function keyLooksSecret(key: string): string | null {
  if (ALLOW.some((rx) => rx.test(key))) return null
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  for (const word of SECRET_KEY_WORDS) {
    if (normalized.includes(word.replace(/_/g, ''))) return `key name contains "${word}"`
  }
  return null
}

function valueLooksSecret(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 8) return null
  // A vault reference is the SAFE form — that indirection is the whole design.
  if (value.includes('${secret:')) return null
  for (const [rx, label] of SECRET_VALUE_SHAPES) if (rx.test(value)) return `looks like a ${label}`
  return null
}

/**
 * Walk any document and report anything secret-shaped.
 *
 * Arrays are indexed here (unlike `flatten`, which treats them as leaves)
 * because a token can perfectly well sit inside an args array —
 * `args: ["--token", "ghp_…"]` is a real MCP server shape.
 */
export function scanForSecrets(value: unknown, prefix = ''): SecretFinding[] {
  const out: SecretFinding[] = []

  const walk = (v: unknown, path: string, keyName: string | null): void => {
    if (v === null || v === undefined) return

    if (typeof v === 'string') {
      // A vault reference is the SAFE form and must short-circuit BOTH checks.
      // Guarding only the value-shape path meant `password: "${secret:db.pw}"`
      // was still flagged by its key name — refusing to sync the very
      // indirection the design exists to encourage.
      if (v.includes('${secret:')) return
      if (v.length === 0) return

      const byValue = valueLooksSecret(v)
      if (byValue) {
        out.push({ path, reason: byValue, via: 'value-shape' })
        return
      }
      if (keyName) {
        const byKey = keyLooksSecret(keyName)
        if (byKey) out.push({ path, reason: byKey, via: 'key-name' })
      }
      return
    }

    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, path ? `${path}[${i}]` : `[${i}]`, keyName))
      return
    }

    if (typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path ? `${path}.${k}` : k, k)
      }
    }
  }

  // Seed the key name from the prefix's last segment. `buildPlan` calls this
  // with a LEAF value and its dot path, so passing null here made key-name
  // detection completely inert in the one place that matters most — only
  // value-shape matching was running.
  const seedKey = prefix ? (prefix.split('.').pop() ?? null) : null
  walk(value, prefix, seedKey)
  return out
}

/** True when a document carries anything that must not leave the device. */
export function hasSecrets(value: unknown): boolean {
  return scanForSecrets(value).length > 0
}
