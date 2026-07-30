import { describe, expect, it } from 'vitest'
import {
  checkPathLength,
  detectCaseCollisions,
  isWindowsReservedName,
  suggestPortableName,
  validatePathSet,
  validatePortablePath,
  WINDOWS_RESERVED_NAMES,
  type PathIssueCode,
} from '../paths.js'
import type { HostPathSlice } from '../paths.js'

const WINDOWS: HostPathSlice = { os: 'windows', supportsLongPaths: false }
const WINDOWS_LONG: HostPathSlice = { os: 'windows', supportsLongPaths: true }
const LINUX: HostPathSlice = { os: 'linux', supportsLongPaths: true }
const MACOS: HostPathSlice = { os: 'macos', supportsLongPaths: true }

const codes = (p: string, opts?: Parameters<typeof validatePortablePath>[1]): PathIssueCode[] =>
  validatePortablePath(p, opts).issues.map((i) => i.code)

const errorCodes = (p: string, opts?: Parameters<typeof validatePortablePath>[1]): PathIssueCode[] =>
  validatePortablePath(p, opts).errors.map((i) => i.code)

// ---------------------------------------------------------------------------

describe('isWindowsReservedName', () => {
  it('flags every documented device name', () => {
    for (const name of WINDOWS_RESERVED_NAMES) {
      expect(isWindowsReservedName(name), name).toBe(true)
    }
    expect(WINDOWS_RESERVED_NAMES).toContain('COM1')
    expect(WINDOWS_RESERVED_NAMES).toContain('COM9')
    expect(WINDOWS_RESERVED_NAMES).toContain('LPT1')
    expect(WINDOWS_RESERVED_NAMES).toContain('LPT9')
  })

  it('is case-insensitive', () => {
    expect(isWindowsReservedName('con')).toBe(true)
    expect(isWindowsReservedName('CoN')).toBe(true)
    expect(isWindowsReservedName('nul')).toBe(true)
    expect(isWindowsReservedName('lpt3')).toBe(true)
  })

  it('stays reserved with any extension', () => {
    // This is the one people get wrong: `aux.md` is just as unopenable as `aux`.
    expect(isWindowsReservedName('aux.md')).toBe(true)
    expect(isWindowsReservedName('CON.txt')).toBe(true)
    expect(isWindowsReservedName('com1.tar.gz')).toBe(true)
    expect(isWindowsReservedName('PRN.json')).toBe(true)
  })

  it('stays reserved with trailing dots or spaces, which Win32 strips first', () => {
    expect(isWindowsReservedName('CON.')).toBe(true)
    expect(isWindowsReservedName('CON ')).toBe(true)
    expect(isWindowsReservedName('nul...  ')).toBe(true)
  })

  it('folds the superscript digits Windows maps onto COM1-3', () => {
    expect(isWindowsReservedName('COM\u00b9')).toBe(true)
    expect(isWindowsReservedName('LPT\u00b2')).toBe(true)
  })

  it('does not flag names that merely start with a device name', () => {
    expect(isWindowsReservedName('console.txt')).toBe(false)
    expect(isWindowsReservedName('connection')).toBe(false)
    expect(isWindowsReservedName('auxiliary')).toBe(false)
    expect(isWindowsReservedName('nullable.ts')).toBe(false)
    expect(isWindowsReservedName('com')).toBe(false)
  })

  it('does not flag COM0/LPT0, which are not reserved', () => {
    expect(isWindowsReservedName('COM0')).toBe(false)
    expect(isWindowsReservedName('LPT0')).toBe(false)
    expect(isWindowsReservedName('COM10')).toBe(false)
  })

  it('ignores empty input', () => {
    expect(isWindowsReservedName('')).toBe(false)
  })
})

