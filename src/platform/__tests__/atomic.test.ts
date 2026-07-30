import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AtomicWriteError,
  atomicWriteFile,
  computeBackoffDelay,
  discardBackup,
  isRetryableError,
  nodeFsOps,
  restore,
  RestoreError,
  withBackup,
  withBackupTransaction,
  withRetry,
  type AtomicFsOps,
  type BackupToken,
} from '../atomic.js'

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-test-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const read = (p: string): Promise<string> => fsp.readFile(p, 'utf8')
const modeOf = async (p: string): Promise<number> => (await fsp.stat(p)).mode & 0o777

/** Errors shaped like libuv's. */
function errno(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  return err
}

/** No-op sleep so retry tests do not actually wait. */
const noSleep = async (): Promise<void> => {}

const listTemps = async (d: string): Promise<string[]> =>
  (await fsp.readdir(d)).filter((f) => f.endsWith('.tmp'))

// ---------------------------------------------------------------------------

describe('computeBackoffDelay', () => {
  it('grows exponentially without jitter', () => {
    const opts = { baseDelayMs: 10, maxDelayMs: 10_000, jitter: 'none' as const }
    expect(computeBackoffDelay(1, opts)).toBe(10)
    expect(computeBackoffDelay(2, opts)).toBe(20)
    expect(computeBackoffDelay(3, opts)).toBe(40)
    expect(computeBackoffDelay(4, opts)).toBe(80)
  })

  it('caps at maxDelayMs', () => {
    const opts = { baseDelayMs: 10, maxDelayMs: 50, jitter: 'none' as const }
    expect(computeBackoffDelay(10, opts)).toBe(50)
    expect(computeBackoffDelay(100, opts)).toBe(50)
  })

  it('full jitter spreads uniformly across [0, capped]', () => {
    const opts = { baseDelayMs: 10, maxDelayMs: 1000, jitter: 'full' as const }
    expect(computeBackoffDelay(4, { ...opts, random: () => 0 })).toBe(0)
    expect(computeBackoffDelay(4, { ...opts, random: () => 1 })).toBe(80)
    expect(computeBackoffDelay(4, { ...opts, random: () => 0.5 })).toBe(40)
  })

  it('equal jitter keeps at least half the delay', () => {
    const opts = { baseDelayMs: 10, maxDelayMs: 1000, jitter: 'equal' as const }
    expect(computeBackoffDelay(4, { ...opts, random: () => 0 })).toBe(40)
    expect(computeBackoffDelay(4, { ...opts, random: () => 1 })).toBe(80)
  })

  it('never exceeds the cap for any random draw', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffDelay(20, { baseDelayMs: 8, maxDelayMs: 512 })
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(512)
    }
  })

  it('returns 0 for a non-positive attempt', () => {
    expect(computeBackoffDelay(0)).toBe(0)
    expect(computeBackoffDelay(-5)).toBe(0)
  })

  it('de-synchronizes concurrent writers', () => {
    // Twenty files stalled by the same AV scan must not all retry in lockstep.
    const draws = new Set(
      Array.from({ length: 20 }, () => computeBackoffDelay(6, { baseDelayMs: 8, maxDelayMs: 512 })),
    )
    expect(draws.size).toBeGreaterThan(10)
  })
})

