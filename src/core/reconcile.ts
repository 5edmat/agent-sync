/**
 * Layering + reconcile engine. Pure — no IO, no clock, no randomness.
 *
 * Purity is a product requirement, not a style preference: the web app and the
 * device must compute byte-identical plans from the same inputs, or "preview"
 * means nothing and the whole review-before-apply flow is theatre.
 *
 *   base ──▶ os:<os> ──▶ machine:<deviceId> ──▶ local     (lowest → highest)
 *
 * `local` lives only on the device and is merged at apply time. It is the
 * escape hatch that makes the other three layers safe to share.
 */

import { conceptFor } from './concepts.js'
import { scanForSecrets } from './secret-guard.js'
import type {
  Change,
  ConfigDoc,
  HostEnv,
  KeyRule,
  MergeStrategy,
  Plan,
  Strictness,
  ToolId,
} from './types.js'
import type { LayerId } from './control-plane.js'

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/** `*` matches one path segment, `**` matches the remainder. */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern === '**') return true
  const p = pattern.split('.')
  const s = path.split('.')

  let i = 0
  let j = 0
  while (i < p.length && j < s.length) {
    // Bounds are guaranteed by the loop condition; noUncheckedIndexedAccess
    // can't see that, so bind explicitly rather than assert at each use.
    const pat = p[i] as string
    const seg = s[j] as string

    if (pat === '**') return true // matches rest, including nothing
    if (pat === '*' || pat === seg) {
      i++
      j++
      continue
    }
    // Support partial-segment wildcards like `*_TOKEN` and `*Cache`.
    if (pat.includes('*')) {
      const rx = new RegExp('^' + pat.split('*').map(esc).join('.*') + '$')
      if (rx.test(seg)) {
        i++
        j++
        continue
      }
    }
    return false
  }
  return i === p.length && j === s.length
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Placeholder substituted for a value the engine refuses to carry. */
export const REDACTED = '[redacted]'

/**
 * Most specific rule wins — the catch-all `**` must never beat a real rule.
 * Specificity = literal segments first, then total segments.
 */
export function ruleFor(rules: KeyRule[], path: string): KeyRule {
  const segs = path.split('.')
  let best: KeyRule | undefined
  let bestScore = -1

  for (const r of rules) {
    // A rule GOVERNS ITS SUBTREE. `oauthAccount` must cover
    // `oauthAccount.emailAddress`, because flatten() yields leaf paths and the
    // key itself is an object. Without ancestor matching, every never-sync rule
    // on an object-valued key silently failed to apply and the `**` catch-all
    // classified account identity as portable.
    let depth = -1
    for (let n = segs.length; n >= 1; n--) {
      if (globMatch(r.match, segs.slice(0, n).join('.'))) {
        depth = n
        break
      }
    }
    if (depth === -1) continue

    const rsegs = r.match.split('.')
    const literals = rsegs.filter((s) => !s.includes('*')).length
    // Literal CHARACTERS matter, not just whole literal segments: `*Cache` and
    // `**` both have zero literal segments and one pattern segment, so without
    // this term the universal fallback tied with — and then beat — a real rule
    // on `depth`, because `**` always consumes the entire path.
    const literalChars = r.match.replace(/[*.]/g, '').length
    const score = literals * 10_000 + literalChars * 100 + rsegs.length * 10 + depth
    if (score > bestScore) {
      best = r
      bestScore = score
    }
  }
  if (!best) throw new Error(`no rule matched "${path}" — adapter must define a ** fallback`)
  return best
}

// ---------------------------------------------------------------------------
// Layer validation
// ---------------------------------------------------------------------------

export interface LayerViolation {
  layer: LayerId
  path: string
  reason: string
}

/**
 * Enforces the portability contract. This is what stops a macOS shell hook from
 * being placed in `base` and silently breaking every Windows device — the class
 * of bug that would otherwise define this product's reputation.
 */