describe('validatePortablePath: reserved names', () => {
  it('rejects a reserved segment anywhere in the path', () => {
    expect(errorCodes('skills/aux/SKILL.md')).toContain('reserved-name')
    expect(errorCodes('skills/nul.md')).toContain('reserved-name')
    expect(errorCodes('con')).toContain('reserved-name')
  })

  it('applies the rule by default even without a host', () => {
    // No host means "must work everywhere", which is the authoring case.
    expect(validatePortablePath('skills/con.md').ok).toBe(false)
  })

  it('skips the rule when the target host is explicitly POSIX', () => {
    expect(validatePortablePath('skills/con.md', { host: LINUX }).ok).toBe(true)
    expect(validatePortablePath('skills/con.md', { host: MACOS }).ok).toBe(true)
  })
})

describe('validatePortablePath: trailing dots and spaces', () => {
  it('rejects a trailing dot', () => {
    expect(errorCodes('notes.')).toContain('trailing-dot')
    expect(errorCodes('dir./file.md')).toContain('trailing-dot')
  })

  it('rejects a trailing space', () => {
    expect(errorCodes('notes ')).toContain('trailing-space')
    expect(errorCodes('my dir /file.md')).toContain('trailing-space')
  })

  it('warns but does not fail on a leading space', () => {
    const r = validatePortablePath(' leading/file.md')
    expect(r.warnings.map((w) => w.code)).toContain('leading-space')
    expect(r.errors.map((e) => e.code)).not.toContain('leading-space')
  })

  it('accepts interior dots and spaces', () => {
    expect(validatePortablePath('my notes/v1.2.3/file.md').ok).toBe(true)
  })
})

describe('validatePortablePath: illegal characters', () => {
  it.each(['<', '>', ':', '"', '|', '?', '*'])('rejects %s', (ch) => {
    expect(errorCodes(`skills/a${ch}b.md`)).toContain('illegal-char')
  })

  it('rejects control characters even on POSIX hosts', () => {
    // A newline in a filename is legal on ext4 and a nightmare everywhere else.
    expect(errorCodes('skills/a\nb.md', { host: LINUX })).toContain('control-char')
    expect(errorCodes('skills/a\u0007b.md', { host: LINUX })).toContain('control-char')
  })

  it('names the offending characters in the message', () => {
    const r = validatePortablePath('a:b?c.md')
    const issue = r.errors.find((e) => e.code === 'illegal-char')
    expect(issue?.message).toContain(':')
    expect(issue?.message).toContain('?')
  })

  it('allows characters that are legal everywhere', () => {
    expect(validatePortablePath('skills/my-skill_v2/SKILL.md').ok).toBe(true)
    expect(validatePortablePath('agents/code-reviewer.md').ok).toBe(true)
  })
})

describe('validatePortablePath: shape', () => {
  it('rejects empty input', () => {
    expect(errorCodes('')).toEqual(['empty'])
  })

  it('rejects absolute paths', () => {
    expect(errorCodes('/etc/passwd')).toContain('absolute')
  })

  it('rejects drive letters', () => {
    expect(errorCodes('C:/Users/x', { allowBackslashSeparator: true })).toContain('drive-letter')
  })

  it('rejects UNC paths', () => {
    expect(errorCodes('//server/share/x', { allowBackslashSeparator: true })).toContain('unc-path')
  })

  it('rejects backslashes unless explicitly allowed as separators', () => {
    expect(errorCodes('skills\\foo')).toContain('backslash-separator')
    expect(validatePortablePath('skills\\foo', { allowBackslashSeparator: true }).ok).toBe(true)
  })

  it('rejects traversal', () => {
    expect(errorCodes('../../etc/passwd')).toContain('traversal')
    expect(errorCodes('skills/../../../secrets')).toContain('traversal')
  })

  it('rejects empty interior segments', () => {
    expect(errorCodes('skills//foo')).toContain('empty-segment')
  })

  it('tolerates a single trailing slash and normalizes it away', () => {
    const r = validatePortablePath('skills/foo/')
    expect(r.ok).toBe(true)
    expect(r.normalized).toBe('skills/foo')
  })

  it('rejects a `.` segment unless allowed', () => {
    expect(errorCodes('./skills/foo')).toContain('dot-segment')
    expect(validatePortablePath('./skills/foo', { allowDotSegments: true }).ok).toBe(true)
  })

  it('rejects an over-long segment', () => {
    expect(errorCodes(`skills/${'a'.repeat(256)}`)).toContain('segment-too-long')
    // 255 is the limit everywhere (NTFS, ext4, APFS). It still trips MAX_PATH
    // against the default strict host, so assert on the segment rule alone.
    expect(errorCodes(`skills/${'a'.repeat(255)}`)).not.toContain('segment-too-long')
    expect(validatePortablePath(`skills/${'a'.repeat(255)}`, { host: LINUX }).ok).toBe(true)
  })

  it('warns when the path is not NFC', () => {
    const nfd = 'skills/cafe\u0301.md' // e + combining acute
    expect(codes(nfd)).toContain('non-nfc')
    expect(validatePortablePath(nfd).normalized).toBe('skills/caf\u00e9.md')
  })

  it('collects every problem rather than stopping at the first', () => {
    const r = validatePortablePath('con/ba:d/x.')
    const found = new Set(r.errors.map((e) => e.code))
    expect(found.has('reserved-name')).toBe(true)
    expect(found.has('illegal-char')).toBe(true)
    expect(found.has('trailing-dot')).toBe(true)
  })
})

