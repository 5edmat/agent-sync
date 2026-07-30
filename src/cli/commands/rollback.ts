/**
 * `agentsync rollback` — undo an apply.
 *
 * This is the command people reach for while something is broken, so it
 * optimises for being usable under stress: `--list` first, ids are accepted by
 * unique prefix, and an unknown id prints the ids that do exist rather than
 * just failing.
 */

import type { CommandSpec } from '../args.js'
import { boolFlag } from '../args.js'
import type { Ctx } from '../context.js'
import type { ApplyDeps } from '../../core/apply-engine.js'
import type { RollbackRecord } from '../deps.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import { table } from '../render.js'
import { detectHostOrExplain, nowIso, resolveTargetTool, stateDirFor } from './common.js'

export const rollbackSpec: CommandSpec = {
  name: 'rollback',
  summary: 'Restore the files an earlier apply changed.',
  usage: 'agentsync rollback <id> | agentsync rollback --list',
  flags: {
    list: { type: 'boolean', alias: 'l', description: 'Show available rollback points, newest first.' },
    tool: { type: 'string', placeholder: '<id>', description: 'Tool whose rollback store to use.' },
    yes: { type: 'boolean', alias: 'y', description: 'Skip the confirmation prompt.' },
  },
  positionals: [{ name: 'id', required: true, description: 'The rollback id printed by `apply`.' }],
  positionalsSatisfiedBy: ['list'],
  examples: ['agentsync rollback --list', 'agentsync rollback rb-1a2b3c4d5e6f-01234567'],
}

export async function rollbackCommand(ctx: Ctx): Promise<number> {
  const host = await detectHostOrExplain(ctx)
  const stateDir = stateDirFor(ctx, host)
  const adapter = await resolveTargetTool(ctx, host, stateDir)

  const deps: ApplyDeps = {
    adapter,
    host,
    now: () => nowIso(ctx),
    ...(ctx.stateDirOverride !== undefined ? { stateDirOverride: ctx.stateDirOverride } : {}),
  }

  const records = await ctx.deps.listRollbacks(deps)

  if (boolFlag(ctx.args, 'list')) return listRollbacksCommand(ctx, records)

  const needle = ctx.args.positionals[0]
  if (needle === undefined) {
    throw new UsageError('`agentsync rollback` needs a rollback id.', {
      hint: 'Run `agentsync rollback --list` to see them.',
    })
  }

  const matches = records.filter((r) => r.rollbackId === needle || r.rollbackId.startsWith(needle))
  if (matches.length === 0) {
    throw new CliError(`No rollback point matches "${needle}".`, {
      code: EXIT.ERROR,
      hint: 'Run `agentsync rollback --list` to see what is available.',
      details:
        records.length > 0
          ? records.slice(0, 5).map((r) => `${r.rollbackId}  ${r.createdAt}`)
          : ['There are no rollback points on this device yet — nothing has been applied.'],
    })
  }
  if (matches.length > 1) {
    throw new UsageError(`"${needle}" matches ${matches.length} rollback points.`, {
      hint: 'Use more characters of the id.',
      details: matches.map((r) => r.rollbackId),
    })
  }

  const target = matches[0] as RollbackRecord

  if (!boolFlag(ctx.args, 'yes') && !ctx.json && ctx.deps.io.stdinIsTTY) {
    ctx.err(
      `${ctx.style.yellow(ctx.sym.warn)} This restores ${target.tokens.length} file${target.tokens.length === 1 ? '' : 's'} to their state before ${target.createdAt}.`,
    )
    for (const t of target.tokens) ctx.err(`    ${ctx.style.gray(t.path)}`)
    const ok = await ctx.deps.confirm('Restore them? [y/N]')
    if (!ok) {
      ctx.err(ctx.style.yellow(`${ctx.sym.warn} Aborted. Nothing was restored.`))
      return EXIT.ERROR
    }
  }

  try {
    await ctx.deps.rollbackApply(target.rollbackId, deps)
  } catch (err) {
    throw new CliError(`Rollback failed: ${(err as Error).message}`, {
      code: EXIT.ERROR,
      hint:
        'Some files may not have been restored. The backups are still on disk — see ' +
        '`agentsync doctor` for the state directory, and the manifest lists every path.',
      details: target.tokens.map((t) => t.path),
      cause: err,
    })
  }

  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'rollback',
      exitCode: EXIT.OK,
      rollbackId: target.rollbackId,
      planId: target.planId,
      restored: target.tokens.map((t) => t.path),
    })
    return EXIT.OK
  }

  ctx.out(
    `${ctx.style.green(ctx.sym.ok)} Restored ${target.tokens.length} file${target.tokens.length === 1 ? '' : 's'} from ${ctx.style.cyan(target.rollbackId)}.`,
  )
  for (const t of target.tokens) ctx.out(`    ${ctx.style.gray(t.path)}`)
  return EXIT.OK
}

function listRollbacksCommand(ctx: Ctx, records: RollbackRecord[]): number {
  if (ctx.json) {
    ctx.emit({
      ok: true,
      command: 'rollback',
      exitCode: records.length === 0 ? EXIT.NOTHING_TO_DO : EXIT.OK,
      rollbacks: records.map((r) => ({
        rollbackId: r.rollbackId,
        planId: r.planId,
        createdAt: r.createdAt,
        files: r.tokens.map((t) => t.path),
      })),
    })
    return records.length === 0 ? EXIT.NOTHING_TO_DO : EXIT.OK
  }

  if (records.length === 0) {
    ctx.out(`${ctx.style.gray(ctx.sym.info)} No rollback points on this device — nothing has been applied yet.`)
    return EXIT.NOTHING_TO_DO
  }

  ctx.out()
  ctx.out(ctx.style.bold(`${records.length} rollback point${records.length === 1 ? '' : 's'}, newest first`))
  const rows = records.map((r) => [
    ctx.style.cyan(r.rollbackId),
    r.createdAt,
    String(r.tokens.length),
    ctx.style.gray(r.planId.slice(0, 12)),
  ])
  for (const line of table(
    ctx,
    [{ header: 'ID' }, { header: 'WHEN' }, { header: 'FILES', align: 'right' }, { header: 'PLAN' }],
    rows,
  )) {
    ctx.out(line)
  }
  if (ctx.verbose) {
    // Which files a rollback would touch is the thing that distinguishes two
    // otherwise identical-looking entries, so it is one flag away.
    ctx.out()
    for (const r of records) {
      ctx.out(`  ${ctx.style.cyan(r.rollbackId)}`)
      for (const t of r.tokens) ctx.out(`      ${ctx.style.gray(t.path)}`)
    }
  }
  ctx.note()
  ctx.note(`  ${ctx.style.cyan(`agentsync rollback ${records[0]?.rollbackId ?? '<id>'}`)}`)
  ctx.note()
  return EXIT.OK
}
