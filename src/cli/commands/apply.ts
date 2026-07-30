/**
 * `agentsync apply` — the only command in this CLI that causes a write.
 *
 * The gate that matters: any change classified `code-execution` requires an
 * explicit human confirmation unless `--yes` was passed. Hooks, MCP `command`
 * and `env` are arbitrary code on a developer machine, and a config tool that
 * applies them silently is a remote-execution service wearing a config tool's
 * clothes. `--yes` exists because CI needs it, and because forcing users to
 * defeat the gate with `yes |` would be worse.
 *
 * Everything else here is about telling the truth after the fact: what was
 * applied, what was refused and why, what failed, and — prominently, because
 * this is the number someone types while panicking — the rollback id.
 */

import type { ApplyResult, Change, Plan, ToolAdapter } from '../../core/types.js'
import type { ApplyDeps } from '../../core/apply-engine.js'
import { StalePlanError } from '../../core/apply-engine.js'
import { extractSecretRefs } from '../../core/vault.js'
import type { CommandSpec } from '../args.js'
import { boolFlag } from '../args.js'
import type { Ctx } from '../context.js'
import { CliError, EXIT } from '../exit.js'
import { computePlan, countRisks, preflight, type Preflight } from '../planner.js'
import { readDesired } from '../state.js'
import { box, planSummaryLine, renderPlan } from '../render.js'
import { detectHostOrExplain, nowIso, resolveTargetTool, stateDirFor } from './common.js'

export const applySpec: CommandSpec = {
  name: 'apply',
  summary: 'Apply the plan. Atomic, reversible, and gated on code-execution risk.',
  usage: 'agentsync apply [--tool <id>] [--yes] [--dry-run]',
  description:
    'Recomputes the plan against the current disk state, refuses anything the path table only ' +
    'inferred, and rolls back every file if any write fails. Changes that can execute code require ' +
    'an explicit confirmation unless --yes is given.',
  flags: {
    tool: { type: 'string', placeholder: '<id>', description: 'Which tool to apply.' },
    yes: { type: 'boolean', alias: 'y', description: 'Approve code-execution changes without prompting.' },
    'dry-run': { type: 'boolean', alias: 'n', description: 'Show exactly what would happen; write nothing.' },
  },
  examples: ['agentsync apply --dry-run', 'agentsync apply --tool claude-code', 'agentsync apply --yes --json'],
  exitNotes: [
    '3 — nothing to do; already in the desired state',
    '4 — every change was refused because its path is unverified on this OS',
  ],
}


