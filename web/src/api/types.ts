/**
 * View types.
 *
 * The domain model lives in `@core/types` and `@core/control-plane` and is owned
 * by the CLI workstream. Nothing here redeclares it. What this file adds is the
 * projection ONE SCREEN needs: a source machine, the things on it, and every
 * other machine as a row.
 *
 * Rule of thumb: if a device has to agree on it, it belongs in @core. If it only
 * exists so a person can read it, it belongs here.
 *
 * Two things are deliberately absent:
 *
 *   - No local "why can't this be written" enum. `writeVerdict()` in @core owns
 *     that question and its six reasons, reached through `lib/verdict.ts`.
 *   - No side table mapping changes back to items. `Change.concept` is
 *     populated by `buildPlan`, and grouping reads it directly.
 */

import type {
  AdapterCapabilities,
  Change,
  Concept,
  Detection,
  HostEnv,
  Plan,
  Scope,
  StoreDescriptor,
  ToolId,
} from '@core/types'
import type {
  AutoSyncPolicy,
  EnumerationMode,
  EnumerationPolicy,
  Snapshot,
} from '@core/control-plane'
import type { ShadowWarning } from '@core/liveness'
import type { Refusal } from '../lib/verdict'

export type {
  AutoSyncPolicy,
  Concept,
  EnumerationMode,
  EnumerationPolicy,
  Refusal,
  ShadowWarning,
  Snapshot,
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

export type DeviceStatus =
  /** Reporting in right now. */
  | 'online'
  /** Paired and healthy, but has not checked in recently. */
  | 'idle'
  /** Has not been heard from in long enough to be worth saying so. */
  | 'offline'
  /** Paired, but has never sent a report — nothing is set up on it yet. */
  | 'new'

/**
 * What one adapter reported for one machine.
 *
 * Carried per device rather than globally because `capabilities.apply` is the
 * answer to "why did nothing happen on that laptop", and that question is always
 * asked about a specific machine. Fed straight into `writeVerdict`.
 */
export interface ToolPresence {
  toolId: ToolId
  displayName: string
  detection: Detection
  capabilities: AdapterCapabilities
}

export interface Device {
  /** Mirrors `host.deviceId`. Lifted so lists don't reach through the host. */
  id: string
  /** User-editable label. `HostEnv` deliberately has no name field. */
  name: string
  host: HostEnv
  status: DeviceStatus
  /** ISO-8601. `undefined` on a machine that has never reported. */
  lastSeen?: string
  agentVersion?: string
  isSource: boolean
  tools: ToolPresence[]
  /** From `adapter.locations(host, ctx)` — the real path table, not a fixture. */
  stores: StoreDescriptor[]
  /** Which secret store this host resolved to. Changes what to expect. */
  secretBackend: 'keychain' | 'dpapi' | 'libsecret' | 'encrypted-file' | 'none'
  /**
   * The machine has asked to be left alone — a live session, a quiet-hours
   * window. A send to it comes back `deferred`, which is neither applied nor
   * failed. See `ApplyResult.deferred`.
   */
  busy?: { reason: string; retryAfter?: string }
}

// ---------------------------------------------------------------------------
// The things on the source machine
// ---------------------------------------------------------------------------

/**
 * One thing a person thinks they have — "the GitHub connection", "your standing
 * instructions". Coarser than a `Change` (a dot path in one store) and finer
 * than a `StoreDescriptor` (which can hold several unrelated ideas at once).
 */
export interface ConfigItem {
  id: string
  concept: Concept
  /** "GitHub connection" — never `mcpServers.github.command`. */
  label: string
  /** "Lets Claude read your repos and issues." */
  blurb: string

  /** Every real store that files this same idea, with the path inside each. */
  anchors: ItemAnchor[]
  /** Tools that file it. Length > 1 is the entire point of `Concept`. */
  toolNames: string[]
  /** The technical name, revealed on request. Nobody needs it to decide. */
  technicalKey: string
  scope: Scope

  /** Highest `Change.risk` across the changes this item produces. */
  risk: Change['risk']
  /**
   * False when every store filing this is `syncable: false`. These are the
   * "stays put" items — different on purpose, or meaningless elsewhere.
   */
  syncable: boolean
  /** Why it stays put, in one phrase. Only set when `syncable` is false. */
  staysPutBecause?: string

  /** Machine ids where this differs from the source. */
  differsOn: string[]
  /** Machine ids where nothing can take it, and core's reason. */
  refusedOn: Record<string, Refusal>

  /**
   * The engine held the value back — it was secret-shaped. From
   * `Change.blocked`, which is reported rather than dropped precisely so a diff
   * cannot claim "already in the desired state" about something it refused to
   * carry.
   */
  withheld?: { reason: string }
  /** Machines where a higher layer wins whatever we write. `Change.overriddenBy`. */
  overriddenOn: Record<string, Scope>
  /** Machines where the write lands and does nothing, for another reason. `Change.inert`. */
  inertOn: Record<string, string>

  /**
   * Other items that live in the same physical file, via `StoreDescriptor.fileId`.
   * Shown as a note: changing both is one atomic write, not two.
   */
  filePeers: string[]
  /** Set when this item is one branch of a shared file. `StoreDescriptor.subtree`. */
  subtree?: string
}

export interface ItemAnchor {
  storeId: string
  /** Dot path inside the store document. `''` addresses the whole document. */
  path: string
  /** Human-readable location — a path, a policy domain, a vendor name. */
  where: string
  toolId: ToolId
}

/**
 * A `Concept` worth of items, plus the sentence that explains why the whole
 * group behaves the way it does.
 *
 * The notes are not editorial. Each one is derived: from `writeVerdict`'s own
 * remedy for a marketplace directory, from the `MergeStrategy` the adapter
 * declares for permission rules, from the presence or absence of
 * `StoreLocation.entryFile`.
 */
export interface ItemGroup {
  key: string
  title: string
  note?: string
  items: ConfigItem[]
  total: number
  differing: number
}

// ---------------------------------------------------------------------------
// Every other machine, as a row
// ---------------------------------------------------------------------------

export type MachineState =
  /** Has things the source does not. */
  | 'differs'
  /** Byte-identical on everything that travels. */
  | 'in-sync'
  /** Paired but never reported. Nothing is set up on it. */
  | 'new'
  /** Nothing can be written here at all, and core says why. */
  | 'blocked'

export interface MachineRow {
  device: Device
  state: MachineState
  /** Items that differ. Empty when `in-sync`. */
  differing: string[]
  /** What is missing, grouped the way the source panel groups it. */
  missing: Array<{ title: string; labels: string[] }>
  /**
   * Things this machine specifically cannot take, with core's own reason,
   * collapsed one row per reason so a Windows laptop says "Claude Code's
   * settings paths are unverified here" once rather than eleven times.
   */
  refused: Array<{ refusal: Refusal; labels: string[] }>
  /** Set on `blocked`. The single most useful of core's refusals for this machine. */
  refusal?: Refusal
  /** `Change.overriddenBy` — org policy wins here. */
  overridden: Array<{ label: string; scope: Scope }>
  /** `Change.inert` — the write lands and changes nothing. */
  inert: Array<{ label: string; reason: string }>
  /** `Change.blocked` — held back at source. */
  withheld: Array<{ label: string; reason: string }>
  /** `detectShadowing()` — a create that silently switches an existing file off. */
  shadowWarnings: ShadowWarning[]
  /** Mirrors `ApplyResult.deferred`. Neither success nor failure. */
  deferred?: { reason: string; retryAfter?: string }
  /** Facts about the machine itself, in plain words. Keyring, symlinks, evidence. */
  notes: string[]
  /** `Detection.confidence === 'weak'` — installed, but only a file says so. */
  weakDetection: string[]
}

// ---------------------------------------------------------------------------
// The whole screen, in one response
// ---------------------------------------------------------------------------

export interface Bench {
  source: Device
  /** Every machine, source included, for the `change` control. */
  devices: Device[]
  groups: ItemGroup[]
  /** Flat, for counting and for the send. */
  items: ConfigItem[]
  machines: MachineRow[]
  totals: {
    /** Everything the source has, including what stays put. */
    tracked: number
    /** Items that differ on at least one machine that can take them. */
    differing: number
    /** Real stores in the source's path table. Straight from the adapters. */
    stores: number
    /** Of those, how many `writeVerdict` clears for writing. */
    writableStores: number
  }
}

// ---------------------------------------------------------------------------
// The transfer
// ---------------------------------------------------------------------------

export interface SyncSelection {
  sourceDeviceId: string
  itemIds: string[]
  targetDeviceIds: string[]
}

/**
 * What is about to happen, per destination.
 *
 * Each target computes its OWN outcome — the same send produces different
 * changes on a Mac and a Windows box, because each machine diffs against its own
 * observed state. One shared answer would be lying to at least one machine.
 */
export interface SyncPreview {
  previewId: string
  sourceDeviceId: string
  targets: TargetPreview[]
}

export interface TargetPreview {
  deviceId: string
  deviceName: string
  plan: Plan
  /** Changes that land with no further input. */
  automatic: Change[]
  /**
   * `risk: 'code-execution'`, grouped into the thing a person would say yes to.
   *
   * The engine binds an approval to a plan INDEX, and one recognisable item is
   * routinely several indexes: the GitHub connection is filed by three tools and
   * contributes both a `command` and an `args` change in each. Four identical
   * `npx` checkboxes is not something anyone can meaningfully consent to, so the
   * question is asked once per item per machine and answered into every index it
   * covers.
   */
  needsApproval: ApprovalGroup[]
  /** `Change.blocked` — withheld at source, never in the plan's payload. */
  withheld: Change[]
  /** `Change.inert` or `Change.overriddenBy` — lands, changes nothing. */
  noEffect: Change[]
  /** Never reached the plan: `writeVerdict` said no. */
  refused: Array<{ label: string; refusal: Refusal }>
  shadowWarnings: ShadowWarning[]
  deferred?: { reason: string; retryAfter?: string }
}

export interface ApprovalGroup {
  /** What a person calls it. */
  label: string
  /** Plan indexes this covers. Saying yes says yes to each of them. */
  indexes: number[]
  /** The literal commands that will run, deduped. */
  commands: string[]
  /** The files they land in, deduped. */
  wheres: string[]
}

export interface SyncResult {
  previewId: string
  devices: Array<{
    deviceId: string
    deviceName: string
    /** `held` = nothing to do. `waiting` mirrors `ApplyResult.deferred`. */
    outcome: 'applied' | 'partial' | 'held' | 'refused' | 'waiting'
    appliedCount: number
    note?: string
    deferred?: { reason: string; retryAfter?: string }
    /** Backup taken before the write, so this is undoable. */
    snapshotId?: string
  }>
}

// ---------------------------------------------------------------------------
// Behind the ··· button. None of this is a permanent surface.
// ---------------------------------------------------------------------------

export interface PairingSession {
  pairingId: string
  /** 8 chars, single-use, 5 minute TTL. Shown here, typed on the machine. */
  shortCode: string
  expiresAt: string
  claimedBy?: { deviceId: string; name: string; host: HostEnv }
}

export interface SecretsSettings {
  enabled: boolean
  /** ISO-8601. When the recovery phrase was last shown and confirmed saved. */
  phraseSavedAt?: string
}

export interface AccountSettings {
  secrets: SecretsSettings
  enumeration: EnumerationPolicy
  autoSync: AutoSyncPolicy
}
