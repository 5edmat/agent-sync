/**
 * First-match-wins instruction chains, and the writes that silently break them.
 *
 * Some tools read a list of instruction files and honour only the FIRST one
 * present. Zed's chain is nine deep: `.rules`, `.cursorrules`, `.windsurfrules`,
 * `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`,
 * `CLAUDE.md`, `GEMINI.md`.
 *
 * So creating `.rules` in a repo that has a `CLAUDE.md` does not ADD
 * instructions — it REPLACES them, and the CLAUDE.md stops being read at all.
 * The write looks purely additive and is quietly destructive, which is the worst
 * shape a change can have: nothing errors, nothing is deleted, and the agent
 * just starts behaving differently.
 *
 * `StoreDescriptor.activeWhen` encodes the chain. This turns it into something
 * a user sees BEFORE they apply.
 */

import type { Change, StoreDescriptor } from './types.js'

export interface ShadowWarning {
  /** The store being created. */
  writing: string
  /** Stores that exist today and will stop being read once it does. */
  deactivates: string[]
  /** Written for a user, not a maintainer. */
  message: string
}

/**
 * Which existing stores a plan would silently deactivate.
 *
 * `exists` reports current on-disk presence — a store the plan is not touching
 * can still be the casualty, so this cannot be answered from the changes alone.
 */
export function detectShadowing(
  stores: StoreDescriptor[],
  changes: Change[],
  exists: (storeId: string) => boolean,
): ShadowWarning[] {
  const byId = new Map(stores.map((s) => [s.id, s]))
  const out: ShadowWarning[] = []

  // Only CREATING a store shadows anything. Editing one that already exists
  // changes no liveness — it was already winning, or already losing.
  const created = new Set(
    changes.map((c) => c.storeId).filter((id) => byId.has(id) && !exists(id)),
  )

  for (const newlyCreated of created) {
    const victims = stores
      .filter((s) => s.activeWhen?.absent.includes(newlyCreated))
      .filter((s) => exists(s.id))
      .map((s) => s.id)

    if (!victims.length) continue

    out.push({
      writing: newlyCreated,
      deactivates: victims,
      message:
        `Creating "${label(byId.get(newlyCreated))}" will stop ` +
        `${victims.map((v) => `"${label(byId.get(v))}"`).join(' and ')} from being read. ` +
        `This tool honours only the first instruction file it finds, so this replaces them rather than adding to them.`,
    })
  }

  return out
}

/** Prefer the file path — a user recognises `.rules`, not `zed:project:instructions:rules`. */
function label(store: StoreDescriptor | undefined): string {
  if (!store) return 'unknown'
  const loc = store.location
  return loc.kind === 'file' || loc.kind === 'dir' ? loc.path : store.id
}