describe('checkPathLength / MAX_PATH', () => {
  const deepRoot = 'C:\\Users\\alexandra.chen-mcdonald\\AppData\\Roaming\\Claude\\projects'

  it('rejects a path that exceeds MAX_PATH when long paths are off', () => {
    const rel = `skills/${'nested/'.repeat(30)}SKILL.md`
    const issue = checkPathLength(rel, { host: WINDOWS, root: deepRoot })
    expect(issue?.code).toBe('path-too-long')
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toMatch(/MAX_PATH/)
  })

  it('downgrades to a warning when long paths are enabled', () => {
    const rel = `skills/${'nested/'.repeat(30)}SKILL.md`
    const issue = checkPathLength(rel, { host: WINDOWS_LONG, root: deepRoot })
    expect(issue?.severity).toBe('warning')
  })

  it('does not apply on POSIX hosts', () => {
    const rel = `skills/${'nested/'.repeat(60)}SKILL.md`
    expect(checkPathLength(rel, { host: LINUX, root: '/home/a' })).toBeNull()
    expect(checkPathLength(rel, { host: MACOS, root: '/Users/a' })).toBeNull()
  })

  it('assumes the strictest target when no host is given', () => {
    const rel = 'x'.repeat(300)
    expect(checkPathLength(rel)?.severity).toBe('error')
  })

  it('measures the joined path, not the relative path alone', () => {
    // 200-char rel is fine on its own and fatal under a 100-char root.
    const rel = 'a'.repeat(200)
    expect(checkPathLength(rel, { host: WINDOWS })).toBeNull()
    expect(checkPathLength(rel, { host: WINDOWS, root: `C:\\${'r'.repeat(96)}` })?.code).toBe('path-too-long')
  })

  it('sits exactly on the 259-character boundary', () => {
    const root = 'C:\\r'
    // root(4) + sep(1) = 5 consumed
    expect(checkPathLength('a'.repeat(254), { host: WINDOWS, root })).toBeNull()
    expect(checkPathLength('a'.repeat(255), { host: WINDOWS, root })?.code).toBe('path-too-long')
  })

  it('surfaces through validatePortablePath', () => {
    const r = validatePortablePath('a'.repeat(250), { host: WINDOWS, root: 'C:\\Users\\someone' })
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('path-too-long')
  })
})

