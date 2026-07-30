/**
 * Local, on-device state owned by the CLI.
 *
 * There is no server yet, so this file is the whole control plane: which
 * devices this user has told us about, what we last detected, and the desired
 * layers that `diff` and `apply` reconcile against.
 *
 * Everything here is versioned (`v: 1`) and read defensively. A state file
 * written by a newer CLI, hand-edited into invalid JSON, or truncated by a
 * crash must degrade to "treat as absent, tell the user" — never to a stack
 * trace, and never to silently discarding the user's desired state.
 */

import { join } from 'node:path'

import type { HostEnv, KeyRule, ToolId } from '../core/types.js'
import type { LayerId } from '../core/control-plane.js'
import { ROOT_PATH, flatten, ruleFor, setPath } from '../core/reconcile.js'
import type { CliFs } from './deps.js'

export const STATE_FILE = 'cli-state.json'
export const DESIRED_DIR = 'desired'
export const STATE_VERSION = 1

export interface DeviceRecord {
  deviceId: string
  /** User-editable. Never the identity — see `readOrCreateDeviceId`. */
  label: string
  os: HostEnv['os']
  runtime: HostEnv['runtime']
  arch: HostEnv['arch']
  shell: HostEnv['shell']
  firstSeenAt: string
  lastSeenAt: string
}

export interface ToolRecord {
  installed: boolean
  version?: string
  presentStores: string[]
  lastDetectedAt: string
}

export interface CliState {
  v: typeof STATE_VERSION
  createdAt: string
  updatedAt: string
  devices: DeviceRecord[]
  tools: Record<string, ToolRecord>
}

export interface DesiredFile {
  v: typeof STATE_VERSION
  toolId: ToolId
  updatedAt: string
  /** Lowest precedence first, matching `resolve()`. */
  layers: Array<{ id: LayerId; data: unknown }>
}

export function statePath(stateDir: string): string {
  return join(stateDir, STATE_FILE)
}

export function desiredPath(stateDir: string, toolId: string): string {
  return join(stateDir, DESIRED_DIR, `${toolId}.json`)
}

