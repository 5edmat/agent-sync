import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HostEnv } from '../../core/types.js'
import {
  materialize,
  MaterializeError,
  nodeLinkOps,
  planStrategies,
  readLinkTarget,
  relativeLinkTarget,
  resolveLinkTarget,
  stripWindowsExtendedPrefix,
  type LinkOps,
} from '../links.js'

type HostSlice = Pick<HostEnv, 'os' | 'supportsSymlinks'>

const MACOS: HostSlice = { os: 'macos', supportsSymlinks: true }
const LINUX: HostSlice = { os: 'linux', supportsSymlinks: true }
const WIN_DEVMODE: HostSlice = { os: 'windows', supportsSymlinks: true }
const WIN_LOCKED: HostSlice = { os: 'windows', supportsSymlinks: false }

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'links-test-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

/**
 * An absolute fixture path in the *running host's* flavour.
 *
 * `resolveLinkTarget` and `relativeLinkTarget` are `node:path` functions by
 * design: they interpret targets read out of the local filesystem, so they must
 * speak the local OS's rules. Feeding them `/Users/x/...` on Windows is not a
 * Windows path — `path.resolve` stamps the process's current drive onto it and
 * returns `C:\Users\x\...`, so the expectation, not the function, is what is
 * wrong. These fixtures keep the *shape* every assertion is about (a link four
 * levels down pointing two levels up) while letting each OS spell it its own
 * way. Evaluated at module load, i.e. before any test chdirs, so the drive is
 * fixed once and the comparisons stay stable.
 */
const abs = (...segments: string[]): string => path.resolve(path.sep, ...segments)

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

/** Windows without Developer Mode: CreateSymbolicLink fails, junctions work. */
function windowsOps(opts: { junctionsWork: boolean }): {
  ops: LinkOps
  junctionCalls: Array<{ target: string; link: string }>
} {
  const junctionCalls: Array<{ target: string; link: string }> = []
  const ops: LinkOps = {
    ...nodeLinkOps,
    symlink: async (target, linkPath, type) => {
      if (type === 'junction') {
        if (!opts.junctionsWork) throw errno('EPERM')
        junctionCalls.push({ target, link: linkPath })
        // POSIX ignores the type argument, so this stands in for the junction.
        return nodeLinkOps.symlink(target, linkPath)
      }
      throw errno('EPERM') // no Developer Mode, no SeCreateSymbolicLinkPrivilege
    },
  }
  return { ops, junctionCalls }
}

/**
 * `LinkInfo.raw` is deliberately the OS's own answer — exactly what `readlink`
 * handed back, un-rewritten, because that is the string a user sees in `ls -l`
 * and the one we must not silently launder. Windows stores relative symlink
 * targets with backslashes, so `raw` is `..\..\.agents\skills\foo` there even
 * when the link was created from a `/`-separated string.
 *
 * What these assertions are about is *which* target was recorded, not how the
 * volume spells a separator, so compare in one flavour. The guarantee that we
 * ourselves always WRITE portable `/` targets is a different claim and is
 * asserted at full strength where we control the value — see `materialize`'s
 * `linkTarget` expectations below, which stay exact on every OS.
 */
const asPosix = (raw: string | null): string | null => (raw === null ? null : raw.split(/[\\/]/).join('/'))

const mkTree = async (root: string): Promise<void> => {
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(root, 'SKILL.md'), '# skill\n')
  await fsp.writeFile(path.join(root, 'sub', 'a.txt'), 'aaa')
  await fsp.writeFile(path.join(root, 'sub', 'b.txt'), 'bb')
}

// ---------------------------------------------------------------------------

describe('stripWindowsExtendedPrefix', () => {
  it('strips the \\\\?\\ device prefix', () => {
    expect(stripWindowsExtendedPrefix('\\\\?\\C:\\Users\\a\\.claude')).toBe('C:\\Users\\a\\.claude')
  })

  it('rewrites the UNC form back to a normal UNC path', () => {
    expect(stripWindowsExtendedPrefix('\\\\?\\UNC\\server\\share\\x')).toBe('\\\\server\\share\\x')
  })

  it('leaves ordinary paths alone', () => {
    expect(stripWindowsExtendedPrefix('../../.agents/skills/foo')).toBe('../../.agents/skills/foo')
    expect(stripWindowsExtendedPrefix('C:\\x')).toBe('C:\\x')
  })
})

