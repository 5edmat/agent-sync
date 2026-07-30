/**
 * The single answer to "can this be written?".
 *
 * These tests exist mostly to pin the PRECEDENCE. Several reasons can be true
 * at once, and reporting the wrong one sends a user to fix the wrong thing.
 */

import { describe, expect, it } from 'vitest'

import { isActionable, writeVerdict } from '../write-verdict.js'
import type { HostEnv, StoreDescriptor } from '../types.js'

const host: HostEnv = {
  os: 'macos',
  runtime: 'native',
  arch: 'arm64',
  home: '/Users/dev',
  supportsSymlinks: true,
  hasKeyring: true,
  supportsLongPaths: true,
  shell: 'zsh',
  deviceId: 'dev-1',
}

const store = (over: Partial<StoreDescriptor> = {}): StoreDescriptor => ({
  id: 'tool:user:settings',
  scope: 'user',
  location: { kind: 'file', path: '/Users/dev/.tool/settings.json', format: 'json' },
  readable: true,
  writable: true,
  syncable: true,
  provenance: 'verified-fs',
  ...over,
})

const ctx = (over: Partial<Parameters<typeof writeVerdict>[1]> = {}) => ({
  host,
  capabilities: { apply: true },
  detection: { installed: true, present: [] },
  displayName: 'Testy',
  ...over,
})

describe('writeVerdict', () => {
  it('allows an ordinary writable, verified, installed store', () => {
    expect(writeVerdict(store(), ctx())).toEqual({ canWrite: true })
  })

  describe('each refusal, in isolation', () => {
    it('adapter cannot apply', () => {
      const v = writeVerdict(store(), ctx({ capabilities: { apply: false, reason: 'not built yet' } }))
      expect(v.reason).toBe('adapter-cannot-apply')
      expect(v.remedy).toBe('not built yet')
    })

    it('tool not installed', () => {
      const v = writeVerdict(store(), ctx({ detection: { installed: false, present: [] } }))
      expect(v.reason).toBe('tool-not-installed')
      expect(v.message).toMatch(/not installed on this device/i)
    })

    it('managed by org policy', () => {
      const v = writeVerdict(store({ scope: 'managed', writable: false }), ctx())
      expect(v.reason).toBe('not-writable')
      expect(v.message).toMatch(/organization policy/i)
    })

    it('not a file', () => {
      const v = writeVerdict(
        store({ location: { kind: 'registry', hive: 'HKLM', key: 'S', value: 'V' } }),
        ctx(),
      )
      expect(v.reason).toBe('not-a-file')
      expect(v.message).toMatch(/Windows registry/i)
    })

    it('path unverified, named with a readable OS', () => {
      const v = writeVerdict(store({ provenance: 'inferred' }), ctx())
      expect(v.reason).toBe('path-unverified')
      expect(v.message).toMatch(/unverified/i)
      // "macos" reads like a typo in user-facing prose.
      expect(v.message).toContain('macOS')
    })
  })

  describe('precedence when several are true at once', () => {
    const allWrong = store({ scope: 'managed', writable: false, provenance: 'inferred' })

    it('adapter capability outranks everything', () => {
      const v = writeVerdict(allWrong, ctx({ capabilities: { apply: false }, detection: { installed: false, present: [] } }))
      expect(v.reason).toBe('adapter-cannot-apply')
    })

    it('missing tool outranks store-level problems', () => {
      // Telling someone their path is unverified when they simply do not have
      // the software installed sends them to fix the wrong thing.
      const v = writeVerdict(allWrong, ctx({ detection: { installed: false, present: [] } }))
      expect(v.reason).toBe('tool-not-installed')
    })

    it('read-only outranks unverified', () => {
      expect(writeVerdict(allWrong, ctx()).reason).toBe('not-writable')
    })
  })

  it('skips the detection check when detection was not run', () => {
    const v = writeVerdict(store(), { host, capabilities: { apply: true } })
    expect(v.canWrite).toBe(true)
  })

  it('marks only the refusals a user can act on', () => {
    expect(isActionable('tool-not-installed')).toBe(true)
    expect(isActionable('path-unverified')).toBe(true)
    // Nagging someone about an org policy they cannot change is noise.
    expect(isActionable('not-writable')).toBe(false)
    expect(isActionable('adapter-cannot-apply')).toBe(false)
  })
})

describe('per-store capability', () => {
  const caps = { apply: true }

  it('a store can narrow the adapter-wide answer', () => {
    // Zed can read `context_servers` perfectly well and still not be writable.
    // An adapter-level flag forces all-or-nothing on a tool where the honest
    // answer is "these, not those".
    const v = writeVerdict(
      store({ capabilities: { apply: false, reason: 'needs a platform channel' } }),
      ctx({ capabilities: caps }),
    )
    expect(v.reason).toBe('store-not-supported')
    expect(v.remedy).toBe('needs a platform channel')
  })

  it('a store can NEVER widen it', () => {
    // Checked after the adapter gate on purpose, so a store cannot re-enable
    // what the adapter has already ruled out.
    const v = writeVerdict(
      store({ capabilities: { apply: true } }),
      ctx({ capabilities: { apply: false, reason: 'not built' } }),
    )
    expect(v.reason).toBe('adapter-cannot-apply')
  })

  it('stays out of the way when the store says nothing', () => {
    expect(writeVerdict(store(), ctx()).canWrite).toBe(true)
  })
})
