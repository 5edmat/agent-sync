/**
 * "Can this land here?" — asked of core, never answered here.
 *
 * `writeVerdict()` in `@core/write-verdict` is the single implementation of the
 * refusal precedence, and `validatePlan` calls the same function, so the engine
 * and this app necessarily agree — including about which reason wins when
 * several apply at once.
 *
 * The temptation this file exists to resist is re-deriving that from
 * `capabilities.apply`, `detection.installed`, `store.writable` and
 * `store.provenance`, which is what the previous UI did. Duplicated safety
 * logic drifts, and the copy that drifts is the one that stops refusing
 * something.
 *
 * So: nothing below decides anything. It calls core, and it supplies a short
 * headline per reason so a chip can be labelled without printing a paragraph.
 * `message` and `remedy` are core's own words, passed through untouched.
 */

import type { StoreDescriptor, ToolId } from '@core/types'
import { isActionable, writeVerdict, type WriteRefusal } from '@core/write-verdict'
import { displayNameOf, toolIdOf } from '../api/inventory'
import type { Device, ToolPresence } from '../api/types'

export type { WriteRefusal }

/** A refusal, ready to render. The decision and the reason are always core's. */
export interface Refusal {
  reason: WriteRefusal
  /** Four or five words, for a chip or a row. Ours. */
  headline: string
  /**
   * The sentence shown to a person — core's own, verbatim.
   *
   * An earlier version of this file rewrote the folder case, because core used
   * to say `Writing a "dir" store is not supported`, and no sentence in this
   * product may name a type. Core's wording has since been fixed at the source
   * ("These are installed from a marketplace, not written by you."), so the
   * rewrite is gone. Paraphrasing an engine that already says it well is how
   * the CLI and the web app end up telling one person two different things.
   */
  message: string
  /** Core's remedy. Empty string when there is genuinely nothing to do. */
  remedy: string
  /** `isActionable(reason)` — whether it is worth nudging the person at all. */
  actionable: boolean
  /** Which store produced it, so a detail view can name the file. */
  storeId: string
  toolName: string
}

/**
 * Short labels. Deliberately phrased as a state of the world rather than as an
 * error: "Cursor isn't here" is a fact about a laptop, not a fault.
 */
const HEADLINE: Record<WriteRefusal, string> = {
  'adapter-cannot-apply': 'Read-only for now',
  'store-not-supported': 'This part is read-only',
  'tool-not-installed': 'Not installed here',
  'not-writable': 'Set somewhere above you',
  'not-a-file': 'Not kept in a file',
  'path-unverified': 'Location unconfirmed',
}

/**
 * Display order when several stores refuse for different reasons.
 *
 * NOT the same as core's internal precedence, and deliberately so: core orders
 * by which fact is most fundamental, because it is deciding. This orders by
 * which fact is most useful to a person, because it is only labelling — the two
 * actionable reasons come first, since those are the ones where saying it
 * changes what someone does next.
 */
const DISPLAY_ORDER: WriteRefusal[] = [
  'tool-not-installed',
  'path-unverified',
  'adapter-cannot-apply',
  'store-not-supported',
  'not-writable',
  'not-a-file',
]

/** Store ids are `<toolId>:<scope>:<name>`. The only structure we rely on. */
export function ownerToolId(store: StoreDescriptor): ToolId | undefined {
  return toolIdOf(store.id)
}

export function toolOn(device: Device, toolId: ToolId | undefined): ToolPresence | undefined {
  return toolId ? device.tools.find((t) => t.toolId === toolId) : undefined
}

/**
 * One store, one machine. A `Refusal` means core said no; `undefined` means it
 * said yes.
 *
 * A store whose adapter is not present on the machine at all is reported as
 * `tool-not-installed`, which is what core would say if it had been handed a
 * `Detection` with `installed: false`.
 */
