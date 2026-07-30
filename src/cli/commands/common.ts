/**
 * Shared plumbing for command handlers: host detection, state directory
 * resolution, and tool selection. Kept out of the individual commands so that
 * `--tool` means exactly one thing everywhere and the "which tool did you
 * mean?" error is written once.
 */

import type { HostEnv, ToolAdapter } from '../../core/types.js'
import { hostStateDir } from '../../platform/host.js'
import { CliError, EXIT, UsageError } from '../exit.js'
import { stringFlag, suggest } from '../args.js'
import type { Ctx } from '../context.js'
import { readDesired } from '../state.js'

export async function detectHostOrExplain(ctx: Ctx): Promise<HostEnv> {
  try {
    return await ctx.deps.detectHost()
  } catch (err) {
    throw new CliError(`Could not detect this host: ${(err as Error).message}`, {
      code: EXIT.ERROR,
      hint: 'Run `agentsync doctor` for the full probe output, or set AGENTSYNC_STATE_DIR to a writable directory.',
      cause: err,
    })
  }
}

export function stateDirFor(ctx: Ctx, host: HostEnv): string {
  return ctx.stateDirOverride ?? hostStateDir(host, ctx.deps.env)
}

export function knownToolIds(ctx: Ctx): string[] {
  return ctx.deps.adapters.map((a) => a.id)
}

/** `--tool <id>` -> adapter, with a suggestion when the id is a typo. */
export function adapterById(ctx: Ctx, id: string): ToolAdapter {
  const found = ctx.deps.adapters.find((a) => a.id === id)
  if (found) return found
  const ids = knownToolIds(ctx)
  const near = suggest(id, ids)
  throw new UsageError(`Unknown tool "${id}".`, {
    ...(near ? { hint: `Did you mean \`--tool ${near}\`?` } : {}),
    details: [`Tools this build knows about: ${ids.join(', ')}`],
  })
}

/**
 * Which tool `diff` / `apply` should operate on when `--tool` is absent.
 *
 * Preference order, and the reasoning: an explicit flag always wins; then the
 * single tool that actually has desired state, because operating on a tool with
 * nothing configured can only ever produce an empty plan; then, if exactly one
 * tool is installed, that one. Anything else is ambiguous and we ask rather
 * than guess — guessing here means applying config to the wrong editor.
 */
export async function resolveTargetTool(
  ctx: Ctx,
  host: HostEnv,
  stateDir: string,
): Promise<ToolAdapter> {
  const explicit = stringFlag(ctx.args, 'tool')
  if (explicit) return adapterById(ctx, explicit)

  const configured: ToolAdapter[] = []
  for (const adapter of ctx.deps.adapters) {
    const desired = await readDesired(ctx.deps.fs, stateDir, adapter.id)
    if (desired.value && desired.value.layers.length > 0) configured.push(adapter)
  }
  if (configured.length === 1) return configured[0] as ToolAdapter
  if (configured.length > 1) {
    throw new UsageError(`${configured.length} tools have desired state; say which one.`, {
      hint: `Try \`--tool ${configured[0]?.id}\`.`,
      details: [`Configured: ${configured.map((a) => a.id).join(', ')}`],
    })
  }

  const installed: ToolAdapter[] = []
  for (const adapter of ctx.deps.adapters) {
    try {
      const detection = await adapter.detect(host)
      if (detection.installed) installed.push(adapter)
    } catch {
      // A failing detect() is a `doctor` problem, not a reason to abort here.
    }
  }
  if (installed.length === 1) return installed[0] as ToolAdapter

  throw new UsageError(
    installed.length === 0
      ? 'No supported tool was detected on this device.'
      : `${installed.length} tools are installed; say which one.`,
    {
      hint:
        installed.length === 0
          ? 'Run `agentsync status` to see what was looked for and where.'
          : `Try \`--tool ${installed[0]?.id}\`.`,
      details: [`Tools this build knows about: ${knownToolIds(ctx).join(', ')}`],
    },
  )
}

/** ISO timestamp from the injected clock. Nothing reads `Date.now()` directly. */
export function nowIso(ctx: Ctx): string {
  return ctx.deps.now().toISOString()
}
