/**
 * `agentsync init` — the first thing anyone runs, and usually via `npx`.
 *
 * It must answer three questions in one screen: what machine am I, what did you
 * find, and what do I do next. It writes only its own state directory; it never
 * touches a tool's config. `--adopt` is the one exception and even that only
 * *reads* config, writing the result into our own desired-state file.
 */

import type { HostEnv, ToolAdapter } from '../../core/types.js'
import type { CommandSpec } from '../args.js'
import { boolFlag, stringFlag } from '../args.js'
import type { Ctx } from '../context.js'
import { EXIT } from '../exit.js'
import { probeTool, pickPrimaryStore, probeStore, type ToolProbe } from '../planner.js'
import {
  defaultLabel,
  normalizeLabel,
  partitionIntoLayers,
  readState,
  emptyState,
  upsertDevice,
  writeDesired,
  writeState,
  type CliState,
} from '../state.js'
import { shortPath } from '../render.js'
import { adapterById, detectHostOrExplain, nowIso, stateDirFor } from './common.js'

export const initSpec: CommandSpec = {
  name: 'init',
  summary: 'Detect this host, find installed tools, and create local state.',
  usage: 'agentsync init [--adopt] [--label <name>] [--tool <id>]',
  description:
    'Writes nothing outside agentsync\'s own state directory. `--adopt` additionally reads your ' +
    'current config and files it into portable / os-scoped / machine-scoped layers, so `diff` has ' +
    'something to compare against.',
  flags: {
    adopt: {
      type: 'boolean',
      description: "Capture this device's current config as the starting desired state.",
    },
    label: { type: 'string', placeholder: '<name>', description: 'Name for this device. Defaults to the hostname.' },
    tool: { type: 'string', placeholder: '<id>', description: 'Only look at (and adopt from) this tool.' },
  },
  examples: ['agentsync init', 'agentsync init --adopt', 'agentsync init --label "work laptop"'],
  exitNotes: ['3 — nothing to do (state already existed and no new device was recorded)'],
}

interface AdoptionReport {
  toolId: string
  storeId: string
  layers: Array<{ id: string; keys: number }>
  dropped: Array<{ path: string; reason: string }>
}

export async function initCommand(ctx: Ctx): Promise<number> {
  const host = await detectHostOrExplain(ctx)
  const stateDir = stateDirFor(ctx, host)
  const now = nowIso(ctx)

  const only = stringFlag(ctx.args, 'tool')
  const adapters = only ? [adapterById(ctx, only)] : ctx.deps.adapters

  const prior = await readState(ctx.deps.fs, stateDir)
  if (prior.problem) ctx.err(ctx.style.yellow(`${ctx.sym.warn} ${prior.problem}`))
  // "First run" means we have no state file — not merely that the directory is
  // absent. `detectHost` creates the directory to persist the device id, so a
  // directory check would report every first run as a repeat.
  const existed = prior.value !== null

  let state: CliState = prior.value ?? emptyState(now)
  const isNewDevice = !state.devices.some((d) => d.deviceId === host.deviceId)

  const label = normalizeLabel(stringFlag(ctx.args, 'label') ?? '') || defaultLabel(ctx.deps.hostname, host)

  state = upsertDevice(state, {
    deviceId: host.deviceId,
    label,
    os: host.os,
    runtime: host.runtime,
    arch: host.arch,
    shell: host.shell,
    firstSeenAt: now,
    lastSeenAt: now,
  })

  // ---- detection --------------------------------------------------------
  const probes: ToolProbe[] = []
  for (const adapter of adapters) {
    probes.push(await probeTool(adapter, host, ctx.deps.fs, ctx.cwd))
  }

  for (const probe of probes) {
    state.tools[probe.adapter.id] = {
      installed: probe.detection.installed,
      ...(probe.detection.version !== undefined ? { version: probe.detection.version } : {}),
      presentStores: probe.detection.present,
      lastDetectedAt: now,
    }
  }

  // ---- adoption ---------------------------------------------------------
  const adopted: AdoptionReport[] = []
  if (boolFlag(ctx.args, 'adopt')) {
    for (const probe of probes) {
      if (!probe.detection.installed) continue
      const report = await adoptTool(ctx, host, stateDir, probe.adapter, now)
      if (report) adopted.push(report)
    }
  }

  await writeState(ctx.deps.fs, stateDir, { ...state, updatedAt: now })

  // ---- output -----------------------------------------------------------
  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'init',
      exitCode: EXIT.OK,
      version: ctx.deps.version,
      stateDir,
      stateDirCreated: !existed,
      device: { deviceId: host.deviceId, label, isNew: isNewDevice },
      host: hostJson(host),
      tools: probes.map((p) => toolJson(p, ctx.cwd)),
      adopted,
    })
    return EXIT.OK
  }

  renderInit(ctx, host, stateDir, !existed, label, isNewDevice, probes, adopted)
  return EXIT.OK
}

// ---------------------------------------------------------------------------

async function adoptTool(
  ctx: Ctx,
  host: HostEnv,
  stateDir: string,
  adapter: ToolAdapter,
  now: string,
): Promise<AdoptionReport | undefined> {
  const primary = pickPrimaryStore(adapter.locations(host))
  if (!primary) return undefined

  const probe = await probeStore(adapter, host, primary, ctx.deps.fs, ctx.cwd, { read: true })
  if (probe.error !== undefined) {
    ctx.err(ctx.style.yellow(`${ctx.sym.warn} could not adopt ${primary.id}: ${probe.error}`))
    return undefined
  }
  if (!probe.doc || !probe.doc.exists) return undefined

  const { layers, dropped } = partitionIntoLayers(probe.doc.data, adapter.rules(primary.id), host)
  if (layers.length === 0 && dropped.length === 0) return undefined

  await writeDesired(ctx.deps.fs, stateDir, {
    v: 1,
    toolId: adapter.id,
    updatedAt: now,
    layers,
  })

  return {
    toolId: adapter.id,
    storeId: primary.id,
    layers: layers.map((l) => ({
      id: l.id,
      keys: l.data && typeof l.data === 'object' ? Object.keys(l.data as object).length : 1,
    })),
    dropped,
  }
}