export async function applyCommand(ctx: Ctx): Promise<number> {
  const host = await detectHostOrExplain(ctx)
  const stateDir = stateDirFor(ctx, host)
  const adapter = await resolveTargetTool(ctx, host, stateDir)
  const dryRun = boolFlag(ctx.args, 'dry-run')
  const assumeYes = boolFlag(ctx.args, 'yes')

  const desired = await readDesired(ctx.deps.fs, stateDir, adapter.id)
  if (desired.problem) {
    throw new CliError(desired.problem, {
      code: EXIT.ERROR,
      hint: 'Fix or delete that file, then re-run `agentsync init --adopt`.',
    })
  }
  if (!desired.value || desired.value.layers.length === 0) {
    return nothingToDo(ctx, adapter, 'no-desired-state')
  }

  const bundle = await computePlan({
    adapter,
    host,
    layers: desired.value.layers,
    fs: ctx.deps.fs,
    cwd: ctx.cwd,
    now: nowIso(ctx),
  })
  const plan = bundle.plan
  const rules = adapter.rules(bundle.primary?.id)

  for (const e of bundle.readErrors) {
    ctx.err(ctx.style.yellow(`${ctx.sym.warn} could not read ${e.storeId}: ${e.error}`))
  }

  if (plan.changes.length === 0) return nothingToDo(ctx, adapter, 'in-sync')

  const pf = preflight(adapter, host, plan)

  if (pf.writable.length === 0) {
    return allBlocked(ctx, adapter, plan, pf)
  }

  // Secret references must resolve on-device before a write. There is no vault
  // wired into the CLI yet, so an unresolved ref is a hard stop rather than a
  // literal "${secret:...}" landing in a config file and breaking the tool.
  const unresolved = collectSecretRefs(pf.writable)
  if (unresolved.length > 0) {
    throw new CliError(
      `${unresolved.length} secret reference${unresolved.length === 1 ? '' : 's'} cannot be resolved on this device.`,
      {
        code: EXIT.ERROR,
        details: unresolved.map((r) => `\${secret:${r}}`),
        hint:
          'This device is not enrolled in a vault, and writing the literal placeholder would ' +
          'silently break the tool. Remove those keys from your desired state for now.',
      },
    )
  }

  // ---- review ------------------------------------------------------------
  // Shadowing is printed even under --yes and even in --json. `diff` warns too,
  // but `apply --yes` never runs `diff` — and that is precisely the path an
  // unattended sync takes. Creating `.rules` stops `CLAUDE.md` being read at
  // all: no error, nothing deleted, the agent just quietly follows different
  // instructions. Silence here would be worse than the bug it warns about.
  if (!ctx.json) {
    for (const w of bundle.shadowing) {
      ctx.out()
      ctx.out(
        `${ctx.style.yellow(ctx.sym.warn)} ${ctx.style.bold('This replaces your existing instructions')}`,
      )
      ctx.out(`  ${w.message}`)
    }
  }

  if (!ctx.json) {
    ctx.out()
    renderPlan(ctx, plan, {
      ...(rules ? { rules } : {}),
      blocked: pf.blocked,
      title: `${adapter.displayName}  ${ctx.style.gray(`plan ${plan.id.slice(0, 12)}`)}`,
    })
    ctx.out(`  ${planSummaryLine(ctx, plan)}`)
    ctx.out()
  }

  // ---- the shadowing gate -------------------------------------------------
  // Treated like a code-execution change because it is destructive in the same
  // way: the write succeeds, nothing errors, and the tool silently starts
  // following a different instructions file. `--yes` still bypasses it — the
  // warning above is printed unconditionally, so an unattended run leaves a
  // record of what it did.
  if (bundle.shadowing.length > 0 && !assumeYes && !dryRun && !ctx.json) {
    if (!ctx.deps.io.stdinIsTTY) {
      throw new CliError(
        'This would stop an existing instructions file from being read, and stdin is not a terminal.',
        {
          code: EXIT.ERROR,
          details: bundle.shadowing.map((w) => w.message),
          hint: 'Re-run with --yes to accept that, or run `agentsync apply` interactively.',
        },
      )
    }
    const ok = await ctx.deps.confirm('Replace the existing instructions? [y/N]')
    if (!ok) {
      ctx.err(ctx.style.yellow(`${ctx.sym.warn} Aborted. Nothing was written.`))
      return EXIT.ERROR
    }
  }

  // ---- the code-execution gate -------------------------------------------
  const dangerous = pf.writable.filter((c) => c.risk === 'code-execution')
  if (dangerous.length > 0 && !assumeYes) {
    const refusal = await requireApproval(ctx, dangerous, dryRun)
    if (refusal !== undefined) return refusal
  }

  // ---- dry run -----------------------------------------------------------
  if (dryRun) {
    if (ctx.json) {
      ctx.emit({
        ok: true,
        command: 'apply',
        exitCode: EXIT.OK,
        dryRun: true,
        toolId: adapter.id,
        planId: plan.id,
        wouldApply: pf.writable.map(changeJson),
        wouldRefuse: pf.blocked.map((b) => ({ ...changeJson(b.change), reason: b.reason, explain: b.explain })),
        shadowing: bundle.shadowing,
        summary: { risks: countRisks(pf.writable) },
      })
      return EXIT.OK
    }
    ctx.out(
      `${ctx.style.cyan(ctx.sym.info)} ${ctx.style.bold('Dry run')} — nothing was written. ` +
        `${pf.writable.length} change${pf.writable.length === 1 ? '' : 's'} would be applied, ${pf.blocked.length} refused.`,
    )
    ctx.note(`  ${ctx.style.gray('Re-run without --dry-run to apply.')}`)
    ctx.note()
    return EXIT.OK
  }

  // ---- the write ---------------------------------------------------------
  const applyDeps: ApplyDeps = {
    adapter,
    host,
    now: () => nowIso(ctx),
    ...(ctx.stateDirOverride !== undefined ? { stateDirOverride: ctx.stateDirOverride } : {}),
  }

  let result: ApplyResult
  try {
    // The adapter declares whether it can write. One that cannot is still
    // CALLED, so its own deliberate refusal reaches the user rather than being
    // routed around by us.
    result = adapter.capabilities.apply
      ? await ctx.deps.applyPlan(plan, applyDeps)
      : await adapter.apply(plan, host)
  } catch (err) {
    throw translateApplyError(err, adapter)
  }

  const failed = result.failed.length > 0
  const code = failed ? EXIT.ERROR : result.applied.length === 0 ? EXIT.NOTHING_TO_DO : EXIT.OK

  if (ctx.json) {
    ctx.emit({
      ok: !failed,
      command: 'apply',
      exitCode: code,
      dryRun: false,
      toolId: adapter.id,
      planId: result.planId,
      rollbackId: result.rollbackId || null,
      applied: result.applied.map(changeJson),
      shadowing: bundle.shadowing,
      skipped: result.skipped.map((c) => ({ ...changeJson(c), skipReason: c.skipReason })),
      failed: result.failed.map((c) => ({ ...changeJson(c), error: c.error })),
    })
    return code
  }

  renderResult(ctx, adapter, result)
  return code
}