describe('resolveLinkTarget', () => {
  it('resolves a relative target against the link directory, not the cwd', () => {
    // The real Claude Code layout. Resolving against process.cwd() — which is
    // wherever the user ran the CLI — silently produces a bogus path.
    const link = abs('Users', 'x', '.claude', 'skills', 'foo')
    expect(resolveLinkTarget(link, '../../.agents/skills/foo')).toBe(
      abs('Users', 'x', '.agents', 'skills', 'foo'),
    )
  })

  it('handles a sibling relative target', () => {
    expect(resolveLinkTarget(abs('a', 'b', 'link'), 'target')).toBe(abs('a', 'b', 'target'))
    expect(resolveLinkTarget(abs('a', 'b', 'link'), './target')).toBe(abs('a', 'b', 'target'))
  })

  it('passes absolute targets through, normalized', () => {
    // Built by hand rather than with path.join so the `..` survives into the
    // argument — normalizing it away here would test nothing.
    const unnormalized = `${path.sep}x${path.sep}y${path.sep}..${path.sep}z`
    expect(resolveLinkTarget(abs('a', 'b', 'link'), unnormalized)).toBe(path.join(path.sep, 'x', 'z'))
  })

  it('handles a Windows extended-length target', () => {
    // Absolute in win32 terms on every OS, so this one case is spelled the same
    // way everywhere: it is specifically about the \\?\ prefix.
    expect(resolveLinkTarget(abs('a', 'link'), '\\\\?\\C:\\Users\\a\\skills')).toBe('C:\\Users\\a\\skills')
  })

  it('does not depend on the process cwd', () => {
    const link = abs('a', 'b', 'link')
    const expected = abs('a', 'c')
    const before = resolveLinkTarget(link, '../c')
    const prev = process.cwd()
    try {
      // On Windows this can also change the current DRIVE, which is exactly the
      // kind of hidden dependency the assertion is guarding against.
      process.chdir(os.tmpdir())
      expect(resolveLinkTarget(link, '../c')).toBe(before)
      expect(before).toBe(expected)
    } finally {
      process.chdir(prev)
    }
  })
})

describe('relativeLinkTarget', () => {
  it('produces the ../../ form Claude Code uses', () => {
    expect(
      relativeLinkTarget(abs('Users', 'x', '.claude', 'skills', 'foo'), abs('Users', 'x', '.agents', 'skills', 'foo')),
    ).toBe('../../.agents/skills/foo')
  })

  it('always uses forward slashes so the value is portable', () => {
    expect(relativeLinkTarget(abs('a', 'b', 'c', 'link'), abs('a', 'b', 'target'))).toBe('../target')
    expect(relativeLinkTarget(abs('a', 'b', 'c', 'link'), abs('a', 'b', 'target'))).not.toContain('\\')
  })

  it('round-trips with resolveLinkTarget', () => {
    const link = abs('Users', 'x', '.claude', 'skills', 'foo')
    const target = abs('Users', 'x', '.agents', 'skills', 'foo')
    expect(resolveLinkTarget(link, relativeLinkTarget(link, target))).toBe(target)
  })
})

describe('planStrategies', () => {
  it('prefers symlinks wherever they work', () => {
    expect(planStrategies(MACOS, 'dir')).toEqual(['symlink', 'copy'])
    expect(planStrategies(LINUX, 'file')).toEqual(['symlink', 'copy'])
    expect(planStrategies(WIN_DEVMODE, 'dir')).toEqual(['symlink', 'junction', 'copy'])
  })

  it('falls back to a junction for directories on locked-down Windows', () => {
    expect(planStrategies(WIN_LOCKED, 'dir')).toEqual(['junction', 'copy'])
  })

  it('has only copy for files on locked-down Windows (junctions are dir-only)', () => {
    expect(planStrategies(WIN_LOCKED, 'file')).toEqual(['copy'])
  })

  it('never offers a junction on POSIX', () => {
    expect(planStrategies({ os: 'linux', supportsSymlinks: false }, 'dir')).toEqual(['copy'])
  })

  it('respects an allow-list', () => {
    expect(planStrategies(MACOS, 'dir', ['copy'])).toEqual(['copy'])
  })
})

// ---------------------------------------------------------------------------