function hostJson(host: HostEnv): Record<string, unknown> {
  return {
    os: host.os,
    runtime: host.runtime,
    arch: host.arch,
    home: host.home,
    shell: host.shell,
    supportsSymlinks: host.supportsSymlinks,
    supportsLongPaths: host.supportsLongPaths,
    hasKeyring: host.hasKeyring,
    deviceId: host.deviceId,
  }
}

function toolJson(probe: ToolProbe, cwd: string): Record<string, unknown> {
  void cwd
  return {
    toolId: probe.adapter.id,
    displayName: probe.adapter.displayName,
    installed: probe.detection.installed,
    version: probe.detection.version ?? null,
    storesPresent: probe.stores.filter((s) => s.exists).length,
    storesTotal: probe.stores.length,
    writeBlockedStores: probe.stores.filter((s) => s.store.writable && s.store.provenance === 'inferred').length,
    error: probe.error ?? null,
  }
}

function renderInit(
  ctx: Ctx,
  host: HostEnv,
  stateDir: string,
  created: boolean,
  label: string,
  isNewDevice: boolean,
  probes: ToolProbe[],
  adopted: AdoptionReport[],
): void {
  const s = ctx.style
  ctx.out()
  ctx.out(`${s.bold('agentsync')} ${s.gray(ctx.deps.version)} ${s.gray('·')} ${created ? 'first run' : 'already initialised'}`)
  ctx.out()

  ctx.out(s.bold('This device'))
  ctx.out(kvLine(ctx, 'host', `${host.os} / ${host.runtime} / ${host.arch}`))
  ctx.out(kvLine(ctx, 'shell', host.shell))
  ctx.out(kvLine(ctx, 'home', host.home))
  ctx.out(
    kvLine(
      ctx,
      'device id',
      `${host.deviceId} ${s.gray(isNewDevice ? '(new — recorded now)' : '(known)')}`,
    ),
  )
  ctx.out(kvLine(ctx, 'label', `${label} ${s.gray('— change with `agentsync devices rename . "<name>"`')}`))
  ctx.out(kvLine(ctx, 'state', `${shortPath(stateDir, host.home)}${created ? s.gray('  (created)') : ''}`))
  ctx.out()

  ctx.out(s.bold('Tools'))
  const nameWidth = Math.max(...probes.map((p) => p.adapter.displayName.length))
  for (const probe of probes) {
    const present = probe.stores.filter((p) => p.exists).length
    const name = probe.adapter.displayName.padEnd(nameWidth)
    if (probe.error) {
      ctx.out(`  ${s.red(ctx.sym.fail)} ${name}  ${s.red(probe.error)}`)
      continue
    }
    if (!probe.detection.installed) {
      ctx.out(`  ${s.gray(ctx.sym.bullet)} ${s.gray(`${name}  not detected`)}`)
      continue
    }
    const version = probe.detection.version ? s.gray(` v${probe.detection.version}`) : ''
    ctx.out(
      `  ${s.green(ctx.sym.ok)} ${name}${version}  ${s.gray(
        `${present} of ${probe.stores.length} config stores present`,
      )}`,
    )
    const blocked = probe.stores.filter((p) => p.store.writable && p.store.provenance === 'inferred')
    if (blocked.length > 0) {
      ctx.out(
        `      ${s.yellow(`${ctx.sym.warn} ${blocked.length} store${blocked.length === 1 ? '' : 's'} write-blocked (unverified path on ${host.os})`)}`,
      )
    }
  }
  ctx.out()

  if (adopted.length > 0) {
    ctx.out(s.bold('Adopted into desired state'))
    for (const a of adopted) {
      ctx.out(`  ${s.green(ctx.sym.ok)} ${a.toolId} ${s.gray(`from ${a.storeId}`)}`)
      for (const l of a.layers) {
        ctx.out(`      ${s.cyan(l.id)} ${s.gray(`${l.keys} top-level key${l.keys === 1 ? '' : 's'}`)}`)
      }
      if (a.dropped.length > 0) {
        ctx.out(`      ${s.gray(`${a.dropped.length} key(s) deliberately not adopted:`)}`)
        for (const d of a.dropped.slice(0, 6)) ctx.out(`        ${s.gray(`${d.path} — ${d.reason}`)}`)
        if (a.dropped.length > 6) ctx.out(`        ${s.gray(`… and ${a.dropped.length - 6} more`)}`)
      }
    }
    ctx.out()
  }

  ctx.note(s.bold('Next'))
  ctx.note(`  ${s.cyan('agentsync status')}   ${s.gray('what is installed, and what has drifted')}`)
  ctx.note(`  ${s.cyan('agentsync doctor')}   ${s.gray('full diagnostics — run this first if anything looks wrong')}`)
  if (adopted.length === 0) {
    ctx.note(
      `  ${s.cyan('agentsync init --adopt')}   ${s.gray("capture this device's config as your base layer")}`,
    )
  } else {
    ctx.note(`  ${s.cyan('agentsync diff')}     ${s.gray('review what would change')}`)
  }
  ctx.note()
}

function kvLine(ctx: Ctx, label: string, value: string): string {
  return `  ${ctx.style.gray(label.padEnd(11))} ${value}`
}