export function validateLayer(layer: LayerId, data: unknown, rules: KeyRule[]): LayerViolation[] {
  const out: LayerViolation[] = []
  for (const [path, value] of flatten(data)) {
    void value
    const rule = ruleFor(rules, path)
    switch (rule.portability) {
      case 'never-sync':
        out.push({
          layer,
          path,
          reason: rule.secret
            ? 'Secret-bearing key. Store it in the device keychain and reference it indirectly.'
            : 'Device identity or session state. Syncing it would corrupt the target device.',
        })
        break
      case 'os-scoped':
        if (layer === 'base')
          out.push({
            layer,
            path,
            reason:
              'Shells out or is OS-specific. Move it to an os: layer — it will not run on every platform.',
          })
        break
      case 'machine-scoped':
        if (layer === 'base' || layer.startsWith('os:'))
          out.push({
            layer,
            path,
            reason: 'Contains an absolute, device-local path. Move it to a machine: layer.',
          })
        break
      case 'portable':
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolvedKey {
  path: string
  value: unknown
  /** Which layer supplied the winning value — rendered in the layer editor. */
  wonBy: LayerId
  strategy: MergeStrategy
}

export function resolve(
  layers: Array<{ id: LayerId; data: unknown }>,
  rules: KeyRule[],
  host: HostEnv,
): { value: unknown; provenance: ResolvedKey[] } {
  const applicable = layers.filter((l) => layerApplies(l.id, host))
  const acc: Record<string, unknown> = {}
  const provenance = new Map<string, ResolvedKey>()
  /** Set only for array-rooted / scalar-rooted documents. */
  let root: { value: unknown } | null = null

  for (const layer of applicable) {
    for (const [path, incoming] of flatten(layer.data)) {
      const rule = ruleFor(rules, path)
      if (rule.merge === 'never') continue

      if (path === ROOT_PATH) {
        // Whole-document layer. There are no sub-paths to merge into, so the
        // strategy applies to the document itself (union-list/concat still work
        // for array-rooted files like keymap.json).
        const merged = mergeValue(root?.value, incoming, rule.merge, rule.strictness)
        root = { value: merged }
        provenance.set(path, {
          path,
          value: merged,
          wonBy: layer.id,
          strategy: rule.merge,
        })
        continue
      }

      const current = getPath(acc, path)
      const merged = mergeValue(current, incoming, rule.merge, rule.strictness)
      setPath(acc, path, merged)
      provenance.set(path, {
        path,
        value: merged,
        wonBy: layer.id,
        strategy: rule.merge,
      })
    }
  }
  // A document cannot be both object-rooted and array-rooted; if any layer
  // supplied a root value it wins, because there is nothing to merge it into.
  return {
    value: root ? root.value : acc,
    provenance: [...provenance.values()],
  }
}

function layerApplies(id: LayerId, host: HostEnv): boolean {
  if (id === 'base' || id === 'local') return true
  if (id.startsWith('os:')) {
    const target = id.slice(3)
    // WSL deliberately matches both — it is a Linux userland a Windows user
    // reaches through, and treating it as neither is how you end up with a
    // device that receives no config at all.
    if (host.runtime === 'wsl') return target === 'linux' || target === 'wsl'
    return target === host.os
  }
  if (id.startsWith('machine:')) return id.slice(8) === host.deviceId
  return false
}

export function mergeValue(
  current: unknown,
  incoming: unknown,
  strategy: MergeStrategy,
  strictness?: Strictness,
): unknown {
  switch (strategy) {
    case 'never':
      return current
    case 'replace':
      return incoming
    case 'most-restrictive': {
      if (current === undefined) return incoming
      if (incoming === undefined) return current
      if (!strictness)
        // Fail loudly. Guessing a direction here would let the web app and the
        // CLI disagree about which value wins, so a previewed plan would not be
        // the plan that runs — and on a security key, the wrong guess silently
        // weakens a sandbox.
        throw new Error(
          "merge 'most-restrictive' requires a strictness direction; declare it on the KeyRule",
        )
      return stricter(current, incoming, strictness)
    }
    case 'concat':
      return [...toArray(current), ...toArray(incoming)]
    case 'union-list': {
      // Order-insensitive dedupe. Correct for permission rules, which merge
      // across scopes rather than override — 'replace' here would silently drop
      // rules the user still relies on.
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const v of [...toArray(current), ...toArray(incoming)]) {
        const k = typeof v === 'string' ? v : JSON.stringify(v)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(v)
      }
      return out
    }
    case 'deep-merge':
      if (isPlainObject(current) && isPlainObject(incoming)) return { ...current, ...incoming }
      return incoming
  }
}

/**
 * Pick the stricter of two values. Shared by every client so that "which value
 * wins" is never a per-implementation judgement call.
 */
export function stricter(a: unknown, b: unknown, dir: Strictness): unknown {
  if (typeof dir === 'object' && dir.kind === 'ordinal') {
    const ia = dir.order.indexOf(a as string)
    const ib = dir.order.indexOf(b as string)
    // An unrecognized member is treated as strictest. If a tool adds a new
    // permission level we have never seen, refusing to loosen is the safe
    // default — the alternative silently downgrades an unknown restriction.
    if (ia === -1) return a
    if (ib === -1) return b
    return ia >= ib ? a : b
  }
  switch (dir) {
    case 'true-is-stricter':
      return a === true || b === true
    case 'false-is-stricter':
      return a === false || b === false ? false : a && b
    case 'lower-is-stricter':
      return Number(a) <= Number(b) ? a : b
    case 'higher-is-stricter':
      return Number(a) >= Number(b) ? a : b
    case 'intersection': {
      // Allowlists: permit only what BOTH sides permit.
      const bs = new Set(toArray(b).map(keyOf))
      return toArray(a).filter((v) => bs.has(keyOf(v)))
    }
    case 'union': {
      // Denylists: forbid everything EITHER side forbids.
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const v of [...toArray(a), ...toArray(b)]) {
        const k = keyOf(v)
        if (seen.has(k)) continue
        seen.add(k)
        out.push(v)
      }
      return out
    }
  }
}

const keyOf = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

// ---------------------------------------------------------------------------
// Diff → Plan
// ---------------------------------------------------------------------------

/**
 * Deterministic, browser-safe content fingerprint (FNV-1a, 128-bit-ish by
 * chaining four lanes). Deliberately NOT a crypto hash: plan ids only need to
 * be stable and identical across clients. Adversarial integrity is handled by
 * the Ed25519 signature over the bundle, not by this.
 */
export function fingerprint(input: string): string {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    for (let L = 0; L < lanes.length; L++) {
      lanes[L] = ((lanes[L] as number) ^ (c + L)) >>> 0
      lanes[L] = Math.imul(lanes[L] as number, 0x01000193) >>> 0
    }
  }
  return lanes.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('')
}

