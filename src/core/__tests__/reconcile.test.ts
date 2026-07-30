/**
 * Tests for the reconcile engine — rule matching, layering, merge semantics,
 * and plan construction.
 *
 * This file is the most load-bearing in the product: every client must compute
 * identical plans from identical inputs, or "preview before apply" is theatre.
 * Several cases below encode security properties, not just behavior.
 */

import { describe, expect, it } from 'vitest'

import {
  ROOT_PATH,
  buildPlan,
  classifyRisk,
  deepEqual,
  fingerprint,
  flatten,
  getPath,
  globMatch,
  mergeValue,
  resolve,
  ruleFor,
  setPath,
  stricter,
  validateLayer,
} from '../reconcile.js'
import type { ConfigDoc, HostEnv, KeyRule } from '../types.js'

const host = (over: Partial<HostEnv> = {}): HostEnv => ({
  os: 'macos',
  runtime: 'native',
  arch: 'arm64',
  home: '/home/t',
  supportsSymlinks: true,
  hasKeyring: true,
  supportsLongPaths: true,
  shell: 'zsh',
  deviceId: 'dev-1',
  ...over,
})

// ---------------------------------------------------------------------------

describe('globMatch', () => {
  it('matches literals and single-segment wildcards', () => {
    expect(globMatch('a.b', 'a.b')).toBe(true)
    expect(globMatch('a.*', 'a.b')).toBe(true)
    expect(globMatch('a.*', 'a.b.c')).toBe(false)
  })

  it('matches the remainder with **', () => {
    expect(globMatch('a.**', 'a.b.c.d')).toBe(true)
    expect(globMatch('**', 'anything.at.all')).toBe(true)
  })

  it('supports partial-segment wildcards', () => {
    expect(globMatch('env.*_TOKEN', 'env.GITHUB_TOKEN')).toBe(true)
    expect(globMatch('env.*_TOKEN', 'env.GITHUB_KEY')).toBe(false)
    expect(globMatch('*Cache', 'modelAccessCache')).toBe(true)
  })
})

describe('ruleFor', () => {
  const rules: KeyRule[] = [
    { match: '**', portability: 'portable', merge: 'deep-merge' },
    { match: 'env.*_TOKEN', portability: 'never-sync', merge: 'never', secret: true },
    { match: 'permissions.allow', portability: 'portable', merge: 'union-list' },
  ]

  it('prefers the most specific rule over the catch-all', () => {
    expect(ruleFor(rules, 'env.GITHUB_TOKEN').merge).toBe('never')
    expect(ruleFor(rules, 'permissions.allow').merge).toBe('union-list')
    expect(ruleFor(rules, 'anything.else').merge).toBe('deep-merge')
  })

  it('a rule governs its whole subtree', () => {
    // flatten() yields leaf paths, so a rule on an object-valued key must cover
    // its children. Without this, never-sync on `oauthAccount` never fired for
    // `oauthAccount.emailAddress` and identity was classified portable.
    const r = [
      { match: '**', portability: 'portable', merge: 'deep-merge' },
      { match: 'oauthAccount', portability: 'never-sync', merge: 'never' },
    ] satisfies KeyRule[]
    expect(ruleFor(r, 'oauthAccount.emailAddress').portability).toBe('never-sync')
  })

  it('a partial-segment rule beats the ** fallback', () => {
    // `*Cache` and `**` have equal literal-segment and length scores; only
    // literal-character weight separates them.
    const r = [
      { match: '**', portability: 'portable', merge: 'deep-merge' },
      { match: '*Cache', portability: 'never-sync', merge: 'never' },
    ] satisfies KeyRule[]
    expect(ruleFor(r, 'modelAccessCache.entry').portability).toBe('never-sync')
  })

  it('throws when no rule matches, rather than guessing', () => {
    expect(() => ruleFor([{ match: 'a', portability: 'portable', merge: 'replace' }], 'z')).toThrow(
      /no rule matched/,
    )
  })
})

