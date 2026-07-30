/**
 * The layer between the commands and the core engine.
 *
 * Two jobs:
 *
 *  1. Turn `StoreDescriptor`s into something printable — a display path, does
 *     it exist, did reading it fail and why. `status` and `doctor` both need
 *     this and neither should be re-deriving it.
 *
 *  2. Mirror the apply engine's phase-1 validation *without writing*, so
 *     `diff` and `apply --dry-run` can tell a user "this change will be
 *     refused, here is why, here is what clears it" instead of making them run
 *     a real apply to find out. The mirror is deliberate duplication: the
 *     engine's copy is the one that protects the disk, this copy is the one
 *     that explains. If they ever disagree, the engine wins and this is a bug.
 */

import { join } from 'node:path'

import type {
  Change,
  ConfigDoc,
  Detection,
  HostEnv,
  Plan,
  ProjectContext,
  StoreDescriptor,
  StoreLocation,
  ToolAdapter,
} from '../core/types.js'
import type { LayerId } from '../core/control-plane.js'
import { resolve as resolveLayers } from '../core/reconcile.js'
import { normalizeDesired } from '../core/desired.js'
import { detectShadowing, type ShadowWarning } from '../core/liveness.js'
import type { CliFs } from './deps.js'

// ---------------------------------------------------------------------------
// Store description
// ---------------------------------------------------------------------------

/** True for locations that are a path on this filesystem. */
export function isPathLocation(
  loc: StoreLocation,
): loc is Extract<StoreLocation, { kind: 'file' | 'dir' | 'dropin' }> {
  return loc.kind === 'file' || loc.kind === 'dir' || loc.kind === 'dropin'
}

/** Same rule the apply engine uses: drive letters and leading separators. */
export function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
}

export function resolveStorePath(loc: StoreLocation, cwd: string): string | undefined {
  if (!isPathLocation(loc)) return undefined
  return isAbsolutePath(loc.path) ? loc.path : join(cwd, loc.path)
}

/** A one-line, human description of where a store lives. */
export function describeLocation(loc: StoreLocation, cwd: string): string {
  switch (loc.kind) {
    case 'file':
    case 'dir':
    case 'dropin':
      return resolveStorePath(loc, cwd) as string
    case 'plist':
      return `macOS managed preferences domain ${loc.domain}`
    case 'registry':
      return `${loc.hive}\\${loc.key}\\${loc.value}`
    case 'remote':
      return `delivered at sign-in by ${loc.provider}`
  }
}

export interface StoreProbe {
  store: StoreDescriptor
  /** Filesystem path, when the store has one. */
  path: string | undefined
  location: string
  exists: boolean
  /** Undefined when we did not or could not read it. */
  hash: string | undefined
  doc: ConfigDoc | undefined
  /** Set when reading threw — an invalid JSON file, a permission error. */
  error: string | undefined
  /** Why we did not even try. */
  notProbed: string | undefined
}

export interface ProbeOptions {
  /** Read and hash contents, not just test for existence. Slower. */
  read?: boolean
}

export async function probeStore(
  adapter: ToolAdapter,
  host: HostEnv,
  store: StoreDescriptor,
  fs: CliFs,
  cwd: string,
  options: ProbeOptions = {},
): Promise<StoreProbe> {
  const location = describeLocation(store.location, cwd)
  const path = resolveStorePath(store.location, cwd)

  const base: StoreProbe = {
    store,
    path,
    location,
    exists: false,
    hash: undefined,
    doc: undefined,
    error: undefined,
    notProbed: undefined,
  }

  if (!isPathLocation(store.location)) {
    // plist / registry / remote need a platform channel no adapter owns yet.
    // Reporting "not probed" beats reporting "absent", which would read as
    // "your org has no policy" when the truth is "we did not look".
    return { ...base, notProbed: `${store.location.kind} stores need a platform channel we do not have yet` }
  }
  if (!store.readable) return { ...base, notProbed: 'store is declared unreadable' }

  const exists = path !== undefined ? await fs.exists(path) : false
  if (!options.read) return { ...base, exists }

  try {
    const doc = await adapter.read(store, host)
    return { ...base, exists: doc.exists, hash: doc.hash, doc }
  } catch (err) {
    return { ...base, exists, error: (err as Error).message }
  }
}