/**
 * Anything that can execute code on the developer's machine. Gating these is
 * the difference between a config tool and a remote-execution service.
 */
export function classifyRisk(path: string): Change['risk'] {
  if (/^hooks\./.test(path)) return 'code-execution'
  if (/^mcpServers\.[^.]+\.(command|args)/.test(path)) return 'code-execution'
  if (/^env\./.test(path)) return 'code-execution'
  if (/^apiKeyHelper$/.test(path)) return 'code-execution'
  if (/^statusLine\./.test(path)) return 'code-execution'
  if (/^permissions\.(allow|defaultMode)/.test(path)) return 'elevated'
  if (/^extraKnownMarketplaces\./.test(path)) return 'elevated'
  return 'none'
}

export function buildPlan(args: {
  deviceId: string
  toolId: ToolId
  /**
   * A single document, diffed against `observed[0]`. Convenient for tools whose
   * config lives in one place.
   */
  desired?: Record<string, unknown>
  /**
   * Desired state keyed by store id, each diffed against its OWN observed doc.
   *
   * Needed because `Change.storeId` always implied a plan could span stores,
   * while the implementation attributed everything to `observed[0]` — so
   * multi-store tools (and subtree descriptors over one file) were not
   * expressible. Callers no longer have to smuggle intent through array order.
   */
  desiredByStore?: Record<string, Record<string, unknown>>
  observed: ConfigDoc[]
  rules: KeyRule[]
  /** Managed-scope docs, so we can flag writes that policy will override. */
  managed?: Record<string, unknown>
  /** Injected — this function must stay pure, so it never reads the clock. */
  now: string
}): Plan {
  const { deviceId, toolId, observed, rules, managed = {}, now } = args
  const changes: Change[] = []
  const warnings: string[] = []
  const baseHashes: Record<string, string> = {}

  for (const doc of observed) baseHashes[doc.storeId] = doc.hash

  const byId = new Map(observed.map((d) => [d.storeId, d]))
  const primary = observed[0]

  // Normalize both call styles into one list of (store, desired) pairs, so the
  // diff loop below has a single shape to reason about.
  const units: Array<{
    storeId: string
    current: Record<string, unknown>
    desired: Record<string, unknown>
  }> = args.desiredByStore
    ? Object.entries(args.desiredByStore).map(([storeId, want]) => ({
        storeId,
        current: (byId.get(storeId)?.data as Record<string, unknown>) ?? {},
        desired: want,
      }))
    : [
        {
          storeId: primary?.storeId ?? `${toolId}:user:settings`,
          current: (primary?.data as Record<string, unknown>) ?? {},
          desired: args.desired ?? {},
        },
      ]

  for (const unit of units) {
    const current = unit.current
    const desired = unit.desired
    const targetStoreId = unit.storeId

    for (const [path, after] of flatten(desired)) {
      const rule = ruleFor(rules, path)
      if (rule.merge === 'never') continue

      const before = getPath(current, path)
      if (deepEqual(before, after)) continue

      // Shape-independent floor. The `never-sync` rule above is the precise
      // defence, but it only fires when the document is the shape the rules were
      // written for — and adapters accept more than one. Drop anything
      // secret-shaped that the rules did not already classify never-sync, rather
      // than trusting the caller passed the right shape.
      if (rule.portability !== 'never-sync') {
        const leaks = scanForSecrets(after, path)
        if (leaks.length) {
          const reason = leaks.map((l) => `${l.path}: ${l.reason}`).join('; ')
          warnings.push(
            `Refused to sync "${path}" — ${reason}. ` +
              `Store it in the device keychain and reference it as \${secret:<name>}.`,
          )
          // Report it, but strip the value here so the real credential never
          // enters the Plan. `apply()` refuses anything carrying `blocked`.
          changes.push({
            storeId: targetStoreId,
            // A withheld secret is still an item a person recognises, so it
            // carries the same identity as any other change.
            concept: conceptFor(targetStoreId),
            op: before === undefined ? 'create' : 'update',
            path,
            after: REDACTED,
            reason: 'contains a secret-shaped value',
            blocked: { reason },
            risk: classifyRisk(path),
          })
          continue
        }
      }

      const overriddenBy = getPath(managed, path) !== undefined ? ('managed' as const) : undefined
      if (overriddenBy) {
        warnings.push(
          `"${path}" is set by an organization policy that cannot be overridden — this write will have no effect.`,
        )
      }

      changes.push({
        storeId: targetStoreId,
        // Identity, so a plan renders without a side table mapping changes back
        // to things a person recognises. `conceptFor` is a pure function of the
        // store id, so this costs the caller nothing.
        concept: conceptFor(targetStoreId),
        op: before === undefined ? 'create' : 'update',
        path,
        before,
        after,
        reason: `desired (${rule.merge}) differs from observed`,
        // Conditional spread, not `overriddenBy: undefined` — under
        // exactOptionalPropertyTypes an explicit undefined is a distinct state,
        // and it would also serialize into the signed bundle as a real key.
        ...(overriddenBy ? { overriddenBy } : {}),
        risk: classifyRisk(path),
      })
    }
  }

  // Id covers the changes and the hashes they were computed against, but NOT
  // `now` — otherwise the same plan computed a second later would get a new id
  // and invalidate an approval that is still perfectly valid.
  const id = fingerprint(JSON.stringify({ deviceId, toolId, changes, baseHashes }))

  // Omit `createdAt` rather than carrying an empty string: adapters call this
  // with now:'' to stay pure, and a key whose value means "unset" is worse than
  // an absent optional key.
  return {
    id,
    ...(now ? { createdAt: now } : {}),
    deviceId,
    toolId,
    changes,
    baseHashes,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const toArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/**
 * The path of a whole document. Used when the root is not an object — a
 * top-level JSON array, which several real config files are (Zed's
 * `keymap.json` and `tasks.json`, the latter being a list of shell commands).
 *
 * This previously returned `[]` for such files, so the reconcile engine emitted
 * zero changes and reported success while silently syncing nothing. Object
 * roots are the only shape Claude Code and Cursor use, which is why it went
 * unnoticed until a tool with array-rooted config showed up.
 */
export const ROOT_PATH = ''

/** Leaf-wise flatten. Arrays are leaves — we never index into them by position. */
export function flatten(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value === undefined) return []
  // A non-object root is a leaf AT the root, not an empty document.
  if (!isPlainObject(value)) return [[prefix, value]]
  const out: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v)) out.push(...flatten(v, path))
    else out.push([path, v])
  }
  return out
}

export function getPath(obj: unknown, path: string): unknown {
  if (path === ROOT_PATH) return obj
  // A LITERAL key wins over dot-splitting, so `flatten` and `getPath` stay
  // inverses. Directory stores key by filename — `reviewer.md` is one key, not
  // `reviewer` → `md`. Without this, `before` was always undefined, so every
  // sub-agent looked like a fresh `create` on every sync, forever.
  if (isPlainObject(obj) && path in obj) return obj[path]
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[seg]
  }
  return cur
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (path === ROOT_PATH)
    // Callers must replace the document wholesale; we cannot rebind the caller's
    // reference from here, and silently writing to a `''` key would corrupt it.
    throw new Error('setPath cannot write the document root — replace the document instead')
  // Mirror getPath: an existing literal key is written in place rather than
  // being split into a nested object it was never meant to become.
  if (path in obj) {
    obj[path] = value
    return
  }
  const segs = path.split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i] as string
    if (!isPlainObject(cur[s])) cur[s] = {}
    cur = cur[s] as Record<string, unknown>
  }
  cur[segs[segs.length - 1] as string] = value
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}