describe('detectCaseCollisions', () => {
  it('detects a directory-level collision between distinct full paths', () => {
    // The case a whole-path lowercase comparison misses: the *files* differ,
    // but `Foo/` and `foo/` are one directory on APFS and NTFS.
    const collisions = detectCaseCollisions(['Foo/a.md', 'foo/b.md'])
    expect(collisions).toHaveLength(1)
    expect(collisions[0]?.key).toBe('foo')
    expect(collisions[0]?.variants.sort()).toEqual(['Foo', 'foo'])
    expect(collisions[0]?.reason).toBe('case')
    expect(collisions[0]?.paths.sort()).toEqual(['Foo/a.md', 'foo/b.md'])
  })

  it('detects a file-level collision', () => {
    const collisions = detectCaseCollisions(['skills/README.md', 'skills/readme.md'])
    expect(collisions).toHaveLength(1)
    expect(collisions[0]?.key).toBe('skills/readme.md')
  })

  it('detects collisions nested several levels deep', () => {
    const collisions = detectCaseCollisions(['a/b/Skills/x.md', 'a/b/skills/y.md'])
    expect(collisions.map((c) => c.key)).toEqual(['a/b/skills'])
  })

  it('reports one collision per colliding node, not per path pair', () => {
    const collisions = detectCaseCollisions(['Foo/a.md', 'foo/b.md', 'FOO/c.md'])
    expect(collisions).toHaveLength(1)
    expect(collisions[0]?.variants.sort()).toEqual(['FOO', 'Foo', 'foo'])
    expect(collisions[0]?.paths).toHaveLength(3)
  })

  it('does not fire on identical or repeated paths', () => {
    expect(detectCaseCollisions(['a/b.md', 'a/b.md', 'a/c.md'])).toEqual([])
  })

  it('does not fire on genuinely different names', () => {
    expect(detectCaseCollisions(['skills/alpha', 'skills/beta', 'agents/alpha'])).toEqual([])
  })

  it('distinguishes a Unicode-normalization collision from a case collision', () => {
    const nfc = 'caf\u00e9/a.md'
    const nfd = 'cafe\u0301/b.md'
    const collisions = detectCaseCollisions([nfc, nfd])
    expect(collisions).toHaveLength(1)
    expect(collisions[0]?.reason).toBe('unicode')
  })

  it('handles backslash-separated input', () => {
    expect(detectCaseCollisions(['Foo\\a.md', 'foo/b.md'])).toHaveLength(1)
  })

  it('ignores leading ./ and empty segments', () => {
    expect(detectCaseCollisions(['./a/b.md', 'a//b.md'])).toEqual([])
  })

  it('detects a collision between a directory and a file of the same folded name', () => {
    const collisions = detectCaseCollisions(['Skills', 'skills/x.md'])
    expect(collisions).toHaveLength(1)
    expect(collisions[0]?.key).toBe('skills')
  })
})

describe('validatePathSet', () => {
  it('aggregates per-path errors and cross-path collisions', () => {
    const r = validatePathSet(['skills/con.md', 'Foo/a.md', 'foo/b.md', 'skills/ok.md'])
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('reserved device name'))).toBe(true)
    expect(r.errors.some((e) => e.includes('case collision'))).toBe(true)
    expect(r.perPath.get('skills/ok.md')?.ok).toBe(true)
  })

  it('passes a clean set', () => {
    const r = validatePathSet(['skills/alpha/SKILL.md', 'agents/reviewer.md', 'commands/deploy.md'])
    expect(r.ok).toBe(true)
    expect(r.collisions).toEqual([])
  })
})

describe('suggestPortableName', () => {
  it('replaces illegal characters', () => {
    expect(suggestPortableName('a:b*c?')).toBe('a-b-c-')
  })

  it('strips trailing dots and spaces', () => {
    expect(suggestPortableName('notes. ')).toBe('notes')
  })

  it('disambiguates reserved names', () => {
    expect(suggestPortableName('CON')).toBe('CON_')
    expect(suggestPortableName('aux.md')).toBe('aux.md_')
  })

  it('never returns an empty name', () => {
    expect(suggestPortableName('...')).toBe('unnamed')
  })

  it('produces a name that passes validation', () => {
    for (const bad of ['CON', 'a:b', 'notes.', 'x ', '<>|']) {
      expect(validatePortablePath(suggestPortableName(bad)).ok, bad).toBe(true)
    }
  })
})
