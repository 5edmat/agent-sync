/**
 * `agentsync devices` — list and rename the devices this CLI knows about.
 *
 * There is no server yet, so "known devices" means "devices recorded in this
 * machine's local state", which today is exactly one: this machine. That is
 * stated in the output rather than implied, because a devices list that looks
 * fleet-wide but is not would be actively misleading — a user could conclude
 * their laptop never enrolled when in truth nothing enrols yet.
 *
 * The identity/label split from `control-plane.ts` is enforced here: `deviceId`
 * is generated once and never edited; `label` is free text the user owns.
 */

import type { CommandSpec } from '../args.js'
import type { Ctx } from '../context.js'
import { EXIT, UsageError } from '../exit.js'
import { table } from '../render.js'
import {
  emptyState,
  findDevice,
  normalizeLabel,
  readState,
  renameDevice,
  writeState,
  type CliState,
} from '../state.js'
import { detectHostOrExplain, nowIso, stateDirFor } from './common.js'

export const devicesSpec: CommandSpec = {
  name: 'devices',
  summary: 'List or rename the devices recorded in local state.',
  usage: 'agentsync devices [list] | agentsync devices rename <id|.> <label>',
  description:
    'Local records only — no server exists yet, so this lists what this machine has seen. ' +
    'Use `.` to mean this device.',
  flags: {},
  positionals: [
    { name: 'subcommand', required: false, description: '`list` (default) or `rename`.' },
  ],
  examples: [
    'agentsync devices',
    'agentsync devices rename . "work laptop"',
    'agentsync devices --json',
  ],
}

export async function devicesCommand(ctx: Ctx): Promise<number> {
  const host = await detectHostOrExplain(ctx)
  const stateDir = stateDirFor(ctx, host)
  const now = nowIso(ctx)

  const read = await readState(ctx.deps.fs, stateDir)
  if (read.problem) ctx.err(ctx.style.yellow(`${ctx.sym.warn} ${read.problem}`))
  const state: CliState = read.value ?? emptyState(now)

  const sub = ctx.args.positionals[0] ?? 'list'

  switch (sub) {
    case 'list':
      return listDevices(ctx, state, host.deviceId, read.value !== null)
    case 'rename':
      return renameCommand(ctx, state, stateDir, host.deviceId, now)
    default:
      throw new UsageError(`Unknown subcommand "${sub}" for \`agentsync devices\`.`, {
        hint: 'Try `agentsync devices list` or `agentsync devices rename . "<label>"`.',
      })
  }
}

function listDevices(ctx: Ctx, state: CliState, localId: string, initialised: boolean): number {
  const s = ctx.style

  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'devices',
      exitCode: state.devices.length === 0 ? EXIT.NOTHING_TO_DO : EXIT.OK,
      initialised,
      localDeviceId: localId,
      serverBacked: false,
      devices: state.devices.map((d) => ({ ...d, isLocal: d.deviceId === localId })),
    })
    return state.devices.length === 0 ? EXIT.NOTHING_TO_DO : EXIT.OK
  }

  if (state.devices.length === 0) {
    ctx.out(`${s.gray(ctx.sym.info)} No devices recorded yet.`)
    ctx.note(`  ${s.cyan('agentsync init')} ${s.gray('records this one.')}`)
    return EXIT.NOTHING_TO_DO
  }

  ctx.out()
  const rows = state.devices.map((d) => [
    d.deviceId === localId ? s.green(ctx.sym.arrow) : ' ',
    d.label,
    s.gray(d.deviceId),
    `${d.os}/${d.runtime}`,
    d.arch,
    s.gray(d.lastSeenAt.slice(0, 19).replace('T', ' ')),
  ])
  for (const line of table(
    ctx,
    [
      { header: '' },
      { header: 'LABEL' },
      { header: 'DEVICE ID' },
      { header: 'OS' },
      { header: 'ARCH' },
      { header: 'LAST SEEN' },
    ],
    rows,
  )) {
    ctx.out(line)
  }
  ctx.out()
  ctx.note(
    `  ${s.gray('These are local records. There is no control plane yet, so other machines you own will not appear here until they pair.')}`,
  )
  ctx.note(`  ${s.cyan('agentsync devices rename . "<label>"')} ${s.gray('to rename this device')}`)
  ctx.note()
  return EXIT.OK
}

async function renameCommand(
  ctx: Ctx,
  state: CliState,
  stateDir: string,
  localId: string,
  now: string,
): Promise<number> {
  const needle = ctx.args.positionals[1]
  const rawLabel = ctx.args.positionals.slice(2).join(' ')

  if (needle === undefined || rawLabel === '') {
    throw new UsageError('`agentsync devices rename` needs a device and a new label.', {
      hint: 'Try `agentsync devices rename . "work laptop"`. `.` means this device.',
    })
  }

  const target = findDevice(state, needle, localId)
  if (!target) {
    throw new UsageError(`No device matches "${needle}".`, {
      hint: 'Run `agentsync devices` to see the ids. `.` means this device.',
      details: state.devices.map((d) => `${d.deviceId}  ${d.label}`),
    })
  }

  const label = normalizeLabel(rawLabel)
  if (label === '') {
    throw new UsageError('That label is empty after removing control characters.', {
      hint: 'Pick a label with at least one visible character.',
    })
  }

  const previous = target.label
  const next = renameDevice(state, target.deviceId, label, now)
  await writeState(ctx.deps.fs, stateDir, next)

  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'devices',
      exitCode: EXIT.OK,
      action: 'rename',
      deviceId: target.deviceId,
      previousLabel: previous,
      label,
    })
    return EXIT.OK
  }

  ctx.out(
    `${ctx.style.green(ctx.sym.ok)} Renamed ${ctx.style.gray(target.deviceId)} from "${previous}" to ${ctx.style.bold(label)}.`,
  )
  return EXIT.OK
}
