/**
 * `agentsync status` — the "what is going on with this machine" screen.
 *
 * Three questions, in the order a user asks them:
 *   1. What did you find installed, and where does its config live?
 *   2. What can you actually write, and what is blocked?
 *   3. Has anything drifted from what I said I wanted?
 *
 * Provenance gets its own section rather than a column footnote, because
 * `inferred` is the difference between "agentsync works here" and "agentsync
 * is read-only here", and a user who does not understand that will file the
 * refusal as a bug.
 */

import type { HostEnv, Plan, ToolAdapter } from '../../core/types.js'
import type { CommandSpec } from '../args.js'
import { boolFlag, stringFlag } from '../args.js'
import type { Ctx } from '../context.js'
import { EXIT } from '../exit.js'
import { computePlan, countRisks, preflight, probeTool, type StoreProbe, type ToolProbe } from '../planner.js'
import { readDesired, readState } from '../state.js'
import { planSummaryLine, provenanceLabel, shortPath, table } from '../render.js'
import { adapterById, detectHostOrExplain, nowIso, stateDirFor } from './common.js'

export const statusSpec: CommandSpec = {
  name: 'status',
  summary: 'What is installed, which stores exist, and what has drifted.',
  usage: 'agentsync status [--tool <id>] [--all]',
  flags: {
    tool: { type: 'string', placeholder: '<id>', description: 'Restrict to one tool.' },
    all: { type: 'boolean', description: 'List every store, not just the ones that exist.' },
  },
  examples: ['agentsync status', 'agentsync status --tool claude-code --all', 'agentsync status --json'],
  exitNotes: [
    '3 — nothing configured yet (no desired state for any tool)',
    '4 — every write target on this OS is blocked by unverified provenance',
  ],
}

interface ToolStatus {
  probe: ToolProbe
  plan: Plan | undefined
  planError: string | undefined
  blockedCount: number
  hasDesired: boolean
}

export async function statusCommand(ctx: Ctx): Promise<number> {
  const host = await detectHostOrExplain(ctx)
  const stateDir = stateDirFor(ctx, host)
  const showAll = boolFlag(ctx.args, 'all')

  const only = stringFlag(ctx.args, 'tool')
  const adapters = only ? [adapterById(ctx, only)] : ctx.deps.adapters

  const state = await readState(ctx.deps.fs, stateDir)
  if (state.problem) ctx.err(ctx.style.yellow(`${ctx.sym.warn} ${state.problem}`))

  const statuses: ToolStatus[] = []
  for (const adapter of adapters) {
    statuses.push(await statusForTool(ctx, host, stateDir, adapter))
  }

  const anyDesired = statuses.some((s) => s.hasDesired)
  const anyDrift = statuses.some((s) => (s.plan?.changes.length ?? 0) > 0)

  // Every writable store on this host being 'inferred' is the platform-blocked
  // case: agentsync can read and report here, but cannot write anything.
  const writeTargets = statuses.flatMap((s) => s.probe.stores.filter((p) => p.store.writable && p.store.syncable))
  const allInferred = writeTargets.length > 0 && writeTargets.every((p) => p.store.provenance === 'inferred')

  if (ctx.json) {
    const code = !anyDesired ? EXIT.NOTHING_TO_DO : allInferred ? EXIT.BLOCKED_BY_PROVENANCE : EXIT.OK
    ctx.emit({
      ok: true,
      command: 'status',
      exitCode: code,
      version: ctx.deps.version,
      stateDir,
      initialised: state.value !== null,
      host: {
        os: host.os,
        runtime: host.runtime,
        arch: host.arch,
        shell: host.shell,
        deviceId: host.deviceId,
        supportsSymlinks: host.supportsSymlinks,
        supportsLongPaths: host.supportsLongPaths,
        hasKeyring: host.hasKeyring,
      },
      device: state.value?.devices.find((d) => d.deviceId === host.deviceId) ?? null,
      tools: statuses.map((s) => ({
        toolId: s.probe.adapter.id,
        displayName: s.probe.adapter.displayName,
        installed: s.probe.detection.installed,
        version: s.probe.detection.version ?? null,
        detectError: s.probe.error ?? null,
        hasDesiredState: s.hasDesired,
        drift: s.plan
          ? { planId: s.plan.id, changes: s.plan.changes.length, risks: countRisks(s.plan.changes), blocked: s.blockedCount }
          : null,
        planError: s.planError ?? null,
        stores: s.probe.stores.map(storeJson),
      })),
    })
    return code
  }

  renderStatus(ctx, host, stateDir, statuses, showAll)

  if (!anyDesired) return EXIT.NOTHING_TO_DO
  if (allInferred && anyDrift) return EXIT.BLOCKED_BY_PROVENANCE
  return EXIT.OK
}