// ---------------------------------------------------------------------------

async function requireApproval(ctx: Ctx, dangerous: Change[], dryRun: boolean): Promise<number | undefined> {
  const s = ctx.style

  if (ctx.json) {
    throw new CliError(
      `${dangerous.length} change${dangerous.length === 1 ? '' : 's'} can execute code and --json cannot prompt.`,
      {
        code: EXIT.ERROR,
        details: dangerous.map((c) => `${c.storeId} ${c.path}`),
        hint: 'Review them with `agentsync diff`, then re-run with --yes to approve them explicitly.',
      },
    )
  }

  ctx.err()
  for (const line of box(
    ctx,
    [
      `${ctx.sym.hazard} ${dangerous.length} change${dangerous.length === 1 ? '' : 's'} will let ${dangerous.length === 1 ? 'a command' : 'commands'} run on this machine`,
      '',
      ...dangerous.map((c) => `  ${c.path}  ${ctx.style.gray(c.storeId)}`),
    ],
    (t) => s.red(t),
  )) {
    ctx.err(line)
  }
  ctx.err()

  if (dryRun) {
    // A dry run has nothing to approve; say so instead of prompting for
    // permission to do nothing.
    ctx.err(s.gray('  (dry run — you would be asked to confirm these before any write)'))
    return undefined
  }

  if (!ctx.deps.io.stdinIsTTY) {
    throw new CliError('Code-execution changes need confirmation, but stdin is not a terminal.', {
      code: EXIT.ERROR,
      details: dangerous.map((c) => `${c.storeId} ${c.path}`),
      hint: 'Re-run with --yes to approve them explicitly, or run `agentsync apply` interactively.',
    })
  }

  const approved = await ctx.deps.confirm(`Apply ${dangerous.length === 1 ? 'it' : 'them'}? [y/N]`)
  if (!approved) {
    ctx.err(s.yellow(`${ctx.sym.warn} Aborted. Nothing was written.`))
    return EXIT.ERROR
  }
  return undefined
}

function nothingToDo(ctx: Ctx, adapter: ToolAdapter, reason: 'in-sync' | 'no-desired-state'): number {
  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'apply',
      exitCode: EXIT.NOTHING_TO_DO,
      toolId: adapter.id,
      reason,
      applied: [],
    })
    return EXIT.NOTHING_TO_DO
  }
  if (reason === 'in-sync') {
    ctx.out(`${ctx.style.green(ctx.sym.ok)} ${adapter.displayName} is already in the desired state. Nothing to apply.`)
  } else {
    ctx.out(`${ctx.style.gray(ctx.sym.info)} No desired state for ${adapter.displayName}.`)
    ctx.note(`  ${ctx.style.cyan(`agentsync init --adopt --tool ${adapter.id}`)}`)
  }
  return EXIT.NOTHING_TO_DO
}

