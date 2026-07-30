/**
 * Materializing one path at another: symlink, junction, or copy.
 *
 * Claude Code's real on-disk layout links skills/agents into place with
 * *relative* symlinks (`../../.agents/skills/foo`). That detail drives two
 * requirements:
 *
 *  - When we create links we default to relative targets too, so the whole
 *    tree survives being moved or synced to a different home directory.
 *  - When we read links we must resolve relative targets against the link's
 *    own directory, not the process cwd. `fs.readlink` gives you the raw
 *    string; resolving it wrong silently points at nothing.
 *
 * On Windows, `CreateSymbolicLink` needs Developer Mode or elevation, so
 * `host.supportsSymlinks` (probed, never assumed) selects the strategy:
 * symlink -> directory junction -> real recursive copy. Copy is correct but
 * lossy: edits no longer propagate, so we flag it as `degraded` and the caller
 * surfaces that to the user rather than pretending the link exists.
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import type { HostEnv } from '../core/types.js'
import { errnoCode } from './atomic.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkStrategy = 'symlink' | 'junction' | 'copy'

export interface LinkAttempt {
  strategy: LinkStrategy
  ok: boolean
  /** errno code (EPERM, ENOSYS, ...) when the attempt failed. */
  errorCode?: string
  errorMessage?: string
}

export interface MaterializeResult {
  strategy: LinkStrategy
  src: string
  dest: string
  kind: 'file' | 'dir'
  /** Every strategy tried, in order, including the one that succeeded. */
  attempts: LinkAttempt[]
  /**
   * True when we could not use the ideal strategy for this host. A copy is
   * `degraded: true` because edits stop propagating; the caller should tell
   * the user their skills directory is now a snapshot, not a link.
   */
  degraded: boolean
  /** Target string actually stored in the link (relative when we chose relative). */
  linkTarget?: string
  /** Populated for `copy`. */
  filesCopied?: number
  bytesCopied?: number
  /** True when the destination already pointed where we wanted; nothing was written. */
  unchanged: boolean
}

export interface LinkInfo {
  path: string
  isLink: boolean
  kind: 'symlink' | 'junction' | 'none'
  /** Exactly what is stored in the link, e.g. `../../.agents/skills/foo`. */
  raw: string | null
  /** Absolute, normalized, resolved against `dirname(path)`. */
  resolved: string | null
  /** Whether `resolved` currently exists. Dangling links are common and legal. */
  targetExists: boolean
  /** True when `raw` is not absolute. */
  isRelative: boolean
}

