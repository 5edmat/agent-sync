import { describe, expect, it } from 'vitest'

import type { KeyRule } from '../../core/types.js'
import {
  REDACTED,
  countRedactions,
  isSecretKeyName,
  isSecretPath,
  looksLikeSecretValue,
  redactValue,
} from '../redact.js'

const RULES: KeyRule[] = [
  { match: 'oauthAccount', portability: 'never-sync', merge: 'never', secret: true },
  { match: 'mcpServers.*.env.**', portability: 'never-sync', merge: 'never', secret: true },
  { match: '**', portability: 'portable', merge: 'deep-merge' },
]

describe('isSecretKeyName', () => {
  it('matches obvious credential names in every casing convention', () => {
    for (const name of [
      'token',
      'apiKey',
      'api_key',
      'API-KEY',
      'githubToken',
      'clientSecret',
      'PASSWORD',
      'refresh_token',
      'privateKey',
      'AUTHORIZATION',
    ]) {
      expect(isSecretKeyName(name), name).toBe(true)
    }
  })

  it('does not match words that merely contain a credential substring', () => {
    for (const name of ['tokenizer', 'authorized', 'authority', 'tokens', 'secrets']) {
      expect(isSecretKeyName(name), name).toBe(false)
    }
  })

  it('does not match ordinary config keys', () => {
    for (const name of ['model', 'theme', 'permissions', 'allow', 'hooks', 'editorMode', 'installPath']) {
      expect(isSecretKeyName(name), name).toBe(false)
    }
  })
})

describe('isSecretPath', () => {
  it('taints a path when any segment names a secret', () => {
    expect(isSecretPath('env.GITHUB_TOKEN')).toBe(true)
    expect(isSecretPath('a.b.password.c')).toBe(true)
  })

  it('consults adapter rules for paths the name heuristic misses', () => {
    expect(isSecretPath('oauthAccount', RULES)).toBe(true)
    expect(isSecretPath('oauthAccount')).toBe(false)
  })

  it('leaves ordinary paths alone', () => {
    expect(isSecretPath('permissions.allow', RULES)).toBe(false)
    expect(isSecretPath('model', RULES)).toBe(false)
  })
})

describe('looksLikeSecretValue', () => {
  it('recognises well-known credential shapes', () => {
    expect(looksLikeSecretValue('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('GitHub token')
    expect(looksLikeSecretValue('AKIAIOSFODNN7EXAMPLE')).toBe('AWS access key id')
    expect(looksLikeSecretValue('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe('PEM private key')
    expect(looksLikeSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdef')).toBe('JWT')
  })

  it('does not fire on a content hash, which users need to read', () => {
    expect(looksLikeSecretValue('a'.repeat(64))).toBeUndefined()
    expect(looksLikeSecretValue('9f86d081884c7d659a2feaa0c55ad015')).toBeUndefined()
  })

  it('does not fire on ordinary strings', () => {
    expect(looksLikeSecretValue('opus-4')).toBeUndefined()
    expect(looksLikeSecretValue('/usr/local/bin/node')).toBeUndefined()
  })
})

describe('redactValue', () => {
  it('replaces a secret-shaped key value while keeping the key visible', () => {
    const out = redactValue({ env: { GITHUB_TOKEN: 'hunter2', PATH: '/usr/bin' } }) as {
      env: Record<string, string>
    }
    expect(out.env['GITHUB_TOKEN']).toBe(REDACTED)
    expect(out.env['PATH']).toBe('/usr/bin')
  })

  it('taints the whole subtree under a secret-shaped key', () => {
    const out = redactValue({ credentials: { nested: { deep: 'value' } } }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain('value')
    expect(JSON.stringify(out)).toContain(REDACTED)
  })

  it('uses adapter rules for paths the name heuristic would miss', () => {
    const out = redactValue({ oauthAccount: { emailAddress: 'a@b.c' } }, { rules: RULES })
    expect(JSON.stringify(out)).not.toContain('a@b.c')
  })

  it('redacts by value shape even under an innocent key', () => {
    const out = redactValue({ value: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }) as Record<string, unknown>
    expect(out['value']).toBe(REDACTED)
  })

  it('keeps ${secret:...} references readable — they are the point of the vault', () => {
    const out = redactValue({ env: { GITHUB_TOKEN: '${secret:github.token}' } }) as {
      env: Record<string, string>
    }
    expect(out.env['GITHUB_TOKEN']).toBe('${secret:github.token}')
  })

  it('preserves structure so a reviewer can still see the shape of a change', () => {
    const out = redactValue({ mcpServers: { gh: { command: 'npx', env: { TOKEN: 'x' } } } }, { rules: RULES }) as {
      mcpServers: { gh: { command: string; env: Record<string, string> } }
    }
    expect(out.mcpServers.gh.command).toBe('npx')
    expect(Object.keys(out.mcpServers.gh.env)).toEqual(['TOKEN'])
    expect(out.mcpServers.gh.env['TOKEN']).toBe(REDACTED)
  })

  it('leaves numbers and booleans alone — blanking them destroys the diff', () => {
    const out = redactValue({ retries: 3, enabled: true, missing: null }) as Record<string, unknown>
    expect(out).toEqual({ retries: 3, enabled: true, missing: null })
  })

  it('redacts inside arrays', () => {
    const out = redactValue({ tokens: ['ghp_abcdefghijklmnopqrstuvwxyz0123'] }) as { tokens: string[] }
    expect(out.tokens[0]).toBe(REDACTED)
  })

  it('honours an explicit starting path', () => {
    const out = redactValue('hunter2', { path: 'env.API_KEY' })
    expect(out).toBe(REDACTED)
  })
})

describe('countRedactions', () => {
  it('counts what was hidden so the renderer can say so', () => {
    const out = redactValue({ a: { token: 'x' }, b: { password: 'y' }, c: 'fine' })
    expect(countRedactions(out)).toBe(2)
  })

  it('is zero when nothing was hidden', () => {
    expect(countRedactions(redactValue({ model: 'opus' }))).toBe(0)
  })
})