describe('readLinkTarget', () => {
  it('reads a relative link and resolves it correctly', async () => {
    // Reproduce the real layout: .claude/skills/foo -> ../../.agents/skills/foo
    const agents = path.join(dir, '.agents', 'skills', 'foo')
    const claudeSkills = path.join(dir, '.claude', 'skills')
    await fsp.mkdir(agents, { recursive: true })
    await fsp.mkdir(claudeSkills, { recursive: true })
    const link = path.join(claudeSkills, 'foo')
    await fsp.symlink('../../.agents/skills/foo', link)

    const info = await readLinkTarget(link)
    expect(info.isLink).toBe(true)
    expect(info.kind).toBe('symlink')
    expect(asPosix(info.raw)).toBe('../../.agents/skills/foo')
    expect(info.isRelative).toBe(true)
    expect(info.resolved).toBe(agents)
    expect(info.targetExists).toBe(true)
  })

  it('resolves correctly regardless of the process cwd', async () => {
    const agents = path.join(dir, '.agents', 'skills', 'foo')
    const claudeSkills = path.join(dir, '.claude', 'skills')
    await fsp.mkdir(agents, { recursive: true })
    await fsp.mkdir(claudeSkills, { recursive: true })
    const link = path.join(claudeSkills, 'foo')
    await fsp.symlink('../../.agents/skills/foo', link)

    const prev = process.cwd()
    try {
      process.chdir(os.homedir())
      const info = await readLinkTarget(link)
      expect(info.resolved).toBe(agents)
      expect(info.targetExists).toBe(true)
    } finally {
      process.chdir(prev)
    }
  })

  it('reports a dangling link as a link with a missing target', async () => {
    const link = path.join(dir, 'dangling')
    await fsp.symlink('../nowhere/at/all', link)
    const info = await readLinkTarget(link)
    expect(info.isLink).toBe(true)
    expect(info.targetExists).toBe(false)
    expect(asPosix(info.raw)).toBe('../nowhere/at/all')
  })

  it('reports a regular file as not a link', async () => {
    const p = path.join(dir, 'plain.md')
    await fsp.writeFile(p, 'x')
    const info = await readLinkTarget(p)
    expect(info).toMatchObject({ isLink: false, kind: 'none', raw: null, resolved: null })
  })

  it('reports a missing path as not a link instead of throwing', async () => {
    const info = await readLinkTarget(path.join(dir, 'absent'))
    expect(info.isLink).toBe(false)
  })

  it('marks an absolute target as non-relative', async () => {
    const target = path.join(dir, 'target')
    await fsp.writeFile(target, 'x')
    const link = path.join(dir, 'abslink')
    await fsp.symlink(target, link)
    const info = await readLinkTarget(link)
    expect(info.isRelative).toBe(false)
    expect(info.resolved).toBe(target)
  })
})

// ---------------------------------------------------------------------------

