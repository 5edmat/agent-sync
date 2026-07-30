/**
 * One answer to "can this be written?".
 *
 * There are five reasons a write gets refused, and before this they lived on
 * four different types — `AdapterCapabilities.apply`, `Detection.installed`,
 * `StoreDescriptor.provenance`/`writable`, and (only after planning)
 * `Change.blocked`. Two of them did not exist until a plan had been computed.
 *
 * So a UI could not answer the question ahead of a plan without reimplementing
 * the precedence order, and the CLI had already reimplemented it once as
 * `preflight()`. That is the same shape as the `validatePlan` problem: safety
 * logic in two places drifts, and the copy that drifts is the one that stops
 * refusing something.
 *
 * This is the single implementation. `validatePlan` calls it, so the engine and
 * every UI necessarily agree — including about which reason wins when several
 * apply at once.
 */

import type {
  AdapterCapabilities,
  Detection,
  HostEnv,
  StoreDescriptor,
} from './types.js'

export type WriteRefusal =
  /** The adapter reads and diffs this tool but cannot write it yet. */
  | 'adapter-cannot-apply'
  /** The adapter can write this tool, but not THIS store. */
  | 'store-not-supported'
  /** The tool is not on this machine, so its config should not be created. */
  | 'tool-not-installed'
  /** Org policy owns this store, or it is read-only for another reason. */
  | 'not-writable'
  /** Registry, plist or vendor API — needs a channel we do not own. */
  | 'not-a-file'
  /** The path was reasoned from convention and never confirmed on this OS. */
  | 'path-unverified'

export interface WriteVerdict {
  canWrite: boolean
  reason?: WriteRefusal
  /** One sentence, written for a user. */
  message?: string
  /** What would change the answer. Empty string when nothing the user can do. */
  remedy?: string
}

const OK: WriteVerdict = { canWrite: true }

export interface WriteVerdictContext {
  host: HostEnv
  capabilities: AdapterCapabilities
  /** Omit when detection has not been run; that check is then skipped. */
  detection?: Detection
  /** Shown in messages. Falls back to the tool id. */
  displayName?: string
}

/**
 * Decide whether a store can be written, WITHOUT a plan and without touching
 * the disk.
 *
 * Precedence is deliberate and ordered most-fundamental first: a tool the
 * adapter cannot write at all makes every other question moot, and telling
 * someone "this path is unverified" when the real problem is that they do not
 * have the software installed sends them to fix the wrong thing.
 */
export function writeVerdict(store: StoreDescriptor, ctx: WriteVerdictContext): WriteVerdict {
  const tool = ctx.displayName ?? 'This tool'

  if (!ctx.capabilities.apply) {
    return {
      canWrite: false,
      reason: 'adapter-cannot-apply',
      message: `${tool} can be read and compared, but this build cannot write its config yet.`,
      remedy: ctx.capabilities.reason ?? '',
    }
  }

  // A store may narrow the adapter-wide answer but never widen it — checked
  // after the adapter gate precisely so it cannot re-enable what the adapter
  // has already ruled out.
  if (store.capabilities && !store.capabilities.apply) {
    return {
      canWrite: false,
      reason: 'store-not-supported',
      message: `${tool} can read this, but writing it is not supported.`,
      remedy: store.capabilities.reason ?? '',
    }
  }

  if (ctx.detection && !ctx.detection.installed) {
    return {
      canWrite: false,
      reason: 'tool-not-installed',
      message: `${tool} is not installed on this device.`,
      remedy:
        'Its paths come from vendor documentation and have never been confirmed against a real ' +
        'install, so writing would create files for software that is not here. Install it and this clears.',
    }
  }

  if (!store.writable) {
    return {
      canWrite: false,
      reason: 'not-writable',
      message:
        store.scope === 'managed'
          ? 'Your organization policy sets this, and it overrides anything written here.'
          : 'This store is read-only.',
      // Nothing the user can do about org policy, and nothing useful to add
      // about a plainly read-only store. An empty remedy is honest.
      remedy: '',
    }
  }

  // A directory of AUTHORED entries is writable — sub-agents and slash commands
  // are files the user wrote, with no source to re-resolve from, so carrying
  // the bytes is the only way they can travel at all. A directory of INSTALLED
  // packages is not: those come from a marketplace and are re-resolved per
  // device from a lockfile, so writing the tree would fight the installer.
  if (store.location.kind === 'dir') {
    if (store.location.entryFile) {
      return {
        canWrite: false,
        reason: 'not-a-file',
        message: 'These are installed from a marketplace, not written by you.',
        remedy:
          'They travel as a list of what to install, so each machine fetches its own copy. ' +
          'Copying the folder would fight the installer.',
      }
    }
  } else if (store.location.kind !== 'file') {
    return {
      canWrite: false,
      reason: 'not-a-file',
      message: `This is kept in ${describeLocation(store.location.kind)}, not in a file.`,
      remedy: 'Changing it needs a channel this tool does not have.',
    }
  }

  if (store.provenance === 'inferred') {
    const os = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }[ctx.host.os] ?? ctx.host.os
    const where = `${os}${ctx.host.runtime === 'wsl' ? '/WSL' : ''}`
    return {
      canWrite: false,
      reason: 'path-unverified',
      message: `Where this lives on ${where} is unverified — reasoned from convention, never confirmed on a real install.`,
      remedy:
        store.provenanceNote ??
        'Writing to a path we only inferred could overwrite an unrelated file. Confirming it on a real install clears this.',
    }
  }

  return OK
}

function describeLocation(kind: string): string {
  switch (kind) {
    case 'registry':
      return 'the Windows registry'
    case 'plist':
      return 'macOS managed preferences'
    case 'remote':
      return "the vendor's servers"
    case 'dir':
      return 'a directory'
    case 'dropin':
      return 'a drop-in policy directory'
    default:
      return kind
  }
}

/**
 * The subset of refusals a user can act on. `doctor` and the web app use this
 * to decide whether to nudge — telling someone to fix an org policy they cannot
 * change is noise, not help.
 */
export function isActionable(reason: WriteRefusal): boolean {
  return reason === 'tool-not-installed' || reason === 'path-unverified'
}
