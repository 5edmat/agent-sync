/**
 * The store inventory, taken from the real adapters.
 *
 * There is no hand-written path table in this app. `adapter.locations(host, ctx)`
 * IS the table — 73 stores across Claude Code, Cursor and Zed on macOS, of which
 * `writeVerdict` clears 46 for writing — and it is read here at runtime from
 * `src/adapters/*.ts` rather than copied into a fixture.
 *
 * That matters more than it sounds. A previous iteration of this screen invented
 * its own inventory and drew four items where the truth was closer to ninety, so
 * the picture a person formed of their own machine was wrong in the one direction
 * that cannot be recovered from: it looked simpler than it is. Anything the
 * adapters can answer — which stores exist on which OS, what concept each one
 * carries, whether its path is verified, whether it can be synced — is answered
 * by the adapters.
 *
 * What is NOT real, and is marked as fixture wherever it appears: the CONTENTS
 * of a store. Which individual skills are installed, which permission rules are
 * written, which sub-agent files exist. Reading those needs a filesystem, and
 * this tier never touches one.
 *
 * `locations()` is declared pure and does no IO, so calling it in a browser is
 * legitimate. The Node builtins its module imports for `read()`/`apply()` are
 * aliased to throwing stubs — see `src/shims/node.ts`.
 */

import { claudeCodeAdapter } from '@adapters/claude-code'
import { cursorAdapter } from '@adapters/cursor'
import { zedAdapter } from '@adapters/zed'
import type {
  HostEnv,
  KeyRule,
  ProjectContext,
  StoreDescriptor,
  ToolAdapter,
  ToolId,
} from '@core/types'

export const ADAPTERS: readonly ToolAdapter[] = [claudeCodeAdapter, cursorAdapter, zedAdapter]

export function adapterFor(toolId: ToolId | undefined): ToolAdapter | undefined {
  return ADAPTERS.find((a) => a.id === toolId)
}

/** Fixture store ids are `<toolId>:<scope>:<name>`, which is the adapters' own shape. */
export function toolIdOf(storeId: string): ToolId | undefined {
  const head = storeId.split(':')[0]
  return ADAPTERS.some((a) => a.id === head) ? (head as ToolId) : undefined
}

/**
 * Every store every adapter declares for this host, in adapter order.
 *
 * A project context is supplied because project-scope descriptors are
 * repo-relative and meaningless without one — omitting it would silently make
 * `.cursor/rules` and `.zed/settings.json` resolve against nothing.
 */
export function storesFor(host: HostEnv, ctx?: ProjectContext): StoreDescriptor[] {
  return ADAPTERS.flatMap((a) => a.locations(host, ctx))
}

export function ruleSetFor(toolId: ToolId | undefined, storeId?: string): KeyRule[] {
  return adapterFor(toolId)?.rules(storeId) ?? []
}

export function displayNameOf(toolId: ToolId | undefined): string {
  return adapterFor(toolId)?.displayName ?? 'This tool'
}