describe('materialize on POSIX', () => {
  it('symlinks a directory with a relative target by default', async () => {
    const src = path.join(dir, '.agents', 'skills', 'foo')
    const dest = path.join(dir, '.claude', 'skills', 'foo')
    await mkTree(src)

    const r = await materialize(src, dest, MACOS)

    expect(r.strategy).toBe('symlink')
    expect(r.degraded).toBe(false)
    expect(r.kind).toBe('dir')
    expect(r.linkTarget).toBe('../../.agents/skills/foo')
    expect(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# skill\n')
  })

  it('can store an absolute target when asked', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    const r = await materialize(src, dest, MACOS, { linkTarget: 'absolute' })
    expect(r.linkTarget).toBe(src)
  })

  it('symlinks a single file', async () => {
    const src = path.join(dir, 'agents', 'reviewer.md')
    const dest = path.join(dir, '.claude', 'agents', 'reviewer.md')
    await fsp.mkdir(path.dirname(src), { recursive: true })
    await fsp.writeFile(src, 'agent')

    const r = await materialize(src, dest, MACOS)
    expect(r.strategy).toBe('symlink')
    expect(r.kind).toBe('file')
    expect(await fsp.readFile(dest, 'utf8')).toBe('agent')
  })

  it('propagates later edits through the link', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    await materialize(src, dest, MACOS)
    await fsp.writeFile(path.join(src, 'SKILL.md'), 'EDITED')
    expect(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('EDITED')
  })

  it('is idempotent and does not rewrite an already-correct link', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    await materialize(src, dest, MACOS)

    const second = await materialize(src, dest, MACOS)
    expect(second.unchanged).toBe(true)
    expect(second.attempts).toEqual([])
  })

  it('repoints a link that aims at the wrong target', async () => {
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    const dest = path.join(dir, 'dest')
    await mkTree(a)
    await mkTree(b)
    await fsp.writeFile(path.join(b, 'SKILL.md'), 'FROM-B')

    await materialize(a, dest, MACOS)
    const r = await materialize(b, dest, MACOS)
    expect(r.unchanged).toBe(false)
    expect(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('FROM-B')
  })

  it('replaces a real directory sitting at the destination', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    await fsp.mkdir(dest, { recursive: true })
    await fsp.writeFile(path.join(dest, 'stale.md'), 'stale')

    const r = await materialize(src, dest, MACOS)
    expect(r.strategy).toBe('symlink')
    await expect(fsp.stat(path.join(dest, 'stale.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a clear error when the destination exists and overwrite is off', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    await fsp.writeFile(dest, 'in the way')

    const err = await materialize(src, dest, MACOS, { overwrite: false }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MaterializeError)
    expect((err as Error).message).toMatch(/already exists and overwrite is disabled/)
    expect(await fsp.readFile(dest, 'utf8')).toBe('in the way')
  })

  it('still creates the link when overwrite is off and nothing is in the way', async () => {
    const src = path.join(dir, 'src')
    await mkTree(src)
    const r = await materialize(src, path.join(dir, 'dest'), MACOS, { overwrite: false })
    expect(r.strategy).toBe('symlink')
  })

  it('throws when the source does not exist', async () => {
    await expect(materialize(path.join(dir, 'nope'), path.join(dir, 'd'), MACOS)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('materialize on Windows without Developer Mode', () => {
  it('falls back from symlink to a directory junction', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    const { ops, junctionCalls } = windowsOps({ junctionsWork: true })

    const r = await materialize(src, dest, WIN_LOCKED, { ops })

    expect(r.strategy).toBe('junction')
    // A junction still behaves like a link, so this is not a functional loss.
    expect(r.degraded).toBe(false)
    // Junction targets MUST be absolute; a relative one resolves against the
    // volume root rather than the link's directory.
    expect(junctionCalls).toHaveLength(1)
    expect(junctionCalls[0]?.target).toBe(src)
    expect(path.isAbsolute(junctionCalls[0]!.target)).toBe(true)
    expect(r.linkTarget).toBe(src)
  })

  it('tries symlink first when Developer Mode is on', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    const r = await materialize(src, dest, WIN_DEVMODE, { ops: nodeLinkOps })
    expect(r.strategy).toBe('symlink')
    expect(r.attempts.map((a) => a.strategy)).toEqual(['symlink'])
  })

  it('falls all the way back to a real recursive copy', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    const { ops } = windowsOps({ junctionsWork: false })

    const r = await materialize(src, dest, WIN_LOCKED, { ops })

    expect(r.strategy).toBe('copy')
    // A copy stops tracking the source; the caller must tell the user.
    expect(r.degraded).toBe(true)
    expect(r.attempts.map((a) => `${a.strategy}:${a.ok ? 'ok' : (a.errorCode ?? 'err')}`)).toEqual([
      'junction:EPERM',
      'copy:ok',
    ])
    expect(r.filesCopied).toBe(3)
    expect(r.bytesCopied).toBe('# skill\n'.length + 3 + 2)

    expect(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# skill\n')
    expect(await fsp.readFile(path.join(dest, 'sub', 'b.txt'), 'utf8')).toBe('bb')
  })

  it('copies a single file when no link mechanism is available', async () => {
    const src = path.join(dir, 'a.md')
    const dest = path.join(dir, 'out', 'a.md')
    await fsp.writeFile(src, 'contents')
    const { ops } = windowsOps({ junctionsWork: false })

    const r = await materialize(src, dest, WIN_LOCKED, { ops })
    expect(r.strategy).toBe('copy')
    expect(r.attempts.map((a) => a.strategy)).toEqual(['copy'])
    expect(await fsp.readFile(dest, 'utf8')).toBe('contents')
  })

  it('a copy is a snapshot: later source edits do NOT propagate', async () => {
    const src = path.join(dir, 'src')
    const dest = path.join(dir, 'dest')
    await mkTree(src)
    const { ops } = windowsOps({ junctionsWork: false })
    await materialize(src, dest, WIN_LOCKED, { ops })

    await fsp.writeFile(path.join(src, 'SKILL.md'), 'EDITED')
    expect(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# skill\n')
  })

  it('dereferences inner symlinks when the host cannot recreate them', async () => {
    const src = path.join(dir, 'src')
    await mkTree(src)
    await fsp.symlink('SKILL.md', path.join(src, 'alias.md'))
    const dest = path.join(dir, 'dest')
    const { ops } = windowsOps({ junctionsWork: false })

    await materialize(src, dest, WIN_LOCKED, { ops })
    const copied = path.join(dest, 'alias.md')
    expect((await fsp.lstat(copied)).isSymbolicLink()).toBe(false)
    expect(await fsp.readFile(copied, 'utf8')).toBe('# skill\n')
  })

  it('reports every failed attempt when nothing works', async () => {
    const src = path.join(dir, 'src')
    await mkTree(src)
    const ops: LinkOps = {
      ...nodeLinkOps,
      symlink: async () => {
        throw errno('EPERM')
      },
      copyFile: async () => {
        throw errno('EACCES')
      },
    }
    const err = await materialize(src, path.join(dir, 'dest'), WIN_LOCKED, { ops }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(MaterializeError)
    expect((err as MaterializeError).attempts.map((a) => a.strategy)).toEqual(['junction', 'copy'])
    expect((err as MaterializeError).attempts.every((a) => !a.ok)).toBe(true)
  })

  it('can be forced onto the copy path for testing', async () => {
    const src = path.join(dir, 'src')
    await mkTree(src)
    const r = await materialize(src, path.join(dir, 'dest'), MACOS, { allow: ['copy'] })
    expect(r.strategy).toBe('copy')
  })
})
