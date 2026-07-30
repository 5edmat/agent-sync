/**
 * Atomic file writes and rollback tokens.
 *
 * The contract: a reader of `path` sees either the complete old contents or
 * the complete new contents. Never a truncated file, never a zero-byte file,
 * never a file with the wrong mode.
 *
 * Getting there is the usual write-temp / fsync / rename dance, plus two
 * things that only matter in the real world:
 *
 *  1. **Windows.** `rename()` over an existing file is not the reliable atomic
 *     primitive it is on POSIX. Defender, Search Indexer, Dropbox, and every
 *     corporate EDR agent open files opportunistically and hold them for tens
 *     of milliseconds, during which `MoveFileEx` returns EPERM/EACCES/EBUSY.
 *     The fix is retry with exponential backoff and jitter, not a bug report.
 *
 *  2. **Modes.** `~/.claude/.credentials.json` is 0600. A naive
 *     `writeFile(tmp)` + `rename` creates the temp at `0666 & ~umask` and the
 *     credentials file silently becomes world-readable. We stat first and
 *     re-apply.
 */

import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Injectable fs surface (fault injection in tests)
// ---------------------------------------------------------------------------

export interface FileHandleLike {
  writeFile(data: Uint8Array | string): Promise<unknown>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StatLike {
  mode: number
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface AtomicFsOps {
  open(p: string, flags: string, mode?: number): Promise<FileHandleLike>
  stat(p: string): Promise<StatLike>
  /** Does NOT follow symlinks — used to detect a dotfiles symlink. */
  lstat(p: string): Promise<StatLike & { isSymbolicLink(): boolean }>
  realpath(p: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  chmod(p: string, mode: number): Promise<void>
  unlink(p: string): Promise<void>
  rm(p: string, opts: { force?: boolean; recursive?: boolean }): Promise<void>
  mkdir(p: string, opts: { recursive: true }): Promise<string | undefined>
  readFile(p: string): Promise<Buffer>
  copyFile(from: string, to: string): Promise<void>
}

export const nodeFsOps: AtomicFsOps = {
  open: (p, flags, mode) => fsp.open(p, flags, mode) as unknown as Promise<FileHandleLike>,
  stat: (p) => fsp.stat(p) as unknown as Promise<StatLike>,
  lstat: (p) => fsp.lstat(p) as unknown as Promise<StatLike & { isSymbolicLink(): boolean }>,
  realpath: (p) => fsp.realpath(p),
  rename: (from, to) => fsp.rename(from, to),
  chmod: (p, mode) => fsp.chmod(p, mode),
  unlink: (p) => fsp.unlink(p),
  rm: (p, opts) => fsp.rm(p, opts),
  mkdir: (p, opts) => fsp.mkdir(p, opts),
  readFile: (p) => fsp.readFile(p),
  copyFile: (from, to) => fsp.copyFile(from, to),
}

// ---------------------------------------------------------------------------
// Errors + retry classification
// ---------------------------------------------------------------------------

export function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * Errors that mean "something else is touching this file right now", as
 * opposed to "this will never work".
 *
 * - EPERM/EACCES: Windows rename-over-open-file; also AV holding a handle.
 * - EBUSY: file mapped or open by another process.
 * - ENOTEMPTY / EEXIST: Windows rename onto a directory-ish target, racy.
 * - EMFILE/ENFILE: descriptor exhaustion, transient under parallel applies.
 * - UNKNOWN: what libuv reports for several Win32 sharing-violation codes.
 */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
  'EEXIST',
  'EMFILE',
  'ENFILE',
  'UNKNOWN',
])

export function isRetryableError(err: unknown): boolean {
  const code = errnoCode(err)
  return code !== undefined && RETRYABLE_CODES.has(code)
}

export class AtomicWriteError extends Error {
  readonly path: string
  readonly attempts: number
  override readonly cause: unknown
  constructor(message: string, opts: { path: string; attempts: number; cause: unknown }) {
    super(message)
    this.name = 'AtomicWriteError'
    this.path = opts.path
    this.attempts = opts.attempts
    this.cause = opts.cause
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: 'full' | 'equal' | 'none'
  random?: () => number
}

/**
 * Delay before `attempt` (1-based: attempt 1 is the *first retry*, i.e. it
 * follows the initial failed try).
 *
 * Full jitter (`random() * capped`) rather than plain exponential: when a sync
 * writes twenty files and Defender stalls all of them, unjittered backoff makes
 * every retry collide again on the same schedule.
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const { baseDelayMs = 8, maxDelayMs = 512, jitter = 'full', random = Math.random } = options
  if (attempt < 1) return 0
  const exponential = baseDelayMs * 2 ** (attempt - 1)
  const capped = Math.min(exponential, maxDelayMs)
  switch (jitter) {
    case 'none':
      return Math.round(capped)
    case 'equal':
      return Math.round(capped / 2 + random() * (capped / 2))
    case 'full':
    default:
      return Math.round(random() * capped)
  }
}

export interface RetryInfo {
  attempt: number
  delayMs: number
  error: unknown
  operation: string
}

export interface RetryOptions extends BackoffOptions {
  /** Total attempts including the first. Default 10. */
  retries?: number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (info: RetryInfo) => void
  isRetryable?: (err: unknown) => boolean
  signal?: AbortSignal
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/** Run `fn`, retrying transient filesystem errors with jittered backoff. */
export async function withRetry<T>(
  operation: string,
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<{ value: T; attempts: number }> {
  const {
    retries = 10,
    sleep = defaultSleep,
    onRetry,
    isRetryable = isRetryableError,
    signal,
    ...backoff
  } = options

  const maxAttempts = Math.max(1, retries)
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted()
    try {
      const value = await fn(attempt)
      return { value, attempts: attempt }
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts || !isRetryable(err)) throw err
      const delayMs = computeBackoffDelay(attempt, backoff)
      onRetry?.({ attempt, delayMs, error: err, operation })
      await sleep(delayMs)
    }
  }

