/**
 * Constructing and normalizing desired state.
 *
 * `DesiredState` is a tagged union so `plan()` can never be handed an ambiguous
 * document. These helpers are the only sanctioned way to produce one.
 */

import type { DesiredState } from './types.js'

/** One flat document, diffed against the tool's primary store. */
export const asDocument = (data: Record<string, unknown>): DesiredState => ({
  kind: 'document',
  data,
})

/** Per-store documents, each diffed against its own observed doc. */
export const byStore = (stores: Record<string, Record<string, unknown>>): DesiredState => ({
  kind: 'by-store',
  stores,
})

export const EMPTY_DESIRED: DesiredState = { kind: 'document', data: {} }

/**
 * Coerce untyped input — desired state read back from disk or a wire payload —
 * into the union.
 *
 * The sniffing lives HERE, in one auditable place, instead of being repeated
 * inside every adapter's `plan()`. `{ stores: { … } }` is treated as per-store;
 * anything else is a flat document. A `stores` key holding a non-object is
 * ambiguous enough to be worth rejecting rather than guessing.
 */
export function normalizeDesired(input: unknown): DesiredState {
  if (input === null || input === undefined) return EMPTY_DESIRED
  if (typeof input !== 'object' || Array.isArray(input)) return EMPTY_DESIRED

  const obj = input as Record<string, unknown>

  // Already tagged — pass through.
  if (obj['kind'] === 'document' || obj['kind'] === 'by-store') return input as DesiredState

  if ('stores' in obj) {
    const stores = obj['stores']
    if (typeof stores !== 'object' || stores === null || Array.isArray(stores))
      throw new TypeError(
        'desired state has a "stores" key that is not an object; it is neither a flat document nor a per-store map',
      )
    return byStore(stores as Record<string, Record<string, unknown>>)
  }

  return asDocument(obj)
}

/** The flat document, or `{}` when the state is per-store. */
export function documentOf(d: DesiredState): Record<string, unknown> {
  return d.kind === 'document' ? d.data : {}
}

/** The per-store map, or `{}` when the state is a single document. */
export function storesOf(d: DesiredState): Record<string, Record<string, unknown>> {
  return d.kind === 'by-store' ? d.stores : {}
}