// ---------------------------------------------------------------------------

async function statusForTool(
  ctx: Ctx,
  host: HostEnv,
  stateDir: string,
  adapter: ToolAdapter,
): Promise<ToolStatus> {
  const probe = await probeTool(adapter, host, ctx.deps.fs, ctx.cwd)
  const desired = await readDesired(ctx.deps.fs, stateDir, adapter.id)
  if (desired.problem) ctx.err(ctx.style.yellow(`${ctx.sym.warn} ${desired.problem}`))

  const hasDesired = Boolean(desired.value && desired.value.layers.length > 0)
  if (!hasDesired || !probe.detection.installed) {
    return { probe, plan: undefined, planError: undefined, blockedCount: 0, hasDesired }
  }

  try {
    const bundle = await computePlan({
      adapter,
      host,
      layers: desired.value?.layers ?? [],
      fs: ctx.deps.fs,
      cwd: ctx.cwd,
      now: nowIso(ctx),
    })
    const pf = preflight(adapter, host, bundle.plan)
    return { probe, plan: bundle.plan, planError: undefined, blockedCount: pf.blocked.length, hasDesired }
  } catch (err) {
    return { probe, plan: undefined, planError: (err as Error).message, blockedCount: 0, hasDesired }
  }
}

function storeJson(p: StoreProbe): Record<string, unknown> {
  return {
    id: p.store.id,
    scope: p.store.scope,
    kind: p.store.location.kind,
    location: p.location,
    exists: p.exists,
    readable: p.store.readable,
    writable: p.store.writable,
    syncable: p.store.syncable,
    provenance: p.store.provenance,
    provenanceNote: p.store.provenanceNote ?? null,
    writeBlocked: p.store.writable && p.store.provenance === 'inferred',
    error: p.error ?? null,
    notProbed: p.notProbed ?? null,
  }
}