function allBlocked(ctx: Ctx, adapter: ToolAdapter, plan: Plan, pf: Preflight): number {
  const code = pf.provenanceIsTheOnlyBlocker ? EXIT.BLOCKED_BY_PROVENANCE : EXIT.ERROR

  if (ctx.json) {
    ctx.emit({
      ok: false,
      command: 'apply',
      exitCode: code,
      toolId: adapter.id,
      planId: plan.id,
      applied: [],
      blocked: pf.blocked.map((b) => ({ ...changeJson(b.change), reason: b.reason, explain: b.explain, remedy: b.remedy })),
    })
    return code
  }

  const s = ctx.style
  ctx.out()
  ctx.out(
    `${s.yellow(ctx.sym.warn)} All ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'} for ${adapter.displayName} would be refused.`,
  )
  ctx.out()
  const seen = new Set<string>()
  for (const b of pf.blocked) {
    const key = `${b.reason}:${b.change.storeId}`
    if (seen.has(key)) continue
    seen.add(key)
    ctx.out(`  ${s.red(ctx.sym.fail)} ${b.change.storeId}`)
    ctx.out(`      ${b.explain}`)
    ctx.out(`      ${s.gray(b.remedy)}`)
  }
  ctx.out()
  return code
}

function renderResult(ctx: Ctx, adapter: ToolAdapter, result: ApplyResult): void {
  const s = ctx.style

  if (result.applied.length > 0) {
    const lines = [
      `${s.green(ctx.sym.ok)} Applied ${result.applied.length} change${result.applied.length === 1 ? '' : 's'} to ${adapter.displayName}`,
      '',
      `${s.bold('ROLLBACK ID')}  ${s.bold(s.cyan(result.rollbackId))}`,
      '',
      s.gray(`agentsync rollback ${result.rollbackId}`),
    ]
    ctx.out()
    for (const line of box(ctx, lines, (t) => s.green(t))) ctx.out(line)
    ctx.out()
  }

  if (result.skipped.length > 0) {
    ctx.out(s.bold(`Skipped ${result.skipped.length}`))
    for (const c of result.skipped) {
      ctx.out(`  ${s.gray(ctx.sym.bullet)} ${c.path} ${s.gray(`(${c.storeId})`)}`)
      ctx.out(`      ${s.gray(c.skipReason)}`)
    }
    ctx.out()
  }

  if (result.failed.length > 0) {
    ctx.out(s.bold(s.red(`Failed ${result.failed.length}`)))
    for (const c of result.failed) {
      ctx.out(`  ${s.red(ctx.sym.fail)} ${c.path} ${s.gray(`(${c.storeId})`)}`)
      ctx.out(`      ${c.error}`)
    }
    ctx.out()
  }
}

function translateApplyError(err: unknown, adapter: ToolAdapter): CliError {
  if (err instanceof StalePlanError) {
    return new CliError(err.message, {
      code: EXIT.ERROR,
      hint: 'Run `agentsync diff` to see the current state, then apply again. Nothing was written.',
      details: [`store: ${err.storeId}`],
      cause: err,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/NotImplemented/i.test(err instanceof Error ? err.name : '')) {
    return new CliError(`${adapter.displayName} cannot be applied by this build yet.`, {
      code: EXIT.ERROR,
      details: [message],
      hint:
        `Writing ${adapter.displayName} config needs a comment-preserving JSONC writer; the shared ` +
        'engine writes canonical JSON and would delete your comments. `diff` works today.',
      cause: err,
    })
  }
  return new CliError(`Apply failed: ${message}`, {
    code: EXIT.ERROR,
    hint: 'Every file written in this apply was restored. Run `agentsync doctor` if it keeps happening.',
    cause: err,
  })
}

function changeJson(c: Change): Record<string, unknown> {
  // Deliberately no `before`/`after`: an apply result is an audit record, and
  // values belong in `diff` where they go through redaction.
  return { storeId: c.storeId, op: c.op, path: c.path, risk: c.risk }
}

function collectSecretRefs(changes: Change[]): string[] {
  const refs = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') for (const r of extractSecretRefs(v)) refs.add(r)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
  }
  for (const c of changes) walk(c.after)
  return [...refs]
}

