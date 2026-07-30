/**
 * The single seam between this screen and a backend.
 *
 * `ControlPlaneClient` is the whole contract. Today it is satisfied by
 * `createMockClient()` below the fence. When the service exists, add
 * `createHttpClient()` here and flip `createClient()` — nothing outside this file
 * should need to change.
 *
 * INVARIANT: this client never touches a filesystem. `applySync` enqueues work
 * for the device agent; what comes back is what the device reported. The web app
 * only ever edits intent.
 *
 * FOUR PIECES OF CORE LOGIC ARE CALLED HERE RATHER THAN REIMPLEMENTED. That is
 * the point of the file:
 *
 *   adapter.locations()  the real store table per host — 73 stores on macOS, not
 *                        a fixture and not a summary of one
 *   buildPlan()          the real diff. `Change.concept`, `Change.risk`,
 *                        `Change.blocked` and `Change.overriddenBy` all come out
 *                        of it, so the UI groups and gates on the engine's own
 *                        answers instead of a side table
 *   writeVerdict()       whether a store can be written, and which of the six
 *                        reasons wins. Reached through `lib/verdict`
 *   detectShadowing()    which existing files a create would silently switch
 *                        off, computed per target from that target's own stores
 */

import { detectShadowing } from '@core/liveness'
import { buildPlan, deepEqual, getPath, setPath } from '@core/reconcile'
import type {
  Change,
  ConfigDoc,
  Detection,
  Plan,
  Scope,
  StoreDescriptor,
  ToolId,
} from '@core/types'
import type { EnumerationMode, Snapshot } from '@core/control-plane'
import type {
  AccountSettings,
  ApprovalGroup,
  Bench,
  ConfigItem,
  Device,
  ItemAnchor,
  ItemGroup,
  MachineRow,
  MachineState,
  PairingSession,
  SyncPreview,
  SyncResult,
  SyncSelection,
  TargetPreview,
  ToolPresence,
} from './types'
import * as fx from './fixtures'
import { ADAPTERS, adapterFor, displayNameOf, storesFor, toolIdOf } from './inventory'
import { machineRefusals, refuseItem, refuseStore, type Refusal } from '../lib/verdict'
import {
  CONCEPT_ORDER,
  CONCEPT_TITLE,
  hostNotes,
  MERGE_SENTENCE,
  STAYS_PUT,
  whereIs,
} from '../lib/words'
import { ruleFor } from '@core/reconcile'

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface ControlPlaneClient {
  /** Everything the one screen needs, for one choice of source machine. */
  getBench(sourceDeviceId?: string): Promise<Bench>
  /** Promotion is explicit and audited — never implicit, never silent. */
  setSourceDevice(deviceId: string): Promise<Bench>

  previewSync(selection: SyncSelection): Promise<SyncPreview>
  /**
   * `approvedIndexes` maps device id -> indexes into that device's plan that the
   * person explicitly said yes to. A code-execution change without one is
   * rejected here, and would be rejected again by the device.
   */
  applySync(previewId: string, approvedIndexes: Record<string, number[]>): Promise<SyncResult>

  // ---- behind the ··· button. None of this is a permanent surface. --------
  renameDevice(deviceId: string, name: string): Promise<void>
  /** Refuses to remove the source. Everything comes from it. */
  removeDevice(deviceId: string): Promise<void>
  startPairing(): Promise<PairingSession>
  cancelPairing(pairingId: string): Promise<void>

  listSnapshots(): Promise<Snapshot[]>
  createSnapshot(deviceId: string): Promise<Snapshot[]>
  restoreSnapshot(snapshotId: string): Promise<{ restored: number; unresolvedSecrets: string[] }>

  getSettings(): Promise<AccountSettings>
  setSecretsSync(enabled: boolean): Promise<AccountSettings>
  setAutoSync(input: { enabled: boolean; autoApplyCodeExecution: boolean }): Promise<AccountSettings>
  /** Widening always has to be confirmed on the machine itself. */
  requestEnumerationChange(mode: EnumerationMode): Promise<AccountSettings>
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function createClient(): ControlPlaneClient {
  return createMockClient()
}

export const client = createClient()

// ===========================================================================
// ============================ MOCK IMPLEMENTATION ==========================
// ===========================================================================
// Fixture-backed for store CONTENTS only; store STRUCTURE is read live from the
// adapters. Holds mutable in-memory state so edits survive within a session.
// Delete wholesale once createHttpClient() is real.
// ===========================================================================

const LATENCY = { fast: 90, normal: 200 }

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/**
 * A content hash stand-in.
 *
 * The real one is `sha256Hex` from `platform/canonical.ts`, which needs
 * `node:crypto`. Hashes are only used here to populate `Plan.baseHashes`, which
 * a device compares against its own disk before applying — so a mock that never
 * applies anything needs determinism, not cryptography.
 */
function contentHash(value: unknown): string {
  const s = JSON.stringify(value) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Mutable session state
// ---------------------------------------------------------------------------

const seeds = fx.deviceSeeds.map((d) => ({ ...d }))
let sourceId = fx.sourceDeviceId
let settings: AccountSettings = structuredClone(fx.settings)
let snapshots: Snapshot[] = structuredClone(fx.snapshots)
const previews = new Map<string, SyncPreview>()
let pairing: PairingSession | undefined

// ---------------------------------------------------------------------------
// Devices — real stores, fixture presence
// ---------------------------------------------------------------------------

function detectionFor(seed: fx.DeviceSeed, toolId: ToolId, stores: StoreDescriptor[]): Detection {
  const owned = stores.filter((s) => toolIdOf(s.id) === toolId).map((s) => s.id)
  return {
    installed: true,
    present: seed.present.filter((id) => owned.includes(id)),
    confidence: seed.tools.find((t) => t.toolId === toolId)?.confidence ?? 'weak',
  }
}

function buildDevice(seed: fx.DeviceSeed): Device {
  // The real path table for this (tool x OS) cell. Not filtered by what is
  // installed: a store that exists in the table but whose tool is absent is a
  // `tool-not-installed` refusal, which is a different and more useful fact
  // than the store not existing.
  const stores = storesFor(seed.host, fx.PROJECT)

  const tools: ToolPresence[] = seed.tools.map((t) => {
    const adapter = adapterFor(t.toolId)
    return {
      toolId: t.toolId,
      displayName: displayNameOf(t.toolId),
      detection: detectionFor(seed, t.toolId, stores),
      capabilities: adapter?.capabilities ?? { apply: false },
    }
  })

  const device: Device = {
    id: seed.id,
    name: seed.name,
    host: seed.host,
    status: seed.status,
    isSource: seed.id === sourceId,
    tools,
    stores,
    secretBackend: seed.secretBackend,
  }
  if (seed.lastSeen) device.lastSeen = seed.lastSeen
  if (seed.agentVersion) device.agentVersion = seed.agentVersion
  if (seed.busy) device.busy = seed.busy
  return device
}

function devices(): Device[] {
  return seeds.map(buildDevice)
}

// ---------------------------------------------------------------------------
// Documents — the fixture half
// ---------------------------------------------------------------------------

type Docs = Record<string, Record<string, unknown>>

/**
 * Assemble each store's document from the item seeds a machine actually has.
 *
 * `kind: 'member'` seeds append to a list rather than setting a leaf, because
 * that is genuinely how permission rules behave — the adapter declares
 * `merge: 'union-list'` for `permissions.allow`, so rules accumulate across
 * scopes instead of replacing one another.
 */
function documentsFor(deviceId: string, known: Set<string>): Docs {
  const delta = fx.deviceDeltas[deviceId] ?? { absent: [], differing: {} }
  const absent = new Set(delta.absent)
  const docs: Docs = {}

  for (const seed of fx.itemSeeds) {
    if (absent.has(seed.id)) continue
    for (const anchor of seed.anchors) {
      if (!known.has(anchor.storeId)) continue
      const doc = (docs[anchor.storeId] ??= {})
      if (seed.kind === 'member') {
        const list = (getPath(doc, anchor.path) as unknown[] | undefined) ?? []
        setPath(doc, anchor.path, [...list, seed.member])
      } else {
        const override = Object.prototype.hasOwnProperty.call(delta.differing, seed.id)
        setPath(doc, anchor.path, override ? delta.differing[seed.id] : seed.value)
      }
    }
  }
  return docs
}

function observedDocs(docs: Docs, present: Set<string>): ConfigDoc[] {
  return Object.entries(docs).map(([storeId, data]) => ({
    storeId,
    data,
    hash: contentHash(data),
    exists: present.has(storeId),
  }))
}

// ---------------------------------------------------------------------------
// The plan — core's own diff, per target, per tool
// ---------------------------------------------------------------------------

interface TargetPlan {
  device: Device
  plans: Plan[]
  changes: Change[]
  /** Stores that never reached a plan, with core's reason. */
  refusedStores: Map<string, Refusal>
  /** What this machine holds today, per store. */
  docs: Docs
  /** Stores that both travel and can be written here. */
  sendable: Set<string>
}

/**
 * A store participates in a send when it is syncable AND `writeVerdict` clears
 * it. Both halves matter and they are different questions: `syncable: false` is
 * the adapter saying "this should not travel", `writeVerdict` is core saying
 * "this cannot be written here".
 */
function sendableStores(device: Device): {
  ok: StoreDescriptor[]
  refused: Map<string, Refusal>
} {
  const ok: StoreDescriptor[] = []
  const refused = new Map<string, Refusal>()
  for (const store of device.stores) {
    if (!store.syncable) continue
    const r = refuseStore(device, store)
    if (r) refused.set(store.id, r)
    else ok.push(store)
  }
  return { ok, refused }
}

function planFor(source: Device, target: Device, sourceDocs: Docs): TargetPlan {
  const { ok, refused } = sendableStores(target)
  const okIds = new Set(ok.map((s) => s.id))
  const present = new Set(target.tools.flatMap((t) => t.detection.present))
  const targetDocs = documentsFor(target.id, new Set(target.stores.map((s) => s.id)))
  const delta = fx.deviceDeltas[target.id]

  const plans: Plan[] = []
  const changes: Change[] = []

  for (const adapter of ADAPTERS) {
    const mine = ok.filter((s) => toolIdOf(s.id) === adapter.id)
    if (!mine.length) continue

    const desiredByStore: Record<string, Record<string, unknown>> = {}
    for (const store of mine) {
      const want = sourceDocs[store.id]
      if (want) desiredByStore[store.id] = want
    }
    if (!Object.keys(desiredByStore).length) continue

    const observed = observedDocs(
      Object.fromEntries(Object.entries(targetDocs).filter(([id]) => okIds.has(id))),
      present,
    )

    // Managed documents are handed in so `buildPlan` can mark anything an org
    // policy already sets as `overriddenBy: 'managed'`. Without them a write
    // that provably cannot take effect would be previewed as a success.
    const managed = delta?.managed
      ? Object.values(delta.managed).reduce<Record<string, unknown>>(
          (acc, doc) => ({ ...acc, ...doc }),
          {},
        )
      : {}

    const plan = buildPlan({
      deviceId: target.id,
      toolId: adapter.id,
      desiredByStore,
      observed,
      rules: adapter.rules(),
      managed,
      // buildPlan must stay pure, so it never reads a clock. Nothing here has
      // one worth reading either — the device stamps `createdAt` on apply.
      now: '',
    })
    plans.push(plan)
    changes.push(...plan.changes.map((c) => annotate(c, target)))
  }

  void source
  return {
    device: target,
    plans,
    changes,
    refusedStores: refused,
    docs: targetDocs,
    sendable: okIds,
  }
}

/**
 * Device-side annotation the pure planner cannot make.
 *
 * `Change.inert` is "the write will succeed and have no observable effect, for a
 * reason that is NOT a policy override". The Zed adapter documents exactly one
 * such case — it opens every worktree in Restricted Mode, where project settings
 * are not parsed at all — and raises it as a plan WARNING because trust state is
 * not readable from here. A warning is a string; `inert` is a field a UI can act
 * on, so the translation happens once, here, in the tier that models a device.
 */
function annotate(change: Change, target: Device): Change {
  const store = target.stores.find((s) => s.id === change.storeId)
  if (store && toolIdOf(store.id) === 'zed' && store.scope === 'project') {
    return {
      ...change,
      inert: {
        reason:
          'Zed opens every folder in Restricted Mode until you trust it, and does not read project settings before then. This lands correctly and does nothing until you do.',
      },
    }
  }
  return change
}

// ---------------------------------------------------------------------------
// Items — one thing a person recognises, assembled from real stores
// ---------------------------------------------------------------------------

interface ItemContext {
  source: Device
  sourceDocs: Docs
  targets: Device[]
  targetPlans: Map<string, TargetPlan>
}

function changesForAnchors(anchors: ItemAnchor[], changes: Change[]): Change[] {
  return changes.filter((c) =>
    anchors.some(
      (a) => a.storeId === c.storeId && (c.path === a.path || c.path.startsWith(`${a.path}.`)),
    ),
  )
}

const RISK_RANK: Record<Change['risk'], number> = {
  none: 0,
  elevated: 1,
  'code-execution': 2,
}

function buildItems(ctx: ItemContext): ConfigItem[] {
  const byStoreId = new Map(ctx.source.stores.map((s) => [s.id, s]))
  const installedTools = new Set(
    ctx.source.tools.filter((t) => t.detection.installed).map((t) => t.toolId),
  )
  const out: ConfigItem[] = []

  for (const seed of fx.itemSeeds) {
    const anchors: ItemAnchor[] = []
    for (const a of seed.anchors) {
      const store = byStoreId.get(a.storeId)
      const toolId = toolIdOf(a.storeId)
      if (!store || !toolId) continue
      // A store in the path table for a tool the source does not have is not a
      // thing this machine HAS. Every adapter declares its whole table on every
      // OS, so without this a Windows laptop with no Zed would still be
      // credited with Zed's font size and language servers.
      if (!installedTools.has(toolId)) continue
      anchors.push({ storeId: a.storeId, path: a.path, where: whereIs(store.location), toolId })
    }
    // Anchored to nothing that exists here. The item does not exist either —
    // better than drawing a row that points at a store no adapter declares.
    if (!anchors.length) continue

    const stores = anchors.map((a) => byStoreId.get(a.storeId)!) as StoreDescriptor[]
    const first = stores[0]!
    const concept = first.concept ?? 'other'
    const syncable = stores.some((s) => s.syncable)

    const differsOn: string[] = []
    const refusedOn: Record<string, Refusal> = {}
    const overriddenOn: Record<string, Scope> = {}
    const inertOn: Record<string, string> = {}
    let withheld: { reason: string } | undefined
    let risk: Change['risk'] = 'none'

    for (const target of ctx.targets) {
      const tp = ctx.targetPlans.get(target.id)
      if (!tp) continue

      const refusal = refuseItem(
        target,
        anchors.map((a) => a.storeId),
      )
      if (refusal) {
        // A refusal is only worth reporting when it is stopping something.
        // Every Claude Code path is unverified on Windows, which would
        // otherwise put "56 things cannot be written here" on a laptop where
        // 51 of them already match and were never going anywhere.
        if (syncable && differsHere(seed, anchors, tp, { anywhere: true })) {
          refusedOn[target.id] = refusal
        }
        continue
      }
      if (!syncable) continue

      const mine = changesForAnchors(anchors, tp.changes)
      for (const c of mine) {
        if (RISK_RANK[c.risk] > RISK_RANK[risk]) risk = c.risk
        if (c.blocked) withheld = c.blocked
        if (c.overriddenBy) overriddenOn[target.id] = c.overriddenBy
        if (c.inert) inertOn[target.id] = c.inert.reason
      }

      // Whether THIS item differs is asked of the documents, not of the plan.
      //
      // A plan change is per dot path, and several items can share one path:
      // six permission rules are six things a person recognises and exactly one
      // `permissions.allow` change, because the adapter merges that key as a
      // union-list. Reading "differs" off the change would light up all six the
      // moment any one of them was missing.
      if (differsHere(seed, anchors, tp)) differsOn.push(target.id)
    }

    // Risk on an item that differs nowhere still matters — it is what the
    // button's footnote is about — so fall back to the source's own value.
    if (risk === 'none') risk = riskOfSeedOnSource(seed, ctx)

    const filePeerIds = new Set<string>()
    for (const store of stores) {
      if (!store.fileId) continue
      for (const other of ctx.source.stores) {
        if (other.fileId === store.fileId && other.id !== store.id) filePeerIds.add(other.id)
      }
    }

    const item: ConfigItem = {
      id: seed.id,
      concept,
      label: seed.label,
      blurb: seed.blurb,
      anchors,
      toolNames: [...new Set(anchors.map((a) => displayNameOf(a.toolId)))],
      technicalKey: seed.technicalKey,
      scope: first.scope,
      risk,
      syncable,
      differsOn,
      refusedOn,
      overriddenOn,
      inertOn,
      filePeers: [...filePeerIds],
    }
    if (!syncable) item.staysPutBecause = staysPutReason(stores)
    if (withheld) item.withheld = withheld
    if (first.subtree) item.subtree = first.subtree
    out.push(item)
  }

  return out
}

/**
 * Does this one item differ on this one machine?
 *
 * Only stores that can actually receive it are consulted. An item filed by both
 * Claude Code and Cursor on a Windows laptop, where Claude Code's paths are
 * unverified, is answered by Cursor alone — because Cursor is the only half of
 * it that would move.
 */
function differsHere(
  seed: fx.ItemSeed,
  anchors: ItemAnchor[],
  tp: TargetPlan,
  opts?: { anywhere: boolean },
): boolean {
  // `anywhere` asks the same question of a store that cannot be written: would
  // this have been a change if it could? That is what decides whether a refusal
  // is worth telling someone about.
  const usable = opts?.anywhere ? anchors : anchors.filter((a) => tp.sendable.has(a.storeId))
  if (!usable.length) return false

  return usable.some((a) => {
    const doc = tp.docs[a.storeId]
    if (!doc) return true // the machine has nothing in this store at all
    const here = getPath(doc, a.path)
    if (seed.kind === 'member') return !Array.isArray(here) || !here.includes(seed.member)
    return !deepEqual(here, seed.value)
  })
}

/** What the engine would call this change's risk if it were being sent today. */
function riskOfSeedOnSource(seed: fx.ItemSeed, ctx: ItemContext): Change['risk'] {
  for (const anchor of seed.anchors) {
    const doc = ctx.sourceDocs[anchor.storeId]
    if (!doc) continue
    const toolId = toolIdOf(anchor.storeId)
    const adapter = adapterFor(toolId)
    if (!adapter) continue
    const probe = buildPlan({
      deviceId: '_probe',
      toolId: adapter.id,
      desiredByStore: { [anchor.storeId]: doc },
      observed: [{ storeId: anchor.storeId, data: {}, hash: '', exists: false }],
      rules: adapter.rules(),
      now: '',
    })
    let worst: Change['risk'] = 'none'
    for (const c of probe.changes) {
      if (c.path !== anchor.path && !c.path.startsWith(`${anchor.path}.`)) continue
      if (RISK_RANK[c.risk] > RISK_RANK[worst]) worst = c.risk
    }
    if (worst !== 'none') return worst
  }
  return 'none'
}

/**
 * Why an item stays put, said in one phrase.
 *
 * Derived from the descriptors, never asserted: a directory of installed
 * packages says so through `location.entryFile`, an org policy says so through
 * `writable: false`, and a store that mixes identity with config says so through
 * `provenanceNote`.
 */
function staysPutReason(stores: StoreDescriptor[]): string {
  const store = stores[0]
  if (!store) return 'Nothing to copy.'
  if (store.scope === 'managed') return 'Set by your organisation, not by you'
  if (store.location.kind === 'remote') return 'Delivered by the vendor, never on disk'
  if (store.location.kind === 'dir' && store.location.entryFile) {
    return 'Installed copies — the list travels instead'
  }
  if (store.scope === 'local') return 'Meant for this checkout only'
  if (store.provenanceNote) return store.provenanceNote
  return 'Different on each machine on purpose'
}

// ---------------------------------------------------------------------------
// Groups — by Change.concept, plus one terminal group for what never moves
// ---------------------------------------------------------------------------

/**
 * The sentence under a group heading.
 *
 * Each is derived rather than authored per group, so it cannot drift from the
 * behaviour it describes:
 *
 *   Skills                 `writeVerdict`'s own remedy for a marketplace folder
 *   Sub-agents & commands  the absence of `entryFile` on those same folders
 *   Permissions            the `MergeStrategy` the adapter declares for the key
 */
function groupNote(concept: string, items: ConfigItem[], source: Device): string | undefined {
  const storeOf = (id: string) => source.stores.find((s) => s.id === id)

  if (concept === 'skills') {
    const folder = source.stores.find(
      (s) => s.location.kind === 'dir' && s.location.entryFile && s.syncable === false,
    )
    if (folder) {
      const verdict = refuseStore(source, folder)
      if (verdict) return `${verdict.message} ${verdict.remedy}`.trim()
    }
    return undefined
  }

  if (concept === 'agent') {
    const authored = items
      .flatMap((i) => i.anchors.map((a) => storeOf(a.storeId)))
      .find((s) => s?.location.kind === 'dir' && !s.location.entryFile)
    if (authored) {
      return 'You wrote these, so the file itself travels — there is no marketplace to fetch them from.'
    }
    return undefined
  }

  if (concept === 'permissions') {
    const anchor = items.flatMap((i) => i.anchors).find((a) => a.path.startsWith('permissions.'))
    if (!anchor) return undefined
    const adapter = adapterFor(anchor.toolId)
    if (!adapter) return undefined
    const rule = ruleFor(adapter.rules(anchor.storeId), anchor.path)
    return MERGE_SENTENCE[rule.merge]
  }

  if (concept === 'rules') {
    // Some tools read a chain of instruction files and honour only the FIRST
    // one present — `StoreDescriptor.activeWhen` is how an adapter says so. If
    // any store in this group is named as something another store waits on,
    // adding it is a replacement rather than an addition, and that has to be
    // said before anyone presses the button.
    const ids = new Set(items.flatMap((i) => i.anchors.map((a) => a.storeId)))
    const chained = source.stores.some((s) =>
      s.activeWhen?.absent.some((id) => ids.has(id)),
    )
    if (chained) {
      return 'Some tools read only the first instruction file they find, so adding one here can switch another one off. You will be told which, before anything is written.'
    }
    return undefined
  }

  if (concept === STAYS_PUT) {
    return 'These differ on purpose, or would break somewhere else. Nothing here is ever sent.'
  }

  return undefined
}

function groupItems(items: ConfigItem[], source: Device): ItemGroup[] {
  const groups: ItemGroup[] = []

  for (const concept of CONCEPT_ORDER) {
    const mine = items.filter((i) => i.syncable && i.concept === concept)
    if (!mine.length) continue
    const group: ItemGroup = {
      key: concept,
      title: CONCEPT_TITLE[concept],
      items: mine,
      total: mine.length,
      differing: mine.filter((i) => i.differsOn.length > 0).length,
    }
    const note = groupNote(concept, mine, source)
    if (note) group.note = note
    groups.push(group)
  }

  const staysPut = items.filter((i) => !i.syncable)
  if (staysPut.length) {
    const group: ItemGroup = {
      key: STAYS_PUT,
      title: 'Stays put',
      items: staysPut,
      total: staysPut.length,
      differing: 0,
    }
    const note = groupNote(STAYS_PUT, staysPut, source)
    if (note) group.note = note
    groups.push(group)
  }

  return groups
}

// ---------------------------------------------------------------------------
// Machine rows
// ---------------------------------------------------------------------------

function machineRow(
  target: Device,
  items: ConfigItem[],
  tp: TargetPlan,
  groups: ItemGroup[],
): MachineRow {
  const differing = items.filter((i) => i.differsOn.includes(target.id))
  // Blocked is a fact about the machine, not about what happens to differ today:
  // a machine with nowhere to put ANY of the things being tracked is blocked
  // even when it currently matches. Asked of core, over every item, because
  // "the path table has one writable entry somewhere" is not the same question
  // as "anything you have could actually go there".
  const canTakeAnything = items.some(
    (i) =>
      i.syncable &&
      !refuseItem(
        target,
        i.anchors.map((a) => a.storeId),
      ),
  )

  let state: MachineState
  if (target.status === 'new') state = 'new'
  else if (!canTakeAnything) state = 'blocked'
  else if (differing.length) state = 'differs'
  else state = 'in-sync'

  // Grouped exactly the way the source panel groups, so the same thing is
  // called the same thing in both columns.
  const missing = groups
    .map((g) => ({
      title: g.title,
      labels: differing.filter((i) => g.items.some((x) => x.id === i.id)).map((i) => i.label),
    }))
    .filter((g) => g.labels.length > 0)

  const present = new Set(target.tools.flatMap((t) => t.detection.present))
  const shadowWarnings = detectShadowing(target.stores, tp.changes, (id) => present.has(id))

  // Collapsed one row per reason. Eleven items refused for the same unverified
  // path table is one fact about a laptop, not eleven problems.
  const byReason = new Map<string, { refusal: Refusal; labels: string[] }>()
  for (const item of items) {
    const r = item.refusedOn[target.id]
    if (!r || !item.syncable) continue
    const bucket = byReason.get(r.reason)
    if (bucket) bucket.labels.push(item.label)
    else byReason.set(r.reason, { refusal: r, labels: [item.label] })
  }
  const refused = [...byReason.values()].sort((a, b) => b.labels.length - a.labels.length)

  // Only a machine that can take nothing gets a refusal on its row. On every
  // other machine that fact belongs to the items it governs — putting "Zed is
  // not installed" on a laptop whose owner never wanted Zed makes a settled
  // machine look broken.
  const refusal = state === 'blocked' ? (refused[0]?.refusal ?? machineRefusals(target)[0]) : undefined

  const row: MachineRow = {
    device: target,
    state,
    differing: differing.map((i) => i.id),
    missing,
    refused,
    overridden: items
      .filter((i) => i.overriddenOn[target.id])
      .map((i) => ({ label: i.label, scope: i.overriddenOn[target.id]! })),
    inert: items
      .filter((i) => i.inertOn[target.id])
      .map((i) => ({ label: i.label, reason: i.inertOn[target.id]! })),
    withheld: items
      .filter((i) => i.withheld && i.differsOn.includes(target.id))
      .map((i) => ({ label: i.label, reason: i.withheld!.reason })),
    shadowWarnings,
    // Read off `HostEnv`, which is why they are honest: `hasKeyring` is false
    // on a headless container because there is no session bus, not because a
    // fixture said so.
    notes: hostNotes(target.host, target.secretBackend),
    weakDetection: target.tools
      .filter((t) => t.detection.confidence === 'weak')
      .map(
        (t) =>
          `${t.displayName} looks installed, but the only sign of it is a settings file we could have written ourselves.`,
      ),
  }
  if (refusal) row.refusal = refusal
  if (target.busy) row.deferred = target.busy
  return row
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function assemble(): Bench {
  const all = devices()
  const source = all.find((d) => d.id === sourceId) ?? all[0]!
  const targets = all.filter((d) => d.id !== source.id)

  const sourceDocs = documentsFor(source.id, new Set(source.stores.map((s) => s.id)))

  const targetPlans = new Map<string, TargetPlan>()
  for (const t of targets) targetPlans.set(t.id, planFor(source, t, sourceDocs))

  const items = buildItems({ source, sourceDocs, targets, targetPlans })
  const groups = groupItems(items, source)

  const machines = targets.map((t) => machineRow(t, items, targetPlans.get(t.id)!, groups))

  let writableStores = 0
  for (const store of source.stores) if (!refuseStore(source, store)) writableStores++

  return {
    source,
    devices: all,
    groups,
    items,
    machines,
    totals: {
      tracked: items.length,
      differing: items.filter((i) => i.differsOn.length > 0).length,
      stores: source.stores.length,
      writableStores,
    },
  }
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

function buildPreview(selection: SyncSelection): SyncPreview {
  const bench = assemble()
  const chosen = new Set(selection.itemIds)
  const items = bench.items.filter((i) => chosen.has(i.id))

  const targets: TargetPreview[] = []
  for (const deviceId of selection.targetDeviceIds) {
    const row = bench.machines.find((m) => m.device.id === deviceId)
    if (!row) continue
    const target = row.device
    const tp = planFor(bench.source, target, documentsFor(bench.source.id, new Set(bench.source.stores.map((s) => s.id))))

    const anchors = items.flatMap((i) => i.anchors)
    const mine = changesForAnchors(anchors, tp.changes)

    const merged: Plan = {
      id: `preview-${deviceId}-${contentHash([...chosen].sort())}`,
      deviceId,
      toolId: (tp.plans[0]?.toolId ?? 'claude-code') as ToolId,
      changes: mine,
      baseHashes: Object.assign({}, ...tp.plans.map((p) => p.baseHashes)),
      warnings: tp.plans.flatMap((p) => p.warnings),
    }

    const automatic: Change[] = []
    const withheldList: Change[] = []
    const noEffect: Change[] = []
    const approvals = new Map<string, ApprovalGroup>()

    mine.forEach((c, index) => {
      if (c.blocked) withheldList.push(c)
      else if (c.overriddenBy || c.inert) noEffect.push(c)
      else if (c.risk === 'code-execution') {
        const owner = items.find((i) =>
          i.anchors.some(
            (a) => a.storeId === c.storeId && (c.path === a.path || c.path.startsWith(`${a.path}.`)),
          ),
        )
        const label = owner?.label ?? c.path
        const store = target.stores.find((s) => s.id === c.storeId)
        const group = approvals.get(label) ?? { label, indexes: [], commands: [], wheres: [] }
        group.indexes.push(index)
        const command = commandOf(c)
        if (command && !group.commands.includes(command)) group.commands.push(command)
        const where = store ? whereIs(store.location) : c.storeId
        if (!group.wheres.includes(where)) group.wheres.push(where)
        approvals.set(label, group)
      } else automatic.push(c)
    })
    const needsApproval = [...approvals.values()]

    const refused = items
      .filter((i) => i.refusedOn[deviceId])
      .map((i) => ({ label: i.label, refusal: i.refusedOn[deviceId]! }))

    const preview: TargetPreview = {
      deviceId,
      deviceName: target.name,
      plan: merged,
      automatic,
      needsApproval,
      withheld: withheldList,
      noEffect,
      refused,
      shadowWarnings: row.shadowWarnings,
    }
    if (target.busy) preview.deferred = target.busy
    targets.push(preview)
  }

  return {
    previewId: `pv-${Date.now().toString(36)}`,
    sourceDeviceId: selection.sourceDeviceId,
    targets,
  }
}

/** The literal command a code-execution change would run, for the approval line. */
function commandOf(change: Change): string | undefined {
  if (typeof change.after === 'string' && /command|args/.test(change.path)) return change.after
  if (Array.isArray(change.after)) return change.after.join(' ')
  return undefined
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function createMockClient(): ControlPlaneClient {
  return {
    async getBench() {
      return delay(assemble(), LATENCY.normal)
    },

    async setSourceDevice(deviceId) {
      if (!seeds.some((d) => d.id === deviceId)) {
        throw new ApiError('No such machine.', 'not-found')
      }
      sourceId = deviceId
      return delay(assemble(), LATENCY.normal)
    },

    async previewSync(selection) {
      if (!selection.itemIds.length) throw new ApiError('Nothing selected.', 'empty-selection')
      if (!selection.targetDeviceIds.length) throw new ApiError('No machine picked.', 'no-target')
      const preview = buildPreview(selection)
      previews.set(preview.previewId, preview)
      return delay(preview, LATENCY.normal)
    },

    async applySync(previewId, approvedIndexes) {
      const preview = previews.get(previewId)
      if (!preview) throw new ApiError('That preview has expired. Take another look.', 'stale')

      const devicesOut: SyncResult['devices'] = []
      for (const target of preview.targets) {
        // Every index a group covers has to be present. The device performs the
        // same check against the signed plan, so a UI that got this wrong would
        // be caught there rather than writing something unapproved.
        const approved = new Set(approvedIndexes[target.deviceId] ?? [])
        const missing = target.needsApproval.filter((g) => !g.indexes.every((i) => approved.has(i)))
        if (missing.length) {
          throw new ApiError(
            `${missing.length} ${missing.length === 1 ? 'thing' : 'things'} on ${target.deviceName} ${missing.length === 1 ? 'runs' : 'run'} a program and ${missing.length === 1 ? 'has' : 'have'} not been confirmed.`,
            'needs-approval',
            { deviceId: target.deviceId },
          )
        }

        // `ApplyResult.deferred`: the machine chose to wait. Not a failure and
        // not a no-op, and flattening it into either loses the one fact that
        // matters — it will happen later.
        if (target.deferred) {
          devicesOut.push({
            deviceId: target.deviceId,
            deviceName: target.deviceName,
            outcome: 'waiting',
            appliedCount: 0,
            deferred: target.deferred,
            note: target.deferred.reason,
          })
          continue
        }

        const applied =
          target.automatic.length +
          target.needsApproval.reduce((n, g) => n + g.indexes.length, 0)
        const snapshotId = `snap-${Math.random().toString(36).slice(2, 6)}`
        snapshots = [
          {
            snapshotId,
            deviceId: target.deviceId,
            label: 'Before this send',
            createdAt: new Date().toISOString(),
            storeHashes: target.plan.baseHashes,
            secretRefs: target.withheld.map((c) => c.path),
            automatic: true,
            sizeBytes: 12_000 + applied * 190,
          },
          ...snapshots,
        ]

        // Two different outcomes that both look like success and are not:
        // something that landed and does nothing, and something that was never
        // carried at all. Flattening them into one number is how a report ends
        // up technically true and actually misleading.
        const parts: string[] = []
        if (target.noEffect.length) {
          parts.push(
            `${target.noEffect.length} landed and will not take effect — a policy already sets it, or the tool will not read it there yet`,
          )
        }
        if (target.withheld.length) {
          parts.push(
            `${target.withheld.length} looked like a password and was left on the source machine`,
          )
        }

        devicesOut.push({
          deviceId: target.deviceId,
          deviceName: target.deviceName,
          outcome: applied === 0 ? 'held' : parts.length ? 'partial' : 'applied',
          appliedCount: applied,
          snapshotId,
          ...(parts.length ? { note: `${parts.join('. ')}.` } : {}),
        })
      }

      return delay({ previewId, devices: devicesOut }, LATENCY.normal)
    },

    async renameDevice(deviceId, name) {
      const seed = seeds.find((d) => d.id === deviceId)
      if (!seed) throw new ApiError('No such machine.', 'not-found')
      if (!name.trim()) throw new ApiError('A machine needs a name.', 'invalid')
      seed.name = name.trim()
      await delay(null, LATENCY.fast)
    },

    async removeDevice(deviceId) {
      if (deviceId === sourceId) {
        throw new ApiError(
          'This is the machine everything comes from. Choose a different source first.',
          'is-source',
        )
      }
      const i = seeds.findIndex((d) => d.id === deviceId)
      if (i < 0) throw new ApiError('No such machine.', 'not-found')
      seeds.splice(i, 1)
      await delay(null, LATENCY.fast)
    },

    async startPairing() {
      pairing = {
        pairingId: `pair-${Date.now().toString(36)}`,
        shortCode: 'K7M2-Q4XB',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }
      return delay(pairing, LATENCY.fast)
    },

    async cancelPairing() {
      pairing = undefined
      await delay(null, LATENCY.fast)
    },

    async listSnapshots() {
      return delay(structuredClone(snapshots), LATENCY.fast)
    },

    async createSnapshot(deviceId) {
      const seed = seeds.find((d) => d.id === deviceId)
      if (!seed) throw new ApiError('No such machine.', 'not-found')
      snapshots = [
        {
          snapshotId: `snap-${Math.random().toString(36).slice(2, 6)}`,
          deviceId,
          label: 'Manual',
          createdAt: new Date().toISOString(),
          storeHashes: {},
          secretRefs: [],
          automatic: false,
          sizeBytes: 14_000,
        },
        ...snapshots,
      ]
      return delay(structuredClone(snapshots), LATENCY.normal)
    },

    async restoreSnapshot(snapshotId) {
      const snap = snapshots.find((s) => s.snapshotId === snapshotId)
      if (!snap) throw new ApiError('That backup is gone.', 'not-found')
      return delay(
        {
          restored: Object.keys(snap.storeHashes).length,
          // Sealed secrets cannot be reopened on a machine that is not enrolled
          // in the vault, and saying so beats writing config that half works.
          unresolvedSecrets: settings.secrets.enabled ? [] : snap.secretRefs,
        },
        LATENCY.normal,
      )
    },

    async getSettings() {
      return delay(structuredClone(settings), LATENCY.fast)
    },

    async setSecretsSync(enabled) {
      settings = { ...settings, secrets: { ...settings.secrets, enabled } }
      return delay(structuredClone(settings), LATENCY.fast)
    },

    async setAutoSync({ enabled, autoApplyCodeExecution }) {
      settings = {
        ...settings,
        autoSync: {
          ...settings.autoSync,
          enabled,
          // Hooks, MCP commands and env are code execution. Unattended
          // propagation of those means compromising the source yields code
          // execution everywhere, so it is opt-in and stated in those words.
          autoApplyRisk: autoApplyCodeExecution ? ['none', 'elevated', 'code-execution'] : ['none'],
        },
      }
      return delay(structuredClone(settings), LATENCY.fast)
    },

    async requestEnumerationChange(mode) {
      if (mode === 'full' || mode === 'declared-plus-user') {
        throw new ApiError(
          'Widening what gets looked at has to be confirmed on the machine itself. A request has been sent there.',
          'confirm-on-device',
        )
      }
      settings = { ...settings, enumeration: { ...settings.enumeration, mode } }
      return delay(structuredClone(settings), LATENCY.fast)
    },
  }
}

/** Re-exported so a screen can check equality without importing @core directly. */
export { deepEqual }