function renderStatus(
  ctx: Ctx,
  host: HostEnv,
  stateDir: string,
  statuses: ToolStatus[],
  showAll: boolean,
): void {
  const s = ctx.style
  ctx.out()
  ctx.out(
    `${s.bold('agentsync status')}  ${s.gray(
      `${host.os}/${host.runtime} ${host.arch} ${ctx.sym.bullet} device ${host.deviceId.slice(0, 8)} ${ctx.sym.bullet} state ${shortPath(stateDir, host.home)}`,
    )}`,
  )
  ctx.out()

  // ---- tools -------------------------------------------------------------
  const rows: string[][] = statuses.map((st) => {
    const present = st.probe.stores.filter((p) => p.exists).length
    const blocked = st.probe.stores.filter((p) => p.store.writable && p.store.provenance === 'inferred').length
    const drift = st.planError
      ? s.red('plan failed')
      : st.plan
        ? st.plan.changes.length === 0
          ? s.green('in sync')
          : s.yellow(`${st.plan.changes.length} pending`)
        : s.gray(st.hasDesired ? '—' : 'not configured')
    return [
      st.probe.detection.installed ? `${s.green(ctx.sym.ok)} ${st.probe.adapter.displayName}` : `${s.gray(ctx.sym.bullet)} ${s.gray(st.probe.adapter.displayName)}`,
      st.probe.detection.installed ? `${present}/${st.probe.stores.length}` : s.gray('—'),
      blocked > 0 ? s.yellow(String(blocked)) : s.gray('0'),
      drift,
    ]
  })
  for (const line of table(
    ctx,
    [{ header: 'TOOL' }, { header: 'STORES' }, { header: 'BLOCKED' }, { header: 'DRIFT' }],
    rows,
  )) {
    ctx.out(line)
  }
  ctx.out()

  // ---- stores ------------------------------------------------------------
  for (const st of statuses) {
    if (!st.probe.detection.installed && !showAll) continue
    const shown = st.probe.stores.filter((p) => showAll || p.exists)
    if (shown.length === 0) continue

    ctx.out(s.bold(st.probe.adapter.displayName))
    const storeRows = shown.map((p) => [
      p.exists ? s.green(ctx.sym.ok) : s.gray(ctx.sym.bullet),
      p.store.id,
      p.store.scope,
      provenanceLabel(ctx, p.store),
      p.store.writable ? (p.store.provenance === 'inferred' ? s.yellow('read-only here') : s.green('writable')) : s.gray('read-only'),
      s.gray(shortPath(p.location, host.home)),
    ])
    for (const line of table(
      ctx,
      [
        { header: '' },
        { header: 'STORE' },
        { header: 'SCOPE' },
        { header: 'PROVENANCE' },
        { header: 'WRITE' },
        { header: 'LOCATION' },
      ],
      storeRows,
    )) {
      ctx.out(line)
    }
    for (const p of shown) {
      if (p.error) ctx.out(`    ${s.red(`${ctx.sym.fail} ${p.store.id}: ${p.error}`)}`)
    }
    ctx.out()
  }

  // ---- provenance --------------------------------------------------------
  const blockedStores = statuses.flatMap((st) =>
    st.probe.stores.filter((p) => p.store.writable && p.store.provenance === 'inferred'),
  )
  if (blockedStores.length > 0) {
    ctx.out(s.bold(`${s.yellow(ctx.sym.warn)} Write-blocked on this OS (provenance: inferred)`))
    ctx.out(
      s.gray(
        '  These paths were reasoned from convention, not confirmed against a real install, so',
      ),
    )
    ctx.out(s.gray('  `apply` refuses to write them. Reads and diffs still work.'))
    for (const p of blockedStores) {
      ctx.out(`    ${p.store.id}  ${s.gray(shortPath(p.location, host.home))}`)
      if (p.store.provenanceNote) ctx.out(`      ${s.gray(p.store.provenanceNote)}`)
    }
    ctx.out()
  }

  // ---- drift -------------------------------------------------------------
  const configured = statuses.filter((st) => st.hasDesired)
  if (configured.length === 0) {
    ctx.out(`${s.gray(ctx.sym.info)} No desired state configured yet.`)
    ctx.note(`  ${s.cyan('agentsync init --adopt')} ${s.gray("captures this device's config as your base layer")}`)
    ctx.note()
    return
  }

  ctx.out(s.bold('Drift'))
  for (const st of configured) {
    if (st.planError) {
      ctx.out(`  ${s.red(ctx.sym.fail)} ${st.probe.adapter.id}: ${st.planError}`)
      continue
    }
    if (!st.plan) {
      ctx.out(`  ${s.gray(ctx.sym.bullet)} ${st.probe.adapter.id}: ${s.gray('not installed on this device')}`)
      continue
    }
    ctx.out(`  ${st.probe.adapter.id}  ${planSummaryLine(ctx, st.plan)}`)
    if (st.blockedCount > 0) {
      ctx.out(`    ${s.yellow(`${ctx.sym.warn} ${st.blockedCount} of them would be refused — see \`agentsync diff\``)}`)
    }
  }
  ctx.note()
  if (statuses.some((st) => (st.plan?.changes.length ?? 0) > 0)) {
    ctx.note(`  ${s.cyan('agentsync diff')} ${s.gray('to review, then')} ${s.cyan('agentsync apply')}`)
    ctx.note()
  }
}
