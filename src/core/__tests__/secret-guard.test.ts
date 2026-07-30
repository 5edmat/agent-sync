/**
 * The shape-independent secret floor.
 *
 * Context: `never-sync` KeyRules only fire when the document is the shape the
 * rules were written for, and adapters accept more than one shape. The same
 * GitHub token was verified to be BLOCKED as `mcpServers.github.env.TOKEN` and
 * classified `portable` as `stores.<id>.mcpServers.github.env.TOKEN`. These
 * tests pin the floor that catches both.
 */

import { describe, expect, it } from 'vitest'

import { hasSecrets, scanForSecrets } from '../secret-guard.js'
import { buildPlan } from '../reconcile.js'
import type { ConfigDoc, KeyRule } from '../types.js'

const TOKEN = 'ghp_ABCDEFGHIJKLMNOP1234'

describe('scanForSecrets — by value shape', () => {
  it.each([
    ['GitHub', TOKEN],
    ['OpenAI', 'sk-abcdefghijklmnopqrstuvwx'],
    ['Anthropic', 'sk-ant-abcdefghijklmnopqrst'],
    ['Slack', 'xoxb-1234567890-abcdefghij'],
    ['AWS key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE'],
  ])('catches a %s credential even under an innocent key', (_label, value) => {
    expect(hasSecrets({ harmless_looking: value })).toBe(true)
  })

  it('finds one inside an args array', () => {
    // `args: ["--token", "ghp_…"]` is a real MCP server shape, and `flatten`
    // treats arrays as leaves, so a path-based rule would never see it.
    const found = scanForSecrets({ mcpServers: { gh: { args: ['--token', TOKEN] } } })
    expect(found).toHaveLength(1)
    expect(found[0]?.path).toBe('mcpServers.gh.args[1]')
    expect(found[0]?.via).toBe('value-shape')
  })
})

describe('scanForSecrets — by key name', () => {
  it('flags secret-shaped keys with opaque values', () => {
    expect(hasSecrets({ database: { password: 'hunter2xyz' } })).toBe(true)
    expect(hasSecrets({ api_key: 'abcdefghijkl' })).toBe(true)
    expect(hasSecrets({ clientSecret: 'abcdefghijkl' })).toBe(true)
  })

  it('does NOT flag config keys that merely contain a secret word', () => {
    // False positives are cheap but not free — these are ordinary settings.
    expect(hasSecrets({ authMethod: 'oauth' })).toBe(false)
    expect(hasSecrets({ auth_url: 'https://example.com/login' })).toBe(false)
    expect(hasSecrets({ tokenLimit: '200000' })).toBe(false)
    expect(hasSecrets({ session_timeout: '3600' })).toBe(false)
  })

  it('does NOT flag an empty value or a vault reference', () => {
    expect(hasSecrets({ password: '' })).toBe(false)
    // The whole design is that config carries references, not values.
    expect(hasSecrets({ password: '${secret:db.password}' })).toBe(false)
    expect(hasSecrets({ env: { TOKEN: '${secret:github.token}' } })).toBe(false)
  })
})

describe('buildPlan refuses to carry secrets, whatever the shape', () => {
  const rules: KeyRule[] = [
    { match: 'mcpServers.*.env.**', portability: 'never-sync', merge: 'never', secret: true },
    { match: '**', portability: 'portable', merge: 'deep-merge' },
  ]
  const observed: ConfigDoc[] = [{ storeId: 's', data: {}, hash: 'h', exists: true }]
  const plan = (desired: unknown) =>
    buildPlan({ deviceId: 'd', toolId: 'cursor', desired: desired as never, observed, rules, now: 'T' })

  it('blocks the flat shape (the rule already covered this)', () => {
    const p = plan({ mcpServers: { github: { env: { GITHUB_TOKEN: TOKEN } } } })
    expect(JSON.stringify(p.changes)).not.toContain(TOKEN)
  })

  it('REGRESSION: blocks the nested {stores} shape the rules do NOT match', () => {
    // This shape is what cursor.ts and zed.ts actually consume. Before the
    // floor existed it produced a change carrying the live token.
    const p = plan({
      stores: { 'cursor:user:mcp': { mcpServers: { github: { env: { GITHUB_TOKEN: TOKEN } } } } },
    })
    expect(JSON.stringify(p.changes)).not.toContain(TOKEN)
    expect(p.warnings.join(' ')).toMatch(/Refused to sync/)
  })

  it('blocks a token smuggled through an args array', () => {
    const p = plan({ mcpServers: { gh: { args: ['--token', TOKEN] } } })
    expect(JSON.stringify(p.changes)).not.toContain(TOKEN)
  })

  it('tells the user what to do instead', () => {
    const p = plan({ stores: { x: { password: 'hunter2xyz' } } })
    expect(p.warnings.join(' ')).toMatch(/keychain/)
    expect(p.warnings.join(' ')).toMatch(/\$\{secret:/)
  })

  it('still syncs a vault REFERENCE — that indirection is the point', () => {
    const p = plan({ env: { GITHUB_TOKEN: '${secret:github.token}' } })
    expect(p.changes).toHaveLength(1)
    expect(p.warnings).toHaveLength(0)
  })

  it('leaves ordinary config alone', () => {
    const p = plan({ theme: 'dark', model: 'opus', permissions: { defaultMode: 'auto' } })
    expect(p.changes).toHaveLength(3)
    expect(p.warnings).toHaveLength(0)
  })
})