export interface LinkOps {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; size: number; mode: number }>
  stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mode: number }>
  readlink(p: string): Promise<string>
  symlink(target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): Promise<void>
  mkdir(p: string, opts: { recursive: true }): Promise<string | undefined>
  readdir(p: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>>
  copyFile(from: string, to: string): Promise<void>
  chmod(p: string, mode: number): Promise<void>
  rm(p: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>
}

export const nodeLinkOps: LinkOps = {
  lstat: (p) => fsp.lstat(p),
  stat: (p) => fsp.stat(p),
  readlink: (p) => fsp.readlink(p),
  symlink: (target, linkPath, type) => fsp.symlink(target, linkPath, type),
  mkdir: (p, opts) => fsp.mkdir(p, opts),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  copyFile: (from, to) => fsp.copyFile(from, to),
  chmod: (p, mode) => fsp.chmod(p, mode),
  rm: (p, opts) => fsp.rm(p, opts),
}

export interface MaterializeOptions {
  /**
   * `relative` stores `../../.agents/skills/foo` (matches Claude Code's own
   * layout and survives a moved home dir). `absolute` stores a full path.
   * Junctions are always absolute — Win32 requires it.
   */
  linkTarget?: 'relative' | 'absolute'
  /** Replace an existing dest. Default true. */
  overwrite?: boolean
  /** Skip strategies even if the host supports them. Used to force-test copy. */
  allow?: readonly LinkStrategy[]
  ops?: LinkOps
  /** Preserve mode bits when copying. Default true (ignored on Windows). */
  preserveMode?: boolean
}

export class MaterializeError extends Error {
  readonly attempts: LinkAttempt[]
  constructor(message: string, attempts: LinkAttempt[]) {
    super(message)
    this.name = 'MaterializeError'
    this.attempts = attempts
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Windows readlink returns junction (and often symlink) targets in the
 * extended-length form `\\?\C:\Users\...`. That prefix is a Win32 API detail,
 * not part of the path, and comparing it against a normal path always fails.
 */
export function stripWindowsExtendedPrefix(target: string): string {
  if (target.startsWith('\\\\?\\UNC\\')) return `\\\\${target.slice(8)}`
  if (target.startsWith('\\\\?\\')) return target.slice(4)
  return target
}

/**
 * Resolve a link's raw target to an absolute path.
 *
 * The bug this exists to prevent: `path.resolve(raw)` on a relative target
 * resolves against `process.cwd()`, which is wherever the user happened to run
 * the CLI. Relative targets are relative to the *link's directory*.
 */
export function resolveLinkTarget(linkPath: string, raw: string): string {
  const cleaned = stripWindowsExtendedPrefix(raw)
  if (path.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) {
    return path.normalize(cleaned)
  }
  return path.resolve(path.dirname(path.resolve(linkPath)), cleaned)
}

/**
 * Relative target from a link at `linkPath` to `target`, always POSIX-style
 * with `/` separators so the same value is portable across a synced tree.
 */
export function relativeLinkTarget(linkPath: string, target: string): string {
  const rel = path.relative(path.dirname(path.resolve(linkPath)), path.resolve(target))
  const posix = rel.split(path.sep).join('/')
  return posix.length === 0 ? '.' : posix
}

/** Which strategies to try, in order, for this host and entry kind. */
export function planStrategies(
  host: Pick<HostEnv, 'os' | 'supportsSymlinks'>,
  kind: 'file' | 'dir',
  allow?: readonly LinkStrategy[],
): LinkStrategy[] {
  const ordered: LinkStrategy[] = []
  if (host.supportsSymlinks) ordered.push('symlink')
  // Junctions only exist on Windows and only for directories, but they need no
  // special privilege — which is exactly why they are the Windows fallback.
  if (host.os === 'windows' && kind === 'dir') ordered.push('junction')
  ordered.push('copy')
  if (!allow) return ordered
  const allowed = new Set(allow)
  return ordered.filter((s) => allowed.has(s))
}

// ---------------------------------------------------------------------------
// readLinkTarget
// ---------------------------------------------------------------------------

/**
 * Inspect a path that may be a symlink or junction.
 *
 * Never throws for "not a link" or "does not exist" — those are ordinary
 * states in a config tree and the caller wants the info, not an exception.
 */
export async function readLinkTarget(linkPath: string, ops: LinkOps = nodeLinkOps): Promise<LinkInfo> {
  const abs = path.resolve(linkPath)
  const none: LinkInfo = {
    path: abs,
    isLink: false,
    kind: 'none',
    raw: null,
    resolved: null,
    targetExists: false,
    isRelative: false,
  }

  let st: Awaited<ReturnType<LinkOps['lstat']>>
  try {
    st = await ops.lstat(abs)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return none
    throw err
  }

  // Node reports Windows junctions as symbolic links from lstat.
  if (!st.isSymbolicLink()) return none

  let raw: string
  try {
    raw = await ops.readlink(abs)
  } catch (err) {
    if (errnoCode(err) === 'EINVAL') return none
    throw err
  }

  const cleanedRaw = stripWindowsExtendedPrefix(raw)
  const resolved = resolveLinkTarget(abs, raw)
  let targetExists = false
  try {
    await ops.stat(resolved)
    targetExists = true
  } catch {
    targetExists = false
  }

  return {
    path: abs,
    isLink: true,
    // A junction always stores an absolute target and only exists on Windows;
    // that is the best signal available without a native reparse-point read.
    kind: raw.startsWith('\\\\?\\') ? 'junction' : 'symlink',
    raw: cleanedRaw,
    resolved,
    targetExists,
    isRelative: !path.isAbsolute(cleanedRaw) && !path.win32.isAbsolute(cleanedRaw),
  }
}

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

async function removeIfPresent(ops: LinkOps, p: string): Promise<void> {
  // rm -rf handles all three cases (file, dir, dangling link) without an
  // lstat race, and does not follow the link when deleting.
  await ops.rm(p, { recursive: true, force: true })
}

interface CopyStats {
  files: number
  bytes: number
}

/**
 * Recursive copy. Hand-rolled rather than `fs.cp` because we need per-file
 * counts for the report and because `fs.cp` still prints an experimental
 * warning on Node 20, which would show up in every CLI run on Windows.
 */
async function copyRecursive(
  ops: LinkOps,
  src: string,
  dest: string,
  preserveMode: boolean,
  stats: CopyStats,
): Promise<void> {
  const st = await ops.lstat(src)

  if (st.isSymbolicLink()) {
    // Preserve inner links as links where possible; if the host cannot create
    // them we dereference and copy the contents instead.
    const raw = await ops.readlink(src)
    try {
      await ops.symlink(raw, dest)
      return
    } catch {
      const resolved = resolveLinkTarget(src, raw)
      await copyRecursive(ops, resolved, dest, preserveMode, stats)
      return
    }
  }

  if (st.isDirectory()) {
    await ops.mkdir(dest, { recursive: true })
    const entries = await ops.readdir(src)
    // Sorted so a copy is reproducible and diffs of the report are stable.
    const names = entries.map((e) => e.name).sort()
    for (const name of names) {
      await copyRecursive(ops, path.join(src, name), path.join(dest, name), preserveMode, stats)
    }
    if (preserveMode) await ops.chmod(dest, st.mode & 0o7777).catch(() => {})
    return
  }

  await ops.mkdir(path.dirname(dest), { recursive: true })
  await ops.copyFile(src, dest)
  if (preserveMode) await ops.chmod(dest, st.mode & 0o7777).catch(() => {})
  stats.files += 1
  stats.bytes += st.size
}

/**
 * Make `dest` provide the contents of `src`, using the best mechanism this
 * host actually supports, and report which one was used.
 */
export async function materialize(
  src: string,
  dest: string,
  host: Pick<HostEnv, 'os' | 'supportsSymlinks'>,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const {
    linkTarget = 'relative',
    overwrite = true,
    allow,
    ops = nodeLinkOps,
    preserveMode = true,
  } = options

  const absSrc = path.resolve(src)
  const absDest = path.resolve(dest)

  const srcStat = await ops.stat(absSrc) // follows links: we care about the real kind
  const kind: 'file' | 'dir' = srcStat.isDirectory() ? 'dir' : 'file'

  const strategies = planStrategies(host, kind, allow)
  if (strategies.length === 0) {
    throw new MaterializeError(`no viable strategy for ${absSrc} -> ${absDest}`, [])
  }
  const ideal = strategies[0] as LinkStrategy

  // Already correct? Do nothing — re-linking on every sync churns mtimes and
  // triggers file watchers in every editor the user has open.
  const existingLink = await readLinkTarget(absDest, ops)
  if (existingLink.isLink && existingLink.resolved === absSrc) {
    return {
      strategy: existingLink.kind === 'junction' ? 'junction' : 'symlink',
      src: absSrc,
      dest: absDest,
      kind,
      attempts: [],
      degraded: false,
      ...(existingLink.raw !== null ? { linkTarget: existingLink.raw } : {}),
      unchanged: true,
    }
  }

  if (!overwrite) {
    // Without this, every strategy fails with EEXIST and the caller gets a
    // confusing "tried symlink, junction, copy" error instead of the truth.
    let destExists = true
    try {
      await ops.lstat(absDest)
    } catch {
      destExists = false
    }
    if (destExists) {
      throw new MaterializeError(`${absDest} already exists and overwrite is disabled`, [])
    }
  }

  const attempts: LinkAttempt[] = []

  for (const strategy of strategies) {
    if (overwrite) await removeIfPresent(ops, absDest)
    await ops.mkdir(path.dirname(absDest), { recursive: true })

    try {
      if (strategy === 'symlink') {
        const target = linkTarget === 'relative' ? relativeLinkTarget(absDest, absSrc) : absSrc
        // The type argument is ignored on POSIX and required on Windows.
        await ops.symlink(target, absDest, kind === 'dir' ? 'dir' : 'file')
        attempts.push({ strategy, ok: true })
        return {
          strategy,
          src: absSrc,
          dest: absDest,
          kind,
          attempts,
          degraded: strategy !== ideal,
          linkTarget: target,
          unchanged: false,
        }
      }

      if (strategy === 'junction') {
        // Junctions require an absolute target; a relative one silently
        // resolves against the volume root, not the link's directory.
        await ops.symlink(absSrc, absDest, 'junction')
        attempts.push({ strategy, ok: true })
        return {
          strategy,
          src: absSrc,
          dest: absDest,
          kind,
          attempts,
          // A junction behaves like a link for reads and writes, so this is
          // not a functional downgrade — just a different mechanism.
          degraded: false,
          linkTarget: absSrc,
          unchanged: false,
        }
      }

      const stats: CopyStats = { files: 0, bytes: 0 }
      await copyRecursive(ops, absSrc, absDest, preserveMode && host.os !== 'windows', stats)
      attempts.push({ strategy, ok: true })
      return {
        strategy,
        src: absSrc,
        dest: absDest,
        kind,
        attempts,
        // Always degraded: a copy does not track later edits to src.
        degraded: true,
        filesCopied: stats.files,
        bytesCopied: stats.bytes,
        unchanged: false,
      }
    } catch (err) {
      attempts.push({
        strategy,
        ok: false,
        ...(errnoCode(err) !== undefined ? { errorCode: errnoCode(err) as string } : {}),
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
  }

  throw new MaterializeError(
    `could not materialize ${absSrc} at ${absDest}; tried ${attempts.map((a) => a.strategy).join(', ')}`,
    attempts,
  )
}
