/**
 * `agentsync diff` — render a Plan, and nothing else.
 *
 * This command is deliberately incapable of writing. It shares `computePlan`
 * with `apply`, so what you review here is what would run; and it runs
 * `preflight` so a change that `apply` would refuse is labelled as refused
 * *here*, rather than discovered after the user has already approved it.
 */

import type { CommandSpec } from '../args.js'
import { boolFlag } from '../args.js'
import type { Ctx } from '../context.js'
import { CliError, EXIT } from '../exit.js'
import { computePlan, countRisks, preflight } from '../planner.js'
import { readDesired } from '../state.js'
import { planSummaryLine, renderPlan } from '../render.js'
import { redactValue } from '../redact.js'
import { detectHostOrExplain, nowIso, resolveTargetTool, stateDirFor } from './common.js'

export const diffSpec: CommandSpec = {
  name: 'diff',
  summary: 'Compute a plan and render it as a readable diff.',
  usage: 'agentsync diff [--tool <id>] [--json]',
  description:
    'Never writes. Changes that `apply` would refuse (managed policy, unverified path, ' +
    'non-file store) are marked as refused here so you find out before approving.',
  flags: {
    tool: { type: 'string', placeholder: '<id>', description: 'Which tool to diff.' },
    'show-desired': {
      type: 'boolean',
      description: 'Also print the merged desired document (redacted).',
    },
  },
  examples: ['agentsync diff', 'agentsync diff --tool claude-code', 'agentsync diff --json | jq .changes'],
  exitNotes: ['3 — no changes; already in the desired state', '4 — every change is blocked by unverified provenance'],
}

export async function diffCommand(ctx: Ctx): Promise<number> {
  const host = await detectHostOrExplain(ctx)
  const stateDir = stateDirFor(ctx, host)
  const adapter = await resolveTargetTool(ctx, host, stateDir)

  const desired = await readDesired(ctx.deps.fs, stateDir, adapter.id)
  if (desired.problem) {
    throw new CliError(desired.problem, {
      code: EXIT.ERROR,
      hint: 'Fix or delete that file, then re-run `agentsync init --adopt`.',
    })
  }
  if (!desired.value || desired.value.layers.length === 0) {
    if (ctx.json) {
      ctx.emit({
        ok: true,
        command: 'diff',
        exitCode: EXIT.NOTHING_TO_DO,
        toolId: adapter.id,
        reason: 'no-desired-state',
        changes: [],
      })
      return EXIT.NOTHING_TO_DO
    }
    ctx.out(`${ctx.style.gray(ctx.sym.info)} No desired state for ${adapter.displayName}.`)
    ctx.note(
      `  ${ctx.style.cyan(`agentsync init --adopt --tool ${adapter.id}`)} ${ctx.style.gray('captures the current config as your base layer')}`,
    )
    return EXIT.NOTHING_TO_DO
  }

  const bundle = await computePlan({
    adapter,
    host,
    layers: desired.value.layers,
    fs: ctx.deps.fs,
    cwd: ctx.cwd,
    now: nowIso(ctx),
  })
  const pf = preflight(adapter, host, bundle.plan)
  const rules = adapter.rules(bundle.primary?.id)

  for (const e of bundle.readErrors) {
    ctx.err(ctx.style.yellow(`${ctx.sym.warn} could not read ${e.storeId}: ${e.error}`))
  }

  const code =
    bundle.plan.changes.length === 0
      ? EXIT.NOTHING_TO_DO
      : pf.provenanceIsTheOnlyBlocker
        ? EXIT.BLOCKED_BY_PROVENANCE
        : EXIT.OK

  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'diff',
      exitCode: code,
      toolId: adapter.id,
      planId: bundle.plan.id,
      createdAt: bundle.plan.createdAt,
      deviceId: bundle.plan.deviceId,
      summary: { total: bundle.plan.changes.length, risks: countRisks(bundle.plan.changes), blocked: pf.blocked.length },
      changes: bundle.plan.changes.map((c) => ({
        storeId: c.storeId,
        op: c.op,
        path: c.path,
        risk: c.risk,
        reason: c.reason,
        overriddenBy: c.overriddenBy ?? null,
        inert: c.inert ?? null,
        // Redacted here too: --json output ends up in CI logs.
        before: redactValue(c.before, { path: c.path, rules }),
        after: redactValue(c.after, { path: c.path, rules }),
      })),
      blocked: pf.blocked.map((b) => ({
        storeId: b.change.storeId,
        path: b.change.path,
        reason: b.reason,
        explain: b.explain,
        remedy: b.remedy,
      })),
      warnings: bundle.plan.warnings,
      shadowing: bundle.shadowing,
      readErrors: bundle.readErrors,
      ...(boolFlag(ctx.args, 'show-desired') ? { desired: redactValue(bundle.desired, { rules }) } : {}),
    })
    return code
  }

  ctx.out()
  // Loud, and above everything else: this is a write that looks additive and
  // is destructive, so burying it under a change list would defeat the point.
  for (const w of bundle.shadowing) {
    ctx.out(`${ctx.style.yellow(ctx.sym.warn)} ${ctx.style.bold('This replaces your existing instructions')}`)
    ctx.out(`  ${w.message}`)
    ctx.out()
  }
  if (bundle.plan.changes.length === 0) {
    ctx.out(
      `${ctx.style.green(ctx.sym.ok)} ${adapter.displayName} is already in the desired state. ${ctx.style.gray(`(plan ${bundle.plan.id.slice(0, 12)})`)}`,
    )
    for (const w of bundle.plan.warnings) ctx.out(`  ${ctx.style.yellow(ctx.sym.warn)} ${w}`)
    ctx.out()
    return EXIT.NOTHING_TO_DO
  }

  renderPlan(ctx, bundle.plan, {
    ...(rules ? { rules } : {}),
    blocked: pf.blocked,
    title: `${adapter.displayName}  ${ctx.style.gray(`plan ${bundle.plan.id.slice(0, 12)}`)}`,
  })

  if (boolFlag(ctx.args, 'show-desired')) {
    ctx.out(ctx.style.bold('Merged desired document (redacted)'))
    const text = JSON.stringify(redactValue(bundle.desired, { rules }), null, 2) ?? '{}'
    for (const line of text.split('\n')) ctx.out(`  ${ctx.style.gray(line)}`)
    ctx.out()
  }

  ctx.out(`  ${planSummaryLine(ctx, bundle.plan)}`)
  if (pf.blocked.length > 0) {
    ctx.out(
      `  ${ctx.style.yellow(`${ctx.sym.warn} ${pf.blocked.length} of ${bundle.plan.changes.length} would be refused by \`apply\` — see the notes above`)}`,
    )
  }
  ctx.note()
  ctx.note(`  ${ctx.style.cyan(`agentsync apply --tool ${adapter.id}`)} ${ctx.style.gray('to write these')}`)
  ctx.note()
  return code
}