describe('flatten / getPath / setPath', () => {
  it('treats arrays as leaves, never indexing by position', () => {
    expect(flatten({ a: [1, 2, 3] })).toEqual([['a', [1, 2, 3]]])
  })

  it('REGRESSION: an array-rooted document is a leaf at the root', () => {
    // This returned [] before, so array-rooted files (Zed keymap.json,
    // tasks.json — the latter a list of shell commands) produced zero changes
    // and reported success while syncing nothing.
    expect(flatten([{ shell: 'echo' }])).toEqual([[ROOT_PATH, [{ shell: 'echo' }]]])
  })

  it('ignores undefined rather than inventing a root leaf', () => {
    expect(flatten(undefined)).toEqual([])
  })

  it('getPath returns the whole document for the root path', () => {
    const doc = [1, 2]
    expect(getPath(doc, ROOT_PATH)).toBe(doc)
  })

  it('setPath refuses to write the root instead of corrupting it', () => {
    expect(() => setPath({}, ROOT_PATH, 1)).toThrow(/cannot write the document root/)
  })

  it('creates intermediate objects on write', () => {
    const o: Record<string, unknown> = {}
    setPath(o, 'a.b.c', 1)
    expect(o).toEqual({ a: { b: { c: 1 } } })
  })
})

describe('mergeValue', () => {
  it('union-list dedupes and is order-insensitive', () => {
    // Correct for permission rules, which MERGE across scopes rather than
    // override. 'replace' here would silently drop rules a user still relies on.
    expect(mergeValue(['a', 'b'], ['b', 'c'], 'union-list')).toEqual(['a', 'b', 'c'])
  })

  it('concat preserves order and duplicates (hook chains)', () => {
    expect(mergeValue(['a'], ['a', 'b'], 'concat')).toEqual(['a', 'a', 'b'])
  })

  it('never returns the current value untouched', () => {
    expect(mergeValue('keep', 'discard', 'never')).toBe('keep')
  })

  it('throws when most-restrictive has no declared direction', () => {
    // Guessing would let two clients rank the same pair differently, so a
    // previewed plan would not be the plan that runs — and on a security key
    // the wrong guess silently weakens a sandbox.
    expect(() => mergeValue('a', 'b', 'most-restrictive')).toThrow(/requires a strictness/)
  })
})

describe('stricter', () => {
  it('handles boolean directions', () => {
    expect(stricter(false, true, 'true-is-stricter')).toBe(true)
    expect(stricter(true, false, 'false-is-stricter')).toBe(false)
  })

  it('handles numeric ceilings and floors', () => {
    expect(stricter(30, 10, 'lower-is-stricter')).toBe(10)
    expect(stricter(8, 16, 'higher-is-stricter')).toBe(16)
  })

  it('intersects allowlists and unions denylists', () => {
    expect(stricter(['a', 'b'], ['b', 'c'], 'intersection')).toEqual(['b'])
    expect(stricter(['a'], ['b'], 'union')).toEqual(['a', 'b'])
  })

  describe('ordinal', () => {
    const perm = { kind: 'ordinal' as const, order: ['allow', 'confirm', 'deny'] }

    it('keeps the stricter member regardless of argument order', () => {
      expect(stricter('allow', 'deny', perm)).toBe('deny')
      expect(stricter('deny', 'allow', perm)).toBe('deny')
      expect(stricter('confirm', 'allow', perm)).toBe('confirm')
    })

    it('SECURITY: a lower layer cannot downgrade deny to allow', () => {
      expect(mergeValue('deny', 'allow', 'most-restrictive', perm)).toBe('deny')
    })

    it('treats an unknown member as strictest rather than loosening', () => {
      // If a tool adds a permission level we have never seen, refusing to
      // loosen is the safe default.
      expect(stricter('quarantine', 'allow', perm)).toBe('quarantine')
    })
  })
})

describe('resolve — layering', () => {
  const rules: KeyRule[] = [
    { match: 'permissions.allow', portability: 'portable', merge: 'union-list' },
    { match: '**', portability: 'portable', merge: 'deep-merge' },
  ]

  it('later layers win, and union keys accumulate', () => {
    const { value } = resolve(
      [
        { id: 'base', data: { model: 'sonnet', permissions: { allow: ['Bash(ls)'] } } },
        { id: 'machine:dev-1', data: { model: 'opus', permissions: { allow: ['Bash(git)'] } } },
      ],
      rules,
      host(),
    )
    expect(value).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(ls)', 'Bash(git)'] },
    })
  })

  it('skips layers targeting a different OS or machine', () => {
    const { value } = resolve(
      [
        { id: 'os:windows', data: { defaultShell: 'powershell' } },
        { id: 'machine:other', data: { model: 'haiku' } },
      ],
      rules,
      host(),
    )
    expect(value).toEqual({})
  })

  it('WSL matches BOTH os:linux and os:wsl', () => {
    // Treating WSL as neither is how a device ends up receiving no config.
    const wsl = host({ os: 'linux', runtime: 'wsl' })
    expect(resolve([{ id: 'os:linux', data: { a: 1 } }], rules, wsl).value).toEqual({ a: 1 })
    expect(resolve([{ id: 'os:wsl', data: { b: 2 } }], rules, wsl).value).toEqual({ b: 2 })
  })

  it('handles array-rooted layers as whole documents', () => {
    const { value } = resolve([{ id: 'base', data: [{ k: 'ctrl-a' }] }], rules, host())
    expect(value).toEqual([{ k: 'ctrl-a' }])
  })
})

