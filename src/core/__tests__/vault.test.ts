/**
 * Tests for secret reference handling.
 *
 * The security property under test: a secret VALUE must never appear in config
 * that leaves the device, and an UNRESOLVED reference must never be written to
 * disk as a literal. Both failure modes are silent, which is why they get tests
 * rather than trust.
 */

import { describe, expect, it } from 'vitest'

import { SECRET_REF_PATTERN, extractSecretRefs, resolveSecretRefs } from '../vault.js'

describe('extractSecretRefs', () => {
  it('finds a single reference', () => {
    expect(extractSecretRefs('${secret:github.token}')).toEqual(['github.token'])
  })

  it('finds several in one string', () => {
    expect(extractSecretRefs('${secret:a.b} and ${secret:c-d_e}')).toEqual(['a.b', 'c-d_e'])
  })

  it('finds a reference embedded in a larger value', () => {
    // Real shape: "Bearer ${secret:api.key}" or a connection string.
    expect(extractSecretRefs('Bearer ${secret:api.key}')).toEqual(['api.key'])
  })

  it('ignores non-strings and plain env-style interpolation', () => {
    expect(extractSecretRefs(42)).toEqual([])
    expect(extractSecretRefs(null)).toEqual([])
    expect(extractSecretRefs({ a: 1 })).toEqual([])
    // ${FOO} is a shell/env var, not one of our refs — must not be captured.
    expect(extractSecretRefs('${GITHUB_TOKEN}')).toEqual([])
  })

  it('rejects characters outside the allowed ref charset', () => {
    // Guards against a ref smuggling path traversal or a shell metachar.
    expect(extractSecretRefs('${secret:../../etc/passwd}')).toEqual([])
    expect(extractSecretRefs('${secret:a b}')).toEqual([])
    expect(extractSecretRefs('${secret:$(whoami)}')).toEqual([])
  })

  it('is not left stateful by a previous scan', () => {
    // SECRET_REF_PATTERN is a module-level /g regex; lastIndex leaking between
    // calls would make extraction silently skip refs on alternate invocations.
    const s = '${secret:x}'
    expect(extractSecretRefs(s)).toEqual(['x'])
    expect(extractSecretRefs(s)).toEqual(['x'])
    expect(SECRET_REF_PATTERN.lastIndex).toBe(0)
  })
})

describe('resolveSecretRefs', () => {
  const values = new Map([
    ['github.token', 'ghp_secret'],
    ['api.key', 'sk-live-123'],
  ])

  it('substitutes a known reference', () => {
    const r = resolveSecretRefs('${secret:github.token}', values)
    expect(r.resolved).toBe('ghp_secret')
    expect(r.missing).toEqual([])
  })

  it('substitutes within surrounding text', () => {
    expect(resolveSecretRefs('Bearer ${secret:api.key}', values).resolved).toBe('Bearer sk-live-123')
  })

  it('substitutes several references in one value', () => {
    const r = resolveSecretRefs('${secret:github.token}:${secret:api.key}', values)
    expect(r.resolved).toBe('ghp_secret:sk-live-123')
  })

  it('reports a missing reference AND leaves the placeholder intact', () => {
    // Leaving the literal is what lets apply() detect and refuse. Substituting
    // an empty string here would write a broken-but-plausible config.
    const r = resolveSecretRefs('${secret:absent.one}', values)
    expect(r.missing).toEqual(['absent.one'])
    expect(r.resolved).toBe('${secret:absent.one}')
  })

  it('resolves what it can and still reports the gap', () => {
    const r = resolveSecretRefs('${secret:api.key}/${secret:nope}', values)
    expect(r.resolved).toBe('sk-live-123/${secret:nope}')
    expect(r.missing).toEqual(['nope'])
  })

  it('leaves a string with no references untouched', () => {
    const r = resolveSecretRefs('plain value', values)
    expect(r.resolved).toBe('plain value')
    expect(r.missing).toEqual([])
  })

  it('does not treat a resolved value as a template for further expansion', () => {
    // A secret whose value happens to contain ${secret:...} must NOT recurse —
    // otherwise a compromised secret could pivot to read another one.
    const sneaky = new Map([['a', '${secret:b}'], ['b', 'should-not-appear']])
    const r = resolveSecretRefs('${secret:a}', sneaky)
    expect(r.resolved).toBe('${secret:b}')
    expect(r.resolved).not.toContain('should-not-appear')
  })
})