export function refuseStore(device: Device, store: StoreDescriptor): Refusal | undefined {
  const toolId = ownerToolId(store)
  const tool = toolOn(device, toolId)

  const displayName = tool?.displayName ?? toolLabel(toolId)
  const capabilities = tool?.capabilities ?? { apply: true }
  const detection = tool?.detection ?? { installed: false, present: [], confidence: 'none' as const }

  const verdict = writeVerdict(store, {
    host: device.host,
    capabilities,
    detection,
    displayName,
  })

  if (verdict.canWrite || !verdict.reason) return undefined

  // The one distinction the shared headline cannot make: `not-a-file` covers
  // both "installed by a marketplace" and "lives in the registry", and those
  // are opposite kinds of fact.
  const marketplace = store.location.kind === 'dir' && Boolean(store.location.entryFile)

  return {
    reason: verdict.reason,
    // The DECISION, the REASON, the MESSAGE and the REMEDY are all core's.
    // Only the four-word headline is ours, because core does not have one.
    headline: marketplace ? 'Installed, not written' : HEADLINE[verdict.reason],
    message: verdict.message ?? '',
    remedy: verdict.remedy ?? '',
    actionable: isActionable(verdict.reason),
    storeId: store.id,
    toolName: displayName,
  }
}

/**
 * Can anything at all be written for this set of stores on this machine?
 *
 * One writable store is enough — an item that Claude Code can take and Zed
 * cannot is not blocked, it is partially served, and calling it blocked would
 * make a working machine look broken.
 */
export function refuseItem(device: Device, storeIds: string[]): Refusal | undefined {
  const stores = storeIds
    .map((id) => device.stores.find((s) => s.id === id))
    .filter((s): s is StoreDescriptor => Boolean(s))

  /**
   * The machine does not have these stores at all, which happens when the
   * owning adapter never ran there.
   *
   * This must NOT read as "allowed". A machine with no Zed stores and no Zed in
   * its tool list has no Zed — reporting silence as permission is how a bench
   * would offer to write a file to a machine that has nowhere to put it.
   */
  if (stores.length === 0) {
    const toolId = toolIdOf(storeIds[0] ?? '')
    const tool = toolOn(device, toolId)
    if (tool?.detection.installed) return undefined
    const name = tool?.displayName ?? toolLabel(toolId)
    const message = `${name} is not installed on this device.`
    return {
      reason: 'tool-not-installed',
      headline: HEADLINE['tool-not-installed'],
      message,
      remedy: `Install ${name} on ${device.name} and this clears.`,
      actionable: true,
      storeId: storeIds[0] ?? '',
      toolName: name,
    }
  }

  const refusals: Refusal[] = []
  for (const store of stores) {
    const r = refuseStore(device, store)
    if (!r) return undefined // something here can take it
    refusals.push(r)
  }

  return pickForDisplay(refusals)
}

/** Which of several refusals to put in front of a person. */
export function pickForDisplay(refusals: Refusal[]): Refusal | undefined {
  for (const reason of DISPLAY_ORDER) {
    const hit = refusals.find((r) => r.reason === reason)
    if (hit) return hit
  }
  return refusals[0]
}

/**
 * Facts about the MACHINE that stop writes — as opposed to facts about one
 * item. Deliberately not the union of every item's refusal: "Zed is not
 * installed" is true of a laptop whose owner never wanted Zed, and putting that
 * on the machine itself makes a settled machine look broken.
 *
 * So this reports only what is surprising: a tool that IS installed and still
 * cannot be written, and a policy location we only guessed at.
 */
export function machineRefusals(device: Device): Refusal[] {
  const seen = new Map<WriteRefusal, Refusal>()

  for (const store of device.stores) {
    const tool = toolOn(device, ownerToolId(store))
    if (!tool?.detection.installed) continue
    const r = refuseStore(device, store)
    if (!r) continue
    // Org policy is not a machine fault and appears on the items it governs.
    if (r.reason === 'not-writable' || r.reason === 'not-a-file') continue
    if (!seen.has(r.reason)) seen.set(r.reason, r)
  }

  // Nothing installed at all IS a fact about the machine.
  if (device.tools.length > 0 && device.tools.every((t) => !t.detection.installed)) {
    const first = device.tools[0]
    if (first) {
      const message = `Nothing we can configure is installed on ${device.name} yet.`
      seen.set('tool-not-installed', {
        reason: 'tool-not-installed',
        headline: HEADLINE['tool-not-installed'],
        message,
        remedy: `Install ${first.displayName} there and everything below becomes available.`,
        actionable: true,
        storeId: '',
        toolName: first.displayName,
      })
    }
  }

  return DISPLAY_ORDER.map((k) => seen.get(k)).filter((r): r is Refusal => Boolean(r))
}

/** The adapter's own `displayName`, so the UI cannot invent a second one. */
function toolLabel(id: ToolId | undefined): string {
  return displayNameOf(id)
}