  throw lastError
}

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

export interface AtomicWriteOptions extends RetryOptions {
  /**
   * Mode for the resulting file. When omitted and the file already exists, the
   * existing mode is preserved (this is what keeps a 0600 credentials file at
   * 0600). When omitted and the file is new, 0o644.
   */
  mode?: number
  encoding?: BufferEncoding
  /** fsync the file before rename. Default true. Disable only for scratch data. */
  fsync?: boolean
  /**
   * fsync the containing directory after rename, so the rename itself survives
   * power loss. Default true on POSIX; always skipped on Windows (you cannot
   * open a directory for reading there).
   */
  fsyncDir?: boolean
  /** Create the parent directory if missing. Default true. */
  ensureDir?: boolean
  /**
   * Last-resort Windows path: after retries are exhausted, delete the
   * destination and rename into the gap. Breaks atomicity for a few
   * microseconds but beats failing the apply. Default true on Windows only.
   */
  unlinkFallbackOnWindows?: boolean
  /**
   * When the target is a symlink, write through it to its real path instead of
   * replacing the link. Default true.
   *
   * This matters a lot for this product's users: symlinking
   * `~/.claude/settings.json` into a dotfiles repo is a very common setup, and
   * `rename()` over a symlink replaces the *link*, silently detaching the file
   * from the repo. The user's next `git status` shows nothing and their next
   * `stow`/`chezmoi` run clobbers our write.
   */
  followSymlinks?: boolean
  /** Override for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  fs?: AtomicFsOps
  /** Temp file name generator; injected in tests for determinism. */
  tempName?: (target: string) => string
}

export interface AtomicWriteResult {
  /** Path actually written — the symlink's real path when one was followed. */
  path: string
  /** Set when `path` differs from the requested path because of a symlink. */
  followedSymlinkFrom?: string
  tmpPath: string
  bytesWritten: number
  /** Final mode applied (POSIX). `undefined` on Windows where it is meaningless. */
  mode: number | undefined
  /** True when the target already existed and its mode was carried over. */
  preservedMode: boolean
  writeAttempts: number
  renameAttempts: number
  usedUnlinkFallback: boolean
}

const DEFAULT_FILE_MODE = 0o644

function defaultTempName(target: string): string {
  // Same directory (rename must not cross a filesystem boundary), dot-prefixed
  // so a concurrent `readdir` of a config dir does not pick it up as an entry,
  // and random so two processes never pick the same temp.
  const dir = path.dirname(target)
  const base = path.basename(target)
  return path.join(dir, `.${base}.${process.pid.toString(36)}${randomBytes(6).toString('hex')}.tmp`)
}

async function statOrNull(fs: AtomicFsOps, p: string): Promise<StatLike | null> {
  try {
    return await fs.stat(p)
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null
    throw err
  }
}

/**
 * If `p` is a symlink, return what it really points at.
 *
 * `rename()` replaces a symlink rather than writing through it, so without
 * this a dotfiles-managed `~/.claude/settings.json` quietly stops being a link
 * the first time we write to it. A dangling link resolves to itself, which
 * makes the write replace the broken link — the only sensible outcome.
 */
async function resolveIfSymlink(fs: AtomicFsOps, p: string): Promise<string> {
  try {
    const st = await fs.lstat(p)
    if (!st.isSymbolicLink()) return p
    return path.resolve(await fs.realpath(p))
  } catch {
    // ENOENT (new file) or a dangling link: write to the requested path.
    return p
  }
}

async function quietUnlink(fs: AtomicFsOps, p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true })
  } catch {
    /* best effort — a leaked temp is not worth masking the real error */
  }
}