describe('validateLayer — portability enforcement', () => {
  const rules: KeyRule[] = [
    { match: 'hooks.**', portability: 'os-scoped', merge: 'concat' },
    { match: '*.installPath', portability: 'machine-scoped', merge: 'replace' },
    { match: 'oauthAccount', portability: 'never-sync', merge: 'never', secret: true },
    { match: '**', portability: 'portable', merge: 'deep-merge' },
  ]

  it('rejects an OS-specific hook in the shared base layer', () => {
    // This is the bug class that would define the product's reputation: a macOS
    // shell hook silently failing on every Windows device.
    const v = validateLayer('base', { hooks: { PreToolUse: 'sh -c lint' } }, rules)
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toMatch(/os: layer/)
  })

  it('allows that same hook in an os-scoped layer', () => {
    expect(validateLayer('os:macos', { hooks: { PreToolUse: 'sh -c lint' } }, rules)).toEqual([])
  })

  it('rejects machine-scoped absolute paths above the machine layer', () => {
    expect(validateLayer('os:macos', { plugin: { installPath: '/Users/x' } }, rules)).toHaveLength(1)
    expect(validateLayer('machine:dev-1', { plugin: { installPath: '/Users/x' } }, rules)).toEqual([])
  })

  it('rejects never-sync secrets in EVERY layer', () => {
    for (const layer of ['base', 'os:macos', 'machine:dev-1'] as const) {
      const v = validateLayer(layer, { oauthAccount: { token: 'x' } }, rules)
      expect(v).toHaveLength(1)
      expect(v[0]?.reason).toMatch(/keychain/i)
    }
  })
})

describe('classifyRisk', () => {
  it('flags everything that can execute code', () => {
    for (const p of ['hooks.PreToolUse', 'mcpServers.gh.command', 'env.PATH', 'apiKeyHelper'])
      expect(classifyRisk(p)).toBe('code-execution')
  })

  it('flags permission and marketplace changes as elevated', () => {
    expect(classifyRisk('permissions.allow')).toBe('elevated')
    expect(classifyRisk('extraKnownMarketplaces.foo')).toBe('elevated')
  })

  it('leaves ordinary preferences unflagged', () => {
    expect(classifyRisk('theme')).toBe('none')
  })
})

describe('buildPlan', () => {
  const rules: KeyRule[] = [{ match: '**', portability: 'portable', merge: 'deep-merge' }]
  const observed = (data: unknown): ConfigDoc[] => [
    { storeId: 's', data, hash: 'h', exists: true },
  ]

  it('emits changes only for real differences', () => {
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'claude-code',
      desired: { a: 1, b: 2 },
      observed: observed({ a: 1 }),
      rules,
      now: 'T',
    })
    expect(plan.changes.map((c) => c.path)).toEqual(['b'])
    expect(plan.changes[0]?.op).toBe('create')
  })

  it('is deterministic — identical inputs produce an identical plan id', () => {
    // Both clients must agree, or an approval bound to a plan id is meaningless.
    const args = {
      deviceId: 'dev-1' as const,
      toolId: 'claude-code' as const,
      desired: { a: 1 },
      observed: observed({}),
      rules,
    }
    expect(buildPlan({ ...args, now: 'T1' }).id).toBe(buildPlan({ ...args, now: 'T2' }).id)
  })

  it('flags changes an org policy will override, and warns', () => {
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'claude-code',
      desired: { model: 'opus' },
      observed: observed({}),
      rules,
      managed: { model: 'haiku' },
      now: 'T',
    })
    expect(plan.changes[0]?.overriddenBy).toBe('managed')
    expect(plan.warnings[0]).toMatch(/cannot be overridden/)
  })

  it('omits overriddenBy entirely when absent, so it never serializes as null', () => {
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'claude-code',
      desired: { model: 'opus' },
      observed: observed({}),
      rules,
      now: 'T',
    })
    expect('overriddenBy' in (plan.changes[0] as object)).toBe(false)
  })
})

