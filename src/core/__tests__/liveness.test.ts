/**
 * Shadowing detection for first-match-wins instruction chains.
 *
 * The failure this prevents: a write that looks additive, errors nothing,
 * deletes nothing, and silently stops an existing instructions file from being
 * read at all.
 */

import { describe, expect, it } from 'vitest'

import { detectShadowing } from '../liveness.js'
import type { Change, StoreDescriptor } from '../types.js'

/** A three-deep chain, highest precedence first. */
const CHAIN: StoreDescriptor[] = [
  {
    id: 'zed:project:instructions:rules',
    scope: 'project',
    location: { kind: 'file', path: '/repo/.rules', format: 'markdown' },
    readable: true,
    writable: true,
    syncable: true,
    provenance: 'verified-doc',
  },
  {
    id: 'zed:project:instructions:agents-md',
    scope: 'project',
    location: { kind: 'file', path: '/repo/AGENTS.md', format: 'markdown' },
    activeWhen: { absent: ['zed:project:instructions:rules'] },
    readable: true,
    writable: false,
    syncable: false,
    provenance: 'verified-doc',
  },
  {
    id: 'zed:project:instructions:claude-md',
    scope: 'project',
    location: { kind: 'file', path: '/repo/CLAUDE.md', format: 'markdown' },
    activeWhen: {
      absent: ['zed:project:instructions:rules', 'zed:project:instructions:agents-md'],
    },
    readable: true,
    writable: false,
    syncable: false,
    provenance: 'verified-doc',
  },
]

const change = (storeId: string): Change => ({
  storeId,
  op: 'create',
  path: '',
  after: '# hi',
  reason: 'test',
  risk: 'none',
})

const present =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

describe('detectShadowing', () => {
  it('warns that creating .rules turns off an existing CLAUDE.md', () => {
    const w = detectShadowing(
      CHAIN,
      [change('zed:project:instructions:rules')],
      present('zed:project:instructions:claude-md'),
    )
    expect(w).toHaveLength(1)
    expect(w[0]?.deactivates).toEqual(['zed:project:instructions:claude-md'])
    expect(w[0]?.message).toMatch(/\.rules/)
    expect(w[0]?.message).toMatch(/CLAUDE\.md/)
    // Names files, not store ids — a user recognises one and not the other.
    expect(w[0]?.message).not.toMatch(/zed:project/)
  })

  it('lists every casualty when several are shadowed', () => {
    const w = detectShadowing(
      CHAIN,
      [change('zed:project:instructions:rules')],
      present('zed:project:instructions:agents-md', 'zed:project:instructions:claude-md'),
    )
    expect(w[0]?.deactivates).toHaveLength(2)
  })

  it('stays quiet when nothing downstream exists', () => {
    expect(detectShadowing(CHAIN, [change('zed:project:instructions:rules')], present())).toEqual([])
  })

  it('stays quiet when the file already exists — liveness does not change', () => {
    // Editing the winner is not destructive; it was already the winner.
    const w = detectShadowing(
      CHAIN,
      [change('zed:project:instructions:rules')],
      present('zed:project:instructions:rules', 'zed:project:instructions:claude-md'),
    )
    expect(w).toEqual([])
  })

  it('stays quiet for a store outside any chain', () => {
    const plain: StoreDescriptor = {
      id: 'zed:user:settings',
      scope: 'user',
      location: { kind: 'file', path: '/home/u/settings.json', format: 'jsonc' },
      readable: true,
      writable: true,
      syncable: true,
      provenance: 'verified-doc',
    }
    expect(
      detectShadowing([...CHAIN, plain], [change('zed:user:settings')], present('zed:project:instructions:claude-md')),
    ).toEqual([])
  })

  it('warns about a victim the plan never touches', () => {
    // The casualty is not in the changeset at all, so this cannot be answered
    // from the changes alone — it needs on-disk presence.
    const w = detectShadowing(
      CHAIN,
      [change('zed:project:instructions:rules')],
      present('zed:project:instructions:claude-md'),
    )
    expect(w[0]?.deactivates).toContain('zed:project:instructions:claude-md')
  })
})
