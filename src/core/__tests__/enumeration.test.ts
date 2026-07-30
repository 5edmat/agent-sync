/**
 * Tests for the enumeration floor.
 *
 * This is the single function bounding the blast radius of a backend
 * compromise, so these are adversarial by design: each case is an attempt to
 * reach `~/.ssh` (or equivalent) by a different route.
 */

import { describe, expect, it } from 'vitest'

import {
  canonicalizePath,
  evaluate,
  filterEntries,
  isWithin,
  matchesPattern,
  violatesFloor,
} from '../enumeration.js'
import { DEFAULT_ENUMERATION, NEVER_ENUMERATE, type EnumerationPolicy } from '../control-plane.js'
import type { HostEnv } from '../types.js'

const host = (over: Partial<HostEnv> = {}): HostEnv => ({
  os: 'macos',
  runtime: 'native',
  arch: 'arm64',
  home: '/Users/dev',
  supportsSymlinks: true,
  hasKeyring: true,
  supportsLongPaths: true,
  shell: 'zsh',
  deviceId: 'dev-1',
  ...over,
})

const policy = (over: Partial<EnumerationPolicy> = {}): EnumerationPolicy => ({
  ...DEFAULT_ENUMERATION,
  neverEnumerate: NEVER_ENUMERATE,
  ...over,
})

const DECLARED = ['/Users/dev/.claude', '/Users/dev/.agents', '/Users/dev/.cursor']
const deps = (realpathImpl?: (p: string) => Promise<string>) => ({
  declaredPaths: DECLARED,
  ...(realpathImpl ? { realpath: realpathImpl } : {}),
})

// ---------------------------------------------------------------------------

describe('path primitives', () => {
  it('isWithin is not a naive string prefix test', () => {
    // The classic bug: /home/u/.sshfoo "starts with" /home/u/.ssh
    expect(isWithin('/home/u/.ssh', '/home/u/.sshfoo')).toBe(false)
    expect(isWithin('/home/u/.ssh', '/home/u/.ssh/id_rsa')).toBe(true)
    expect(isWithin('/home/u/.ssh', '/home/u/.ssh')).toBe(true)
  })

  it('folds case on case-insensitive filesystems only', () => {
    expect(canonicalizePath('/Users/Dev/.SSH', host())).toBe('/users/dev/.ssh')
    // Linux is case-sensitive; folding there would deny legitimate paths.
    expect(canonicalizePath('/home/Dev/.SSH', host({ os: 'linux' }))).toBe('/home/Dev/.SSH')
  })

  it('** spans separators, * does not', () => {
    expect(matchesPattern('**/.env', '/a/b/c/.env')).toBe(true)
    expect(matchesPattern('/a/*/c', '/a/b/c')).toBe(true)
    expect(matchesPattern('/a/*/c', '/a/b/x/c')).toBe(false)
  })
})

describe('the floor — applies in every mode', () => {
  it.each([
    ['/Users/dev/.ssh', '~/.ssh'],
    ['/Users/dev/.ssh/id_rsa', '~/.ssh'],
    ['/Users/dev/.aws/credentials', '~/.aws'],
    ['/Users/dev/.gnupg/secring.gpg', '~/.gnupg'],
    ['/Users/dev/.kube/config', '~/.kube'],
    ['/Users/dev/Library/Keychains/login.keychain', '~/Library/Keychains'],
  ])('denies %s', (path) => {
    expect(violatesFloor(path, policy(), host()).allowed).toBe(false)
  })

  it('denies protected patterns anywhere in the tree', () => {
    for (const p of [
      '/Users/dev/work/project/.env',
      '/Users/dev/work/project/.env.production',
      '/Users/dev/anywhere/id_ed25519',
      '/Users/dev/certs/server.pem',
    ])
      expect(violatesFloor(p, policy(), host()).allowed).toBe(false)
  })

  it('allows ordinary config paths', () => {
    for (const p of ['/Users/dev/.claude/settings.json', '/Users/dev/.agents/skills'])
      expect(violatesFloor(p, policy(), host()).allowed).toBe(true)
  })

  it('gives a reason a human can act on', () => {
    const v = violatesFloor('/Users/dev/.ssh/id_rsa', policy(), host())
    expect(v.reason).toMatch(/credentials/)
    expect(v.matchedRule).toBe('~/.ssh')
  })

  it('CANNOT be disabled by full mode', () => {
    const v = violatesFloor('/Users/dev/.ssh', policy({ mode: 'full' }), host())
    expect(v.allowed).toBe(false)
  })
})