describe('helpers', () => {
  it('deepEqual compares structurally, ignoring key order', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
  })

  it('fingerprint is stable and differs on differing input', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'))
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'))
    expect(fingerprint('abc')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('buildPlan — multi-store', () => {
  const rules: KeyRule[] = [{ match: '**', portability: 'portable', merge: 'deep-merge' }]

  it('attributes each change to its OWN store', () => {
    // Previously everything was pinned to observed[0], so `Change.storeId`
    // promised something the implementation could not deliver.
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'zed',
      desiredByStore: {
        'zed:user:settings#agent': { model: 'opus' },
        'zed:user:settings#mcp': { github: { command: 'npx' } },
      },
      observed: [
        { storeId: 'zed:user:settings#agent', data: { model: 'sonnet' }, hash: 'a', exists: true },
        { storeId: 'zed:user:settings#mcp', data: {}, hash: 'b', exists: true },
      ],
      rules,
      now: 'T',
    })

    expect(plan.changes).toHaveLength(2)
    expect(plan.changes.find((c) => c.path === 'model')?.storeId).toBe('zed:user:settings#agent')
    expect(plan.changes.find((c) => c.path === 'github.command')?.storeId).toBe('zed:user:settings#mcp')
  })

  it('diffs each store against its own observed doc, not the first one', () => {
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'zed',
      desiredByStore: { a: { k: 1 }, b: { k: 1 } },
      observed: [
        { storeId: 'a', data: { k: 1 }, hash: 'a', exists: true }, // already matches
        { storeId: 'b', data: { k: 2 }, hash: 'b', exists: true }, // differs
      ],
      rules,
      now: 'T',
    })
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]?.storeId).toBe('b')
  })

  it('still supports the single-document form', () => {
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'claude-code',
      desired: { theme: 'dark' },
      observed: [{ storeId: 's', data: {}, hash: 'h', exists: true }],
      rules,
      now: 'T',
    })
    expect(plan.changes[0]?.storeId).toBe('s')
  })

  it('omits createdAt rather than carrying an empty string', () => {
    const plan = buildPlan({
      deviceId: 'dev-1',
      toolId: 'claude-code',
      desired: { a: 1 },
      observed: [{ storeId: 's', data: {}, hash: 'h', exists: true }],
      rules,
      now: '',
    })
    expect('createdAt' in plan).toBe(false)
  })
})

describe('dotted keys — flatten and getPath must be inverses', () => {
  const rules: KeyRule[] = [{ match: '**', portability: 'portable', merge: 'deep-merge' }]

  it('reads a filename key literally, not as a nested path', () => {
    // Directory stores key by filename. `reviewer.md` is ONE key, not
    // `reviewer` → `md`, and getting this wrong made `before` always undefined.
    expect(getPath({ 'reviewer.md': '# R' }, 'reviewer.md')).toBe('# R')
  })

  it('REGRESSION: identical directory contents produce no changes', () => {
    // Before the fix every sub-agent looked like a fresh `create` on every
    // sync — so every file would be rewritten forever and never read as synced.
    const doc = { 'reviewer.md': '# R\n', 'planner.md': '# P\n' }
    const plan = buildPlan({
      deviceId: 'd',
      toolId: 'claude-code',
      desiredByStore: { agents: { ...doc } },
      observed: [{ storeId: 'agents', data: doc, hash: 'h', exists: true }],
      rules,
      now: 'T',
    })
    expect(plan.changes).toEqual([])
  })

  it('still detects a real edit to a dotted key', () => {
    const plan = buildPlan({
      deviceId: 'd',
      toolId: 'claude-code',
      desiredByStore: { agents: { 'reviewer.md': '# CHANGED\n' } },
      observed: [{ storeId: 'agents', data: { 'reviewer.md': '# R\n' }, hash: 'h', exists: true }],
      rules,
      now: 'T',
    })
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]?.op).toBe('update')
  })

  it('writes a literal key in place instead of nesting it', () => {
    const o: Record<string, unknown> = { 'a.md': 1 }
    setPath(o, 'a.md', 2)
    expect(o).toEqual({ 'a.md': 2 })
  })

  it('still nests a path whose key does not already exist', () => {
    const o: Record<string, unknown> = {}
    setPath(o, 'a.b.c', 1)
    expect(o).toEqual({ a: { b: { c: 1 } } })
  })
})