/**
 * fsync the directory so the rename is durable. Best effort: fails with EPERM
 * on macOS for some mounts, EINVAL on others, and is simply not a thing on
 * Windows. None of those are worth failing a write over.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle: import('node:fs/promises').FileHandle | undefined
  try {
    handle = await fsp.open(dir, 'r')
    await handle.sync()
  } catch {
    /* ignore */
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Write `contents` to `filePath` atomically.
 *
 * Failure guarantee: if this rejects, `filePath` holds either its previous
 * contents or (if it did not exist) still does not exist. The temp file is
 * always cleaned up.
 */
export async function atomicWriteFile(
  filePath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const {
    mode,
    encoding = 'utf8',
    fsync = true,
    fsyncDir = true,
    ensureDir = true,
    platform = process.platform,
    fs = nodeFsOps,
    tempName = defaultTempName,
    unlinkFallbackOnWindows,
    followSymlinks = true,
    ...retryOptions
  } = options

  const isWindows = platform === 'win32'
  const useUnlinkFallback = unlinkFallbackOnWindows ?? isWindows

  const requested = path.resolve(filePath)
  const target = followSymlinks ? await resolveIfSymlink(fs, requested) : requested
  const followedSymlinkFrom = target === requested ? undefined : requested
  const dir = path.dirname(target)
  const buffer = typeof contents === 'string' ? Buffer.from(contents, encoding) : Buffer.from(contents)

  if (ensureDir) await fs.mkdir(dir, { recursive: true })

  const existing = await statOrNull(fs, target)
  // Mode resolution. On Windows the POSIX mode bits are a fiction (libuv
  // synthesizes 0666/0444 from the read-only attribute), so we never chmod
  // there — doing so would clear the read-only flag or fail outright.
  const preservedMode = mode === undefined && existing !== null && !isWindows
  const effectiveMode = isWindows
    ? undefined
    : (mode ?? (existing !== null ? existing.mode & 0o7777 : DEFAULT_FILE_MODE))

  const tmpPath = tempName(target)
  let renameAttempts = 0
  let usedUnlinkFallback = false

  try {
    // --- write temp ------------------------------------------------------
    const { attempts: writeAttempts } = await withRetry(
      'write-temp',
      async () => {
        // 'wx' => fail if it somehow exists; we never reuse a temp name.
        const handle = await fs.open(tmpPath, 'wx', effectiveMode ?? DEFAULT_FILE_MODE)
        try {
          await handle.writeFile(buffer)
          // fsync before rename. Without it, ext4's delayed allocation can
          // leave a renamed-into-place file as zero bytes after a crash.
          if (fsync) await handle.sync()
        } finally {
          await handle.close()
        }
      },
      retryOptions,
    )

    // open()'s mode argument is masked by umask, so a 0600 request under
    // umask 0022 still yields 0600, but an explicit 0666 would yield 0644.
    // chmod is not masked — apply it unconditionally to get exactly what we asked for.
    if (effectiveMode !== undefined) {
      await fs.chmod(tmpPath, effectiveMode)
    }

    // --- rename into place ------------------------------------------------
    try {
      const { attempts } = await withRetry('rename', () => fs.rename(tmpPath, target), retryOptions)
      renameAttempts = attempts
    } catch (err) {
      if (!useUnlinkFallback || !isRetryableError(err)) throw err
      // Windows only, and only after backoff has failed: the destination is
      // being held open. Removing it first turns rename-over-existing into
      // rename-into-empty-slot, which succeeds against most AV handles.
      renameAttempts = (retryOptions.retries ?? 10) + 1
      await fs.rm(target, { force: true })
      await withRetry('rename-after-unlink', () => fs.rename(tmpPath, target), retryOptions)
      usedUnlinkFallback = true
    }

    if (fsyncDir && !isWindows && fs === nodeFsOps) await syncDirectory(dir)

    return {
      path: target,
      ...(followedSymlinkFrom !== undefined ? { followedSymlinkFrom } : {}),
      tmpPath,
      bytesWritten: buffer.byteLength,
      mode: effectiveMode,
      preservedMode,
      writeAttempts,
      renameAttempts,
      usedUnlinkFallback,
    }
  } catch (err) {
    await quietUnlink(fs, tmpPath)
    throw new AtomicWriteError(
      `atomic write of ${target} failed: ${err instanceof Error ? err.message : String(err)}`,
      { path: target, attempts: renameAttempts, cause: err },
    )
  }
}