export function emptyState(now: string): CliState {
  return { v: STATE_VERSION, createdAt: now, updatedAt: now, devices: [], tools: {} }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadResult<T> {
  value: T | null
  /** Set when a file existed but could not be used. Surfaced, never swallowed. */
  problem?: string
}

export async function readState(fs: CliFs, stateDir: string): Promise<ReadResult<CliState>> {
  const raw = await fs.readFile(statePath(stateDir))
  if (raw === null) return { value: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { value: null, problem: `${statePath(stateDir)} is not valid JSON: ${(err as Error).message}` }
  }
  if (!isRecord(parsed)) return { value: null, problem: `${statePath(stateDir)} is not an object` }

  const v = parsed['v']
  if (v !== STATE_VERSION) {
    return {
      value: null,
      problem:
        `${statePath(stateDir)} has version ${String(v)}, this CLI understands ${STATE_VERSION}. ` +
        'Upgrade agentsync, or move that file aside and re-run `agentsync init`.',
    }
  }

  const devices = Array.isArray(parsed['devices']) ? parsed['devices'].filter(isDeviceRecord) : []
  const tools = isRecord(parsed['tools']) ? (parsed['tools'] as Record<string, ToolRecord>) : {}

  return {
    value: {
      v: STATE_VERSION,
      createdAt: str(parsed['createdAt']) ?? '',
      updatedAt: str(parsed['updatedAt']) ?? '',
      devices,
      tools,
    },
  }
}

export async function writeState(fs: CliFs, stateDir: string, state: CliState): Promise<void> {
  await fs.mkdirp(stateDir)
  // 0600: device labels and store paths are not secrets, but on a shared box
  // they are nobody else's business either.
  await fs.writeFile(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`, 0o600)
}

export async function readDesired(
  fs: CliFs,
  stateDir: string,
  toolId: string,
): Promise<ReadResult<DesiredFile>> {
  const path = desiredPath(stateDir, toolId)
  const raw = await fs.readFile(path)
  if (raw === null) return { value: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { value: null, problem: `${path} is not valid JSON: ${(err as Error).message}` }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['layers'])) {
    return { value: null, problem: `${path} has no "layers" array` }
  }
  if (parsed['v'] !== STATE_VERSION) {
    return { value: null, problem: `${path} has version ${String(parsed['v'])}, expected ${STATE_VERSION}` }
  }

  const layers = parsed['layers'].filter(isLayer)
  return {
    value: {
      v: STATE_VERSION,
      toolId: toolId as ToolId,
      updatedAt: str(parsed['updatedAt']) ?? '',
      layers,
    },
  }
}

export async function writeDesired(fs: CliFs, stateDir: string, file: DesiredFile): Promise<void> {
  await fs.mkdirp(join(stateDir, DESIRED_DIR))
  await fs.writeFile(
    desiredPath(stateDir, file.toolId),
    `${JSON.stringify(file, null, 2)}\n`,
    0o600,
  )
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** Sanitised so a label can never break table rendering or shell quoting. */
export function normalizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 64)
}

export function defaultLabel(hostname: string, host: HostEnv): string {
  const base = normalizeLabel(hostname.replace(/\.local$/i, ''))
  if (base) return base
  return `${host.os}-${host.deviceId.slice(0, 8)}`
}

export function upsertDevice(state: CliState, record: DeviceRecord): CliState {
  const devices = [...state.devices]
  const at = devices.findIndex((d) => d.deviceId === record.deviceId)
  if (at === -1) devices.push(record)
  else {
    const prior = devices[at] as DeviceRecord
    // The label is user-owned: re-running `init` must never clobber a rename.
    devices[at] = { ...record, label: prior.label, firstSeenAt: prior.firstSeenAt }
  }
  return { ...state, devices, updatedAt: record.lastSeenAt }
}

export function renameDevice(state: CliState, deviceId: string, label: string, now: string): CliState {
  return {
    ...state,
    updatedAt: now,
    devices: state.devices.map((d) => (d.deviceId === deviceId ? { ...d, label } : d)),
  }
}

/** Accepts a full id, a unique id prefix, or an exact label. */
export function findDevice(state: CliState, needle: string, localDeviceId?: string): DeviceRecord | undefined {
  if (needle === '.' || needle === 'this') {
    return state.devices.find((d) => d.deviceId === localDeviceId)
  }
  const exact = state.devices.find((d) => d.deviceId === needle)
  if (exact) return exact
  const byLabel = state.devices.filter((d) => d.label === needle)
  if (byLabel.length === 1) return byLabel[0]
  const byPrefix = state.devices.filter((d) => d.deviceId.startsWith(needle))
  return byPrefix.length === 1 ? byPrefix[0] : undefined
}

// ---------------------------------------------------------------------------
// Adoption: observed config -> layered desired state
// ---------------------------------------------------------------------------

export interface Partitioned {
  layers: Array<{ id: LayerId; data: unknown }>
  /** Keys deliberately not adopted, with the reason. Shown to the user. */
  dropped: Array<{ path: string; reason: string }>
}

/**
 * Split an observed document into the layers it is *allowed* to live in.
 *
 * This is the first-run move that makes the product legible: "we took your
 * current config, put the portable parts in `base`, your shell hooks in
 * `os:macos`, your absolute paths in `machine:<id>`, and left your credentials
 * exactly where they were." Doing it by `KeyRule.portability` rather than by
 * eyeball means the result passes `validateLayer` by construction.
 *
 * Pure: no clock, no IO. That is what makes it unit-testable.
 */
export function partitionIntoLayers(
  data: unknown,
  rules: KeyRule[],
  host: HostEnv,
): Partitioned {
  const buckets = new Map<LayerId, Record<string, unknown>>()
  const roots = new Map<LayerId, unknown>()
  const dropped: Array<{ path: string; reason: string }> = []

  for (const [path, value] of flatten(data)) {
    let rule: KeyRule
    try {
      rule = ruleFor(rules, path)
    } catch (err) {
      dropped.push({ path, reason: (err as Error).message })
      continue
    }

    if (rule.merge === 'never' || rule.portability === 'never-sync') {
      dropped.push({
        path,
        reason: rule.secret
          ? 'secret-bearing — left on this device only'
          : 'device identity or session state — never synced',
      })
      continue
    }

    let layer: LayerId
    switch (rule.portability) {
      case 'os-scoped':
        layer = `os:${host.os}`
        break
      case 'machine-scoped':
        layer = `machine:${host.deviceId}`
        break
      case 'portable':
      default:
        layer = 'base'
        break
    }

    if (path === ROOT_PATH) {
      roots.set(layer, value)
      continue
    }
    let bucket = buckets.get(layer)
    if (!bucket) {
      bucket = {}
      buckets.set(layer, bucket)
    }
    setPath(bucket, path, value)
  }

  // Ordered lowest precedence first — the order `resolve()` expects.
  const order: LayerId[] = ['base', `os:${host.os}`, `machine:${host.deviceId}`]
  const layers: Array<{ id: LayerId; data: unknown }> = []
  for (const id of order) {
    if (roots.has(id)) {
      layers.push({ id, data: roots.get(id) })
      continue
    }
    const bucket = buckets.get(id)
    if (bucket && Object.keys(bucket).length > 0) layers.push({ id, data: bucket })
  }

  return { layers, dropped }
}

// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function isDeviceRecord(v: unknown): v is DeviceRecord {
  return isRecord(v) && typeof v['deviceId'] === 'string' && typeof v['label'] === 'string'
}

function isLayer(v: unknown): v is { id: LayerId; data: unknown } {
  return isRecord(v) && typeof v['id'] === 'string'
}