export interface ToolProbe {
  adapter: ToolAdapter
  detection: Detection
  stores: StoreProbe[]
  /** Set when `detect()` itself threw. */
  error: string | undefined
}

export async function probeTool(
  adapter: ToolAdapter,
  host: HostEnv,
  fs: CliFs,
  cwd: string,
  options: ProbeOptions & { project?: ProjectContext } = {},
): Promise<ToolProbe> {
  let detection: Detection = { installed: false, present: [] }
  let error: string | undefined
  try {
    detection = await adapter.detect(host)
  } catch (err) {
    error = (err as Error).message
  }

  const descriptors = adapter.locations(host, options.project)
  const stores: StoreProbe[] = []
  for (const store of descriptors) {
    stores.push(await probeStore(adapter, host, store, fs, cwd, options))
  }
  return { adapter, detection, stores, error }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * The store a generic desired-state document is written to.
 *
 * `buildPlan` attributes every change to `observed[0]`, so for Claude Code the
 * CLI must put the primary user settings store first and nothing else may be
 * mistaken for it. Picking "first writable, syncable, user-scope file store"
 * is that rule stated once.
 */
export function pickPrimaryStore(stores: StoreDescriptor[]): StoreDescriptor | undefined {
  return stores.find(
    (s) => s.scope === 'user' && s.writable && s.syncable && s.location.kind === 'file' && !s.subtree,
  )
}

export interface ComputePlanInput {
  adapter: ToolAdapter
  host: HostEnv
  layers: Array<{ id: LayerId; data: unknown }>
  fs: CliFs
  cwd: string
  now: string
  project?: ProjectContext
}

export interface PlanBundle {
  plan: Plan
  observed: ConfigDoc[]
  primary: StoreDescriptor | undefined
  /** Stores that could not be read, so the caller can say so out loud. */
  readErrors: Array<{ storeId: string; error: string }>
  /** The merged desired document, after layering. Redact before printing. */
  desired: unknown
  /**
   * Existing files this plan would silently stop the tool from reading, via a
   * first-match-wins instruction chain. Empty for tools with no such chain.
   */
  shadowing: ShadowWarning[]
}

export async function computePlan(input: ComputePlanInput): Promise<PlanBundle> {
  const { adapter, host, layers, fs, cwd, now, project } = input
  const descriptors = adapter.locations(host, project)
  const primary = pickPrimaryStore(descriptors)

  const rules = adapter.rules(primary?.id)
  const { value: desired } = resolveLayers(layers, rules, host)

  // Order matters and is load-bearing: primary first (buildPlan's `observed[0]`
  // is the write target), then managed scopes (used for override detection),
  // then everything else readable.
  const ordered: StoreDescriptor[] = []
  if (primary) ordered.push(primary)
  for (const s of descriptors) {
    if (s === primary) continue
    if (!s.readable) continue
    if (s.location.kind !== 'file' && s.location.kind !== 'dropin') continue
    ordered.push(s)
  }
  ordered.sort((a, b) => {
    const rank = (s: StoreDescriptor) => (s === primary ? 0 : s.scope === 'managed' ? 1 : 2)
    return rank(a) - rank(b)
  })

  const observed: ConfigDoc[] = []
  const readErrors: Array<{ storeId: string; error: string }> = []
  for (const store of ordered) {
    const probe = await probeStore(adapter, host, store, fs, cwd, { read: true })
    if (probe.error !== undefined) {
      readErrors.push({ storeId: store.id, error: probe.error })
      continue
    }
    if (probe.doc) observed.push(probe.doc)
  }

  // Desired state comes off disk untyped, so normalize it once here rather
  // than letting each adapter sniff the shape for itself.
  const raw = adapter.plan(normalizeDesired(desired), observed, host)
  // `plan()` is pure and must never read the clock, so it leaves `createdAt`
  // empty. The CLI is the caller that has one.
  const plan: Plan = { ...raw, createdAt: now }

  // A store the plan never touches can still be the casualty, so this is
  // answered from on-disk presence rather than from the changeset.
  const observedIds = new Set(observed.filter((d) => d.exists).map((d) => d.storeId))
  const shadowing = detectShadowing(ordered, plan.changes, (id) => observedIds.has(id))

  return { plan, observed, primary, readErrors, desired, shadowing }
}

// ---------------------------------------------------------------------------
// Preflight — the read-only mirror of apply-engine phase 1
// ---------------------------------------------------------------------------

export type BlockReason =
  | 'unknown-store'
  | 'not-writable'
  | 'managed'
  | 'inferred-provenance'
  | 'unsupported-location'

export interface BlockedChange {
  change: Change
  reason: BlockReason
  explain: string
  remedy: string
}

export interface Preflight {
  writable: Change[]
  blocked: BlockedChange[]
  /** True when there is work to do but provenance is the only thing stopping it. */
  provenanceIsTheOnlyBlocker: boolean
}

export function preflight(adapter: ToolAdapter, host: HostEnv, plan: Plan, project?: ProjectContext): Preflight {
  const stores = new Map(adapter.locations(host, project).map((s) => [s.id, s]))
  const writable: Change[] = []
  const blocked: BlockedChange[] = []

  for (const change of plan.changes) {
    const store = stores.get(change.storeId)

    if (!store) {
      blocked.push({
        change,
        reason: 'unknown-store',
        explain: `"${change.storeId}" is not a store ${adapter.id} declares on this host.`,
        remedy: 'This is a bug in the desired state or the adapter. Re-run `agentsync diff` and report it if it persists.',
      })
      continue
    }
    if (store.scope === 'managed' || !store.writable) {
      blocked.push({
        change,
        reason: store.scope === 'managed' ? 'managed' : 'not-writable',
        explain:
          store.scope === 'managed'
            ? `"${store.id}" is managed by organization policy — read-only, and it would override us anyway.`
            : `"${store.id}" is declared read-only by the ${adapter.displayName} adapter.`,
        remedy:
          store.scope === 'managed'
            ? 'Ask whoever administers the policy; nothing on this device can change it.'
            : 'Nothing to do — this store is observable but not a write target.',
      })
      continue
    }
    if (store.provenance === 'inferred') {
      blocked.push({
        change,
        reason: 'inferred-provenance',
        explain:
          `The path for "${store.id}" is unverified on ${host.os}` +
          `${host.runtime === 'wsl' ? '/wsl' : ''} — we reasoned it from convention rather than ` +
          'confirming it against a real install.',
        remedy:
          'Writing somewhere we only guessed could corrupt an unrelated file, so it is refused. ' +
          'The cross-OS conformance job is what promotes these to verified.',
      })
      continue
    }
    if (store.location.kind !== 'file') {
      blocked.push({
        change,
        reason: 'unsupported-location',
        explain: `"${store.id}" is a ${store.location.kind} store, not a file.`,
        remedy: 'It needs a platform channel (MDM / registry / vendor API) the adapter does not own yet.',
      })
      continue
    }
    writable.push(change)
  }

  const provenanceIsTheOnlyBlocker =
    writable.length === 0 && blocked.length > 0 && blocked.every((b) => b.reason === 'inferred-provenance')

  return { writable, blocked, provenanceIsTheOnlyBlocker }
}

// ---------------------------------------------------------------------------

export interface RiskCounts {
  none: number
  elevated: number
  'code-execution': number
}

export function countRisks(changes: Change[]): RiskCounts {
  const out: RiskCounts = { none: 0, elevated: 0, 'code-execution': 0 }
  for (const c of changes) out[c.risk]++
  return out
}

export function codeExecutionChanges(changes: Change[]): Change[] {
  return changes.filter((c) => c.risk === 'code-execution')
}