/** Convenience: canonical-ish JSON write. Callers usually pass canonicalJson output. */
export async function atomicWriteJson(
  filePath: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  return atomicWriteFile(filePath, text, options)
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

/**
 * A rollback token. Deliberately a plain JSON-serializable record so it can be
 * persisted in a plan/apply journal and used by a *later* CLI invocation —
 * `rollback(rollbackId)` runs in a different process than `apply()` did.
 */
export interface BackupToken {
  v: 1
  id: string
  /** Absolute path of the file that was backed up. */
  path: string
  /** Absolute path of the backup copy. Absent when the original did not exist. */
  backupPath?: string
  /** False => "restore" means "delete the file we created". */
  existed: boolean
  mode?: number
  size?: number
  /** sha256 of the backed-up bytes; verified before restore. */
  sha256?: string
  createdAt: string
}

export interface WithBackupOptions {
  /**
   * Where backups live. Default: `<dirname(path)>/.agent-backups`.
   *
   * Same-volume by default and that is on purpose — a backup on another volume
   * cannot be restored by rename and may not carry the same permission model.
   * Production callers should pass the device state dir's backup root so the
   * user's `.claude/` does not accumulate sidecar directories.
   */
  backupRoot?: string
  fs?: AtomicFsOps
  platform?: NodeJS.Platform
  /** Injected in tests. */
  now?: () => Date
  id?: () => string
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Snapshot `filePath` and return a rollback token.
 *
 * Handles the "file does not exist yet" case explicitly: the token records
 * `existed: false`, and restoring it *deletes* the file. Without that, rolling
 * back a `create` leaves the created file behind.
 */
export async function withBackup(filePath: string, options: WithBackupOptions = {}): Promise<BackupToken> {
  const {
    fs = nodeFsOps,
    platform = process.platform,
    now = () => new Date(),
    id = () => randomBytes(8).toString('hex'),
  } = options

  const target = path.resolve(filePath)
  const backupRoot = options.backupRoot ?? path.join(path.dirname(target), '.agent-backups')
  const tokenId = id()
  const createdAt = now().toISOString()

  const existing = await statOrNull(fs, target)
  if (existing === null || !existing.isFile()) {
    return { v: 1, id: tokenId, path: target, existed: false, createdAt }
  }

  const bytes = await fs.readFile(target)
  await fs.mkdir(backupRoot, { recursive: true })
  const backupPath = path.join(backupRoot, `${path.basename(target)}.${tokenId}.bak`)

  const isWindows = platform === 'win32'
  const mode = existing.mode & 0o7777

  await atomicWriteFile(backupPath, bytes, {
    fs,
    platform,
    // The backup must not be more permissive than the original. A 0600
    // credentials file backed up at 0644 is a credential leak.
    ...(isWindows ? {} : { mode }),
    fsyncDir: false,
  })

  const token: BackupToken = {
    v: 1,
    id: tokenId,
    path: target,
    backupPath,
    existed: true,
    size: bytes.byteLength,
    sha256: sha256(bytes),
    createdAt,
  }
  if (!isWindows) token.mode = mode
  return token
}

export class RestoreError extends Error {
  readonly token: BackupToken
  constructor(message: string, token: BackupToken) {
    super(message)
    this.name = 'RestoreError'
    this.token = token
  }
}

/**
 * Roll back to the state captured by `token`.
 *
 * Verifies the backup's hash first: a corrupted or truncated backup must not
 * be written over a file that, however wrong, is at least intact.
 */
export async function restore(token: BackupToken, options: { fs?: AtomicFsOps; platform?: NodeJS.Platform } = {}): Promise<void> {
  const { fs = nodeFsOps, platform = process.platform } = options

  if (token.v !== 1) throw new RestoreError(`unsupported backup token version ${String(token.v)}`, token)

  if (!token.existed) {
    // Roll back a create by removing what we created.
    await fs.rm(token.path, { force: true })
    return
  }

  if (!token.backupPath) {
    throw new RestoreError('token claims the file existed but carries no backupPath', token)
  }

  let bytes: Buffer
  try {
    bytes = await fs.readFile(token.backupPath)
  } catch (err) {
    throw new RestoreError(
      `backup ${token.backupPath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      token,
    )
  }

  if (token.sha256 !== undefined && sha256(bytes) !== token.sha256) {
    throw new RestoreError(`backup ${token.backupPath} failed integrity check; refusing to restore`, token)
  }
  if (token.size !== undefined && bytes.byteLength !== token.size) {
    throw new RestoreError(`backup ${token.backupPath} has unexpected size; refusing to restore`, token)
  }

  await atomicWriteFile(token.path, bytes, {
    fs,
    platform,
    ...(token.mode !== undefined && platform !== 'win32' ? { mode: token.mode } : {}),
  })
}

/** Delete a backup after a successful, committed apply. */
export async function discardBackup(
  token: BackupToken,
  options: { fs?: AtomicFsOps } = {},
): Promise<void> {
  const { fs = nodeFsOps } = options
  if (token.backupPath) await quietUnlink(fs, token.backupPath)
}

/**
 * Run `fn` with `filePath` snapshotted; roll back on throw, discard on success.
 * This is the shape `ToolAdapter.apply()` wants for a single-file change.
 */
export async function withBackupTransaction<T>(
  filePath: string,
  fn: (token: BackupToken) => Promise<T>,
  options: WithBackupOptions = {},
): Promise<T> {
  const token = await withBackup(filePath, options)
  try {
    const result = await fn(token)
    await discardBackup(token, options.fs ? { fs: options.fs } : {})
    return result
  } catch (err) {
    await restore(token, {
      ...(options.fs ? { fs: options.fs } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Advisory file locking
// ---------------------------------------------------------------------------

/**
 * Serialize read-modify-write cycles over a single config file.
 *
 * WHAT THIS DOES AND DOES NOT SOLVE
 * ---------------------------------
 * `apply()` reads a file, computes an edit from those bytes, and writes the
 * result. Between the read and the write another writer can change the file,
 * and we would overwrite their change without noticing.
 *
 * On POSIX you CANNOT make read-modify-rename atomic against an arbitrary
 * external writer. `rename(2)` replaces the inode, so holding an fd on the file
 * you read does not stop someone else swapping a new one in underneath you, and
 * `flock` is advisory — the vendor tool writing its own settings.json has never
 * heard of our lock.
 *
 * So the honest split:
 *   - Against OUR OWN concurrent instances (two terminals, a daemon plus a
 *     manual `apply`) this lock is authoritative and the race is closed.
 *   - Against a FOREIGN writer (the editor you have open, Claude Code itself)
 *     it cannot help. That case is handled by re-verifying the file's content
 *     hash immediately before the rename, which narrows the window to the gap
 *     between the check and the syscall rather than the whole apply.
 *
 * Implementation is `open(…, 'wx')` — atomic create-if-absent on every platform
 * we target, and it does not need `flock`, which is unreliable over NFS and
 * behaves differently on Windows.
 */
export interface FileLockOptions {
  fs?: AtomicFsOps
  /** Give up after this long rather than blocking a CLI forever. */
  timeoutMs?: number
  /** A lock older than this is treated as abandoned by a crashed process. */
  staleMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Recorded in the lock file so a human can see who holds it. */
  holder?: string
}

export class FileLockError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'FileLockError'
  }
}

export const lockPathFor = (filePath: string): string => `${filePath}.agentsync-lock`

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const {
    fs = nodeFsOps,
    timeoutMs = 10_000,
    staleMs = 60_000,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    holder = `pid:${process.pid}`,
  } = options

  const lock = lockPathFor(filePath)
  const deadline = now() + timeoutMs
  let attempt = 0

  for (;;) {
    try {
      // 'wx' fails if the file exists — the atomic test-and-set.
      const handle = await fs.open(lock, 'wx', 0o600)
      try {
        await handle.writeFile(`${holder} ${new Date(now()).toISOString()}\n`)
      } finally {
        await handle.close()
      }
      break
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err

      // Someone holds it. Decide whether they are alive or crashed.
      let age = 0
      try {
        age = now() - (await fs.stat(lock)).mtimeMs
      } catch {
        continue // vanished between open and stat — retry immediately
      }

      if (age > staleMs) {
        // Abandoned. Break it, then loop round and re-acquire properly rather
        // than assuming the unlink won us the lock — two processes can both
        // reach this point and only one may proceed.
        await fs.unlink(lock).catch(() => {})
        continue
      }

      if (now() >= deadline)
        throw new FileLockError(
          lock,
          `timed out after ${timeoutMs}ms waiting for a lock on "${filePath}". ` +
            `Another agentsync process is writing it. If nothing else is running, ` +
            `delete "${lock}" and retry.`,
        )

      await sleep(computeBackoffDelay(attempt++, { baseDelayMs: 20, maxDelayMs: 250 }))
    }
  }

  try {
    return await fn()
  } finally {
    // Release even if fn threw. A leaked lock would block every later run until
    // it went stale, which is a far worse failure than the one we are guarding.
    await fs.unlink(lock).catch(() => {})
  }
}