describe('evaluate — attack routes', () => {
  it('blocks a direct request', async () => {
    const v = await evaluate('/Users/dev/.ssh', policy({ mode: 'full', fullModeAcknowledgedAt: 'x' }), host(), deps())
    expect(v.allowed).toBe(false)
  })

  it('blocks traversal that normalizes into a denied root', async () => {
    const v = await evaluate(
      '/Users/dev/Documents/../.ssh/id_rsa',
      policy({ mode: 'full', fullModeAcknowledgedAt: 'x' }),
      host(),
      deps(async (p) => p),
    )
    expect(v.allowed).toBe(false)
  })

  it('blocks a SYMLINK escape into a denied root', async () => {
    // ~/harmless -> ~/.ssh. A name-only check would wave this straight through,
    // which is why realpath resolution happens before the floor.
    const v = await evaluate(
      '/Users/dev/harmless',
      policy({ mode: 'full', fullModeAcknowledgedAt: 'x' }),
      host(),
      deps(async (p) => (p === '/Users/dev/harmless' ? '/Users/dev/.ssh' : p)),
    )
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/\.ssh/)
  })

  it('blocks case variants on case-insensitive hosts', async () => {
    const v = await evaluate('/Users/dev/.SSH', policy({ mode: 'full', fullModeAcknowledgedAt: 'x' }), host(), deps())
    expect(v.allowed).toBe(false)
  })

  it('still denies a protected path that does not exist yet', async () => {
    // realpath throws for missing paths; we must judge the literal form rather
    // than failing open.
    const v = await evaluate(
      '/Users/dev/.ssh/id_rsa',
      policy({ mode: 'full', fullModeAcknowledgedAt: 'x' }),
      host(),
      deps(async () => {
        throw new Error('ENOENT')
      }),
    )
    expect(v.allowed).toBe(false)
  })

  it('rejects relative paths rather than guessing a base', async () => {
    const v = await evaluate('../../.ssh', policy(), host(), deps())
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/absolute/)
  })
})

describe('evaluate — modes', () => {
  it('declared mode allows only adapter paths', async () => {
    expect((await evaluate('/Users/dev/.claude/settings.json', policy(), host(), deps())).allowed).toBe(true)
    expect((await evaluate('/Users/dev/projects/app', policy(), host(), deps())).allowed).toBe(false)
  })

  it('declared-plus-user honours user roots', async () => {
    const p = policy({ mode: 'declared-plus-user', userAddedRoots: ['/Users/dev/dotfiles'] })
    expect((await evaluate('/Users/dev/dotfiles/claude', p, host(), deps())).allowed).toBe(true)
    expect((await evaluate('/Users/dev/other', p, host(), deps())).allowed).toBe(false)
  })

  it('a user-added root CANNOT re-open a denied path', async () => {
    // Even explicitly adding ~/.ssh as a root does not grant access.
    const p = policy({ mode: 'declared-plus-user', userAddedRoots: ['/Users/dev/.ssh'] })
    expect((await evaluate('/Users/dev/.ssh/id_rsa', p, host(), deps())).allowed).toBe(false)
  })

  it('full mode requires explicit on-device acknowledgement', async () => {
    const unack = policy({ mode: 'full' })
    expect((await evaluate('/Users/dev/projects', unack, host(), deps())).allowed).toBe(false)

    const ack = policy({ mode: 'full', fullModeAcknowledgedAt: '2026-07-29T00:00:00Z' })
    expect((await evaluate('/Users/dev/projects', ack, host(), deps())).allowed).toBe(true)
  })
})

describe('filterEntries', () => {
  it('hides protected entries when listing an allowed parent', () => {
    // Listing ~ is legitimate. Returning .ssh as a browsable entry is not.
    const { visible, hidden } = filterEntries(
      '/Users/dev',
      ['.claude', '.agents', '.ssh', '.aws', 'projects', '.npmrc'],
      policy(),
      host(),
    )
    expect(visible).toEqual(['.claude', '.agents', 'projects'])
    expect(hidden).toEqual(['.ssh', '.aws', '.npmrc'])
  })
})

describe('windows', () => {
  const win = host({
    os: 'windows',
    home: 'C:/Users/dev',
    appData: 'C:/Users/dev/AppData/Roaming',
  })

  it('denies protected roots with backslash separators', () => {
    expect(violatesFloor('C:\\Users\\dev\\.ssh\\id_rsa', policy(), win).allowed).toBe(false)
  })

  it('denies .env patterns on windows paths', () => {
    expect(violatesFloor('C:\\Users\\dev\\proj\\.env', policy(), win).allowed).toBe(false)
  })
})