describe('isRetryableError', () => {
  it('treats the Windows file-lock family as retryable', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST', 'UNKNOWN']) {
      expect(isRetryableError(errno(code)), code).toBe(true)
    }
  })

  it('does not retry errors that will never resolve', () => {
    for (const code of ['ENOENT', 'ENOSPC', 'EROFS', 'EISDIR', 'ENAMETOOLONG']) {
      expect(isRetryableError(errno(code)), code).toBe(false)
    }
    expect(isRetryableError(new Error('plain'))).toBe(false)
    expect(isRetryableError(null)).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn(async () => 'ok')
    const r = await withRetry('op', fn, { sleep: noSleep })
    expect(r).toEqual({ value: 'ok', attempts: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a transient error and reports the attempt count', async () => {
    let calls = 0
    const r = await withRetry(
      'op',
      async () => {
        calls++
        if (calls < 4) throw errno('EPERM')
        return 'ok'
      },
      { sleep: noSleep, retries: 10 },
    )
    expect(r.attempts).toBe(4)
    expect(calls).toBe(4)
  })

  it('does not retry a permanent error', async () => {
    let calls = 0
    await expect(
      withRetry(
        'op',
        async () => {
          calls++
          throw errno('ENOSPC')
        },
        { sleep: noSleep, retries: 5 },
      ),
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(calls).toBe(1)
  })

  it('gives up after `retries` attempts and rethrows the last error', async () => {
    let calls = 0
    await expect(
      withRetry(
        'op',
        async () => {
          calls++
          throw errno('EBUSY')
        },
        { sleep: noSleep, retries: 3 },
      ),
    ).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(3)
  })

  it('reports each retry with a delay', async () => {
    const seen: number[] = []
    let calls = 0
    await withRetry(
      'rename',
      async () => {
        calls++
        if (calls < 3) throw errno('EPERM')
      },
      {
        sleep: noSleep,
        jitter: 'none',
        baseDelayMs: 4,
        onRetry: (info) => seen.push(info.delayMs),
      },
    )
    expect(seen).toEqual([4, 8])
  })

  it('honors an abort signal', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(withRetry('op', async () => 'x', { signal: ctrl.signal })).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------

describe('atomicWriteFile: basics', () => {
  it('writes a new file and creates missing parents', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'settings.json')
    const r = await atomicWriteFile(target, '{"a":1}\n')
    expect(await read(target)).toBe('{"a":1}\n')
    expect(r.bytesWritten).toBe(8)
    expect(r.writeAttempts).toBe(1)
    expect(r.renameAttempts).toBe(1)
  })

  it('replaces existing contents completely (no tail of the old file)', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'a'.repeat(5000))
    await atomicWriteFile(target, 'short')
    expect(await read(target)).toBe('short')
  })

  it('accepts a Buffer', async () => {
    const target = path.join(dir, 'bin')
    await atomicWriteFile(target, Buffer.from([1, 2, 3]))
    expect(await fsp.readFile(target)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('leaves no temp files behind on success', async () => {
    await atomicWriteFile(path.join(dir, 'f'), 'x')
    expect(await listTemps(dir)).toEqual([])
  })

  it('writes the temp file in the target directory (rename must not cross volumes)', async () => {
    const target = path.join(dir, 'f')
    const r = await atomicWriteFile(target, 'x')
    expect(path.dirname(r.tmpPath)).toBe(path.dirname(path.resolve(target)))
  })

  it('is safe under concurrent writers: the file is always one full version', async () => {
    const target = path.join(dir, 'race.json')
    const payloads = Array.from({ length: 12 }, (_, i) => `${'v'.repeat(200)}-${i}\n`)
    await Promise.all(payloads.map((p) => atomicWriteFile(target, p)))
    const final = await read(target)
    expect(payloads).toContain(final)
    expect(await listTemps(dir)).toEqual([])
  })
})

describe('atomicWriteFile: symlinked config files (dotfiles repos)', () => {
  it.skipIf(process.platform === 'win32')('writes through the link instead of replacing it', async () => {
    // The common setup: ~/.claude/settings.json -> ~/dotfiles/claude/settings.json
    const repo = path.join(dir, 'dotfiles')
    await fsp.mkdir(repo, { recursive: true })
    const real = path.join(repo, 'settings.json')
    await fsp.writeFile(real, '{"v":1}')

    const link = path.join(dir, 'settings.json')
    await fsp.symlink(real, link)

    const r = await atomicWriteFile(link, '{"v":2}')

    // The link must survive; the repo file must be the thing that changed.
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await read(real)).toBe('{"v":2}')
    // realpath resolves intermediate links too — on macOS os.tmpdir() is
    // /var/folders/..., itself a link to /private/var/folders/...
    expect(r.path).toBe(await fsp.realpath(real))
    expect(r.followedSymlinkFrom).toBe(link)
  })

  it.skipIf(process.platform === 'win32')('follows a relative symlink', async () => {
    const repo = path.join(dir, 'dotfiles')
    await fsp.mkdir(repo, { recursive: true })
    await fsp.writeFile(path.join(repo, 'settings.json'), 'old')
    const link = path.join(dir, 'settings.json')
    await fsp.symlink('dotfiles/settings.json', link)

    await atomicWriteFile(link, 'new')
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await read(path.join(repo, 'settings.json'))).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('replaces the link when asked not to follow', async () => {
    const real = path.join(dir, 'real.json')
    await fsp.writeFile(real, 'old')
    const link = path.join(dir, 'link.json')
    await fsp.symlink(real, link)

    await atomicWriteFile(link, 'new', { followSymlinks: false })
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(false)
    expect(await read(real)).toBe('old')
  })

  it.skipIf(process.platform === 'win32')('replaces a dangling link rather than failing', async () => {
    const link = path.join(dir, 'link.json')
    await fsp.symlink(path.join(dir, 'gone.json'), link)
    const r = await atomicWriteFile(link, 'new')
    expect(r.followedSymlinkFrom).toBeUndefined()
    expect(await read(link)).toBe('new')
  })

  it.skipIf(process.platform === 'win32')('preserves the target file mode through the link', async () => {
    const real = path.join(dir, '.credentials.json')
    await fsp.writeFile(real, 'secret')
    await fsp.chmod(real, 0o600)
    const link = path.join(dir, 'link.json')
    await fsp.symlink(real, link)

    await atomicWriteFile(link, 'new secret')
    expect(await modeOf(real)).toBe(0o600)
  })
})

describe('atomicWriteFile: permission preservation', () => {
  it.skipIf(process.platform === 'win32')('keeps a 0600 credentials file at 0600', async () => {
    const target = path.join(dir, '.credentials.json')
    await fsp.writeFile(target, '{"token":"old"}', { mode: 0o600 })
    await fsp.chmod(target, 0o600)

    const r = await atomicWriteFile(target, '{"token":"new"}')

    expect(await modeOf(target)).toBe(0o600)
    expect(r.preservedMode).toBe(true)
    expect(r.mode! & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('preserves an unusual mode such as 0640', async () => {
    const target = path.join(dir, 'g.json')
    await fsp.writeFile(target, 'x')
    await fsp.chmod(target, 0o640)
    await atomicWriteFile(target, 'y')
    expect(await modeOf(target)).toBe(0o640)
  })

  it.skipIf(process.platform === 'win32')('honors an explicit mode despite umask', async () => {
    // open(mode) is masked by umask; only the follow-up chmod gets us exactly
    // what was asked for. With umask 022 a naive implementation yields 0644.
    const target = path.join(dir, 'explicit')
    await atomicWriteFile(target, 'x', { mode: 0o666 })
    expect(await modeOf(target)).toBe(0o666)
  })

  it.skipIf(process.platform === 'win32')('defaults a brand-new file to 0644', async () => {
    const target = path.join(dir, 'new')
    await atomicWriteFile(target, 'x')
    expect(await modeOf(target)).toBe(0o644)
  })

  it.skipIf(process.platform === 'win32')('an explicit mode wins over the existing one', async () => {
    const target = path.join(dir, 'h')
    await fsp.writeFile(target, 'x')
    await fsp.chmod(target, 0o600)
    await atomicWriteFile(target, 'y', { mode: 0o644 })
    expect(await modeOf(target)).toBe(0o644)
  })

  it('reports no mode on Windows, where POSIX bits are synthesized', async () => {
    const target = path.join(dir, 'win.json')
    const r = await atomicWriteFile(target, 'x', { platform: 'win32', fsyncDir: false })
    expect(r.mode).toBeUndefined()
    expect(r.preservedMode).toBe(false)
  })
})

describe('atomicWriteFile: failure never leaves a partial file', () => {
  it('keeps the original contents when the rename fails permanently', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'ORIGINAL')

    const fs: AtomicFsOps = {
      ...nodeFsOps,
      rename: async () => {
        throw errno('EROFS', 'read-only file system')
      },
    }

    await expect(atomicWriteFile(target, 'NEW', { fs, sleep: noSleep })).rejects.toBeInstanceOf(
      AtomicWriteError,
    )
    expect(await read(target)).toBe('ORIGINAL')
    expect(await listTemps(dir)).toEqual([])
  })

  it('does not create the file at all when the write fails', async () => {
    const target = path.join(dir, 'never.json')
    const fs: AtomicFsOps = {
      ...nodeFsOps,
      open: async () => {
        throw errno('ENOSPC', 'no space left on device')
      },
    }
    await expect(atomicWriteFile(target, 'x', { fs, sleep: noSleep })).rejects.toBeInstanceOf(
      AtomicWriteError,
    )
    await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans up the temp file when retries are exhausted', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'ORIGINAL')
    const fs: AtomicFsOps = {
      ...nodeFsOps,
      rename: async () => {
        throw errno('EPERM')
      },
    }
    await expect(
      atomicWriteFile(target, 'NEW', { fs, sleep: noSleep, retries: 3, unlinkFallbackOnWindows: false }),
    ).rejects.toBeInstanceOf(AtomicWriteError)
    expect(await read(target)).toBe('ORIGINAL')
    expect(await listTemps(dir)).toEqual([])
  })

  it('preserves the underlying error as `cause`', async () => {
    const fs: AtomicFsOps = {
      ...nodeFsOps,
      rename: async () => {
        throw errno('EROFS')
      },
    }
    const err = await atomicWriteFile(path.join(dir, 'f'), 'x', { fs, sleep: noSleep }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AtomicWriteError)
    expect((err as AtomicWriteError).cause).toMatchObject({ code: 'EROFS' })
  })
})

describe('atomicWriteFile: Windows transient-lock behavior', () => {
  it('succeeds once the antivirus lock clears', async () => {
    const target = path.join(dir, 'settings.json')
    await fsp.writeFile(target, 'OLD')

    let renameCalls = 0
    const delays: number[] = []
    const fs: AtomicFsOps = {
      ...nodeFsOps,
      rename: async (from, to) => {
        renameCalls++
        // Defender holds the handle for the first three attempts.
        if (renameCalls <= 3) throw errno('EPERM', 'operation not permitted')
        return nodeFsOps.rename(from, to)
      },
    }

    const r = await atomicWriteFile(target, 'NEW', {
      fs,
      platform: 'win32',
      retries: 10,
      jitter: 'none',
      baseDelayMs: 1,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })

    expect(await read(target)).toBe('NEW')
    expect(r.renameAttempts).toBe(4)
    expect(r.usedUnlinkFallback).toBe(false)
    expect(delays).toEqual([1, 2, 4]) // exponential, one per failed attempt
  })

  it('falls back to unlink+rename when the destination stays locked', async () => {
    const target = path.join(dir, 'settings.json')
    await fsp.writeFile(target, 'OLD')

    let destRemoved = false
    const fs: AtomicFsOps = {
      ...nodeFsOps,
      // Models MoveFileEx refusing to replace an existing, open destination
      // while happily renaming into an empty slot.
      rename: async (from, to) => {
        if (!destRemoved) throw errno('EPERM', 'rename over existing file')
        return nodeFsOps.rename(from, to)
      },
      rm: async (p, opts) => {
        if (path.resolve(p) === path.resolve(target)) destRemoved = true
        return nodeFsOps.rm(p, opts)
      },
    }

    const r = await atomicWriteFile(target, 'NEW', {
      fs,
      platform: 'win32',
      retries: 3,
      sleep: noSleep,
    })

    expect(r.usedUnlinkFallback).toBe(true)
    expect(await read(target)).toBe('NEW')
  })

  it('does not use the unlink fallback on POSIX', async () => {
    const target = path.join(dir, 'f')
    await fsp.writeFile(target, 'OLD')
    const fs: AtomicFsOps = {
      ...nodeFsOps,
      rename: async () => {
        throw errno('EPERM')
      },
    }
    await expect(
      atomicWriteFile(target, 'NEW', { fs, platform: 'linux', retries: 2, sleep: noSleep }),
    ).rejects.toBeInstanceOf(AtomicWriteError)
    expect(await read(target)).toBe('OLD')
  })
})

// ---------------------------------------------------------------------------

describe('withBackup / restore', () => {
  it('round-trips a modified file', async () => {
    const target = path.join(dir, 'settings.json')
    await fsp.writeFile(target, '{"v":1}')

    const token = await withBackup(target)
    expect(token.existed).toBe(true)
    expect(token.sha256).toMatch(/^[0-9a-f]{64}$/)

    await atomicWriteFile(target, '{"v":2}')
    expect(await read(target)).toBe('{"v":2}')

    await restore(token)
    expect(await read(target)).toBe('{"v":1}')
  })

  it('is JSON-serializable so a later process can roll back', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'A')
    const token = await withBackup(target)
    await atomicWriteFile(target, 'B')

    // Exactly what a rollback journal on disk would do.
    const revived = JSON.parse(JSON.stringify(token)) as BackupToken
    await restore(revived)
    expect(await read(target)).toBe('A')
  })

  it('records non-existence and rolls back a create by deleting', async () => {
    const target = path.join(dir, 'brand-new.json')
    const token = await withBackup(target)
    expect(token.existed).toBe(false)
    expect(token.backupPath).toBeUndefined()

    await atomicWriteFile(target, 'created')
    expect(await read(target)).toBe('created')

    await restore(token)
    await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restoring a never-existed token twice is idempotent', async () => {
    const token = await withBackup(path.join(dir, 'nope.json'))
    await restore(token)
    await expect(restore(token)).resolves.toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('never widens permissions on the backup copy', async () => {
    const target = path.join(dir, '.credentials.json')
    await fsp.writeFile(target, 'secret')
    await fsp.chmod(target, 0o600)

    const token = await withBackup(target)
    expect(token.mode! & 0o777).toBe(0o600)
    // A 0644 backup of a 0600 credentials file is a credential leak.
    expect(await modeOf(token.backupPath!)).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('restores the original mode', async () => {
    const target = path.join(dir, 'creds')
    await fsp.writeFile(target, 'secret')
    await fsp.chmod(target, 0o600)
    const token = await withBackup(target)

    await fsp.rm(target)
    await atomicWriteFile(target, 'other', { mode: 0o644 })
    expect(await modeOf(target)).toBe(0o644)

    await restore(token)
    expect(await modeOf(target)).toBe(0o600)
    expect(await read(target)).toBe('secret')
  })

  it('refuses to restore a corrupted backup', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'GOOD')
    const token = await withBackup(target)

    await fsp.writeFile(token.backupPath!, 'CORRUPTED-BY-DISK-ERROR')
    await atomicWriteFile(target, 'CURRENT')

    await expect(restore(token)).rejects.toBeInstanceOf(RestoreError)
    // The intact-but-wrong current file is better than a corrupted restore.
    expect(await read(target)).toBe('CURRENT')
  })

  it('reports a missing backup file clearly', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'A')
    const token = await withBackup(target)
    await fsp.rm(token.backupPath!)
    await expect(restore(token)).rejects.toThrow(/unreadable/)
  })

  it('rejects an unknown token version', async () => {
    const bad = { v: 2, id: 'x', path: path.join(dir, 'f'), existed: false, createdAt: '' }
    await expect(restore(bad as unknown as BackupToken)).rejects.toThrow(/unsupported backup token version/)
  })

  it('honors a custom backup root', async () => {
    const target = path.join(dir, 'f.json')
    const backupRoot = path.join(dir, 'state', 'backups')
    await fsp.writeFile(target, 'A')
    const token = await withBackup(target, { backupRoot })
    expect(token.backupPath!.startsWith(backupRoot)).toBe(true)
  })

  it('discardBackup removes the copy', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'A')
    const token = await withBackup(target)
    await discardBackup(token)
    await expect(fsp.stat(token.backupPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('withBackupTransaction', () => {
  it('commits on success and discards the backup', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'A')
    const token = await withBackupTransaction(target, async (t) => {
      await atomicWriteFile(target, 'B')
      return t
    })
    expect(await read(target)).toBe('B')
    await expect(fsp.stat(token.backupPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back when the body throws mid-write', async () => {
    const target = path.join(dir, 'f.json')
    await fsp.writeFile(target, 'A')
    await expect(
      withBackupTransaction(target, async () => {
        await atomicWriteFile(target, 'PARTIALLY-APPLIED')
        throw new Error('apply failed halfway through')
      }),
    ).rejects.toThrow('apply failed halfway through')
    expect(await read(target)).toBe('A')
  })

  it('rolls back a create by deleting the file', async () => {
    const target = path.join(dir, 'new.json')
    await expect(
      withBackupTransaction(target, async () => {
        await atomicWriteFile(target, 'created')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(fsp.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
