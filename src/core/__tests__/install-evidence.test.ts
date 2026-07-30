/**
 * Ranked install evidence.
 *
 * Two failures this prevents, both found in review:
 *   - a config file WE can write vouching for a tool that is gone
 *   - `detect()` answering differently depending on the working directory
 */

import { describe, expect, it } from 'vitest'

import { classifyInstallEvidence, conceptFor, decideInstalled } from '../concepts.js'

const store = (over: Partial<Parameters<typeof classifyInstallEvidence>[0]> = {}) => ({
  scope: 'user',
  writable: false,
  location: { kind: 'file', path: '/Users/dev/.cursor/mcp.json' },
  ...over,
})

describe('classifyInstallEvidence', () => {
  it('ranks a binary or app bundle as definitive', () => {
    expect(
      classifyInstallEvidence(
        store({ installProof: true, location: { kind: 'dir', path: '/Applications/Cursor.app' } }),
      ),
    ).toBe('definitive')
  })

  it('ranks a config file we do NOT write as strong', () => {
    expect(classifyInstallEvidence(store({ writable: false }))).toBe('strong')
  })

  it('ranks a config file we CAN write as only weak', () => {
    // The self-confirmation case: a file we left behind would otherwise keep
    // vouching for a tool that has since been uninstalled.
    expect(classifyInstallEvidence(store({ writable: true }))).toBe('weak')
  })

  it('gives project-scope files NO weight', () => {
    // This is what made detect() depend on the working directory: running from
    // a repo containing .rules made the tool "installed", running from ~ did
    // not. A file in someone's repo describes a repo, not a machine.
    expect(
      classifyInstallEvidence(store({ scope: 'project', location: { kind: 'file', path: '.rules' } })),
    ).toBe('none')
  })

  it('gives local-scope files no weight either', () => {
    expect(classifyInstallEvidence(store({ scope: 'local' }))).toBe('none')
  })

  it('gives cross-tool shared directories no weight', () => {
    // ~/.agents/skills is read by Claude Code, Cursor and Codex alike.
    expect(
      classifyInstallEvidence(store({ location: { kind: 'dir', path: '/Users/dev/.agents/skills' } })),
    ).toBe('none')
  })

  it('gives non-filesystem stores no weight', () => {
    for (const kind of ['registry', 'plist', 'remote'])
      expect(classifyInstallEvidence(store({ location: { kind } }))).toBe('none')
  })
})

describe('decideInstalled', () => {
  it('reports the STRONGEST evidence found, not the first', () => {
    expect(decideInstalled(['weak', 'definitive', 'none'])).toEqual({
      installed: true,
      confidence: 'definitive',
    })
  })

  it('still counts weak evidence as installed', () => {
    // Refusing here would make the product useless for exactly the tools it
    // targets. What changes is that we KNOW it is weak and can say so.
    expect(decideInstalled(['weak'])).toEqual({ installed: true, confidence: 'weak' })
  })

  it('is not installed when nothing counted', () => {
    expect(decideInstalled(['none', 'none'])).toEqual({ installed: false, confidence: 'none' })
    expect(decideInstalled([])).toEqual({ installed: false, confidence: 'none' })
  })
})

describe('conceptFor', () => {
  it('classifies a subtree by its BRANCH, not the file it lives in', () => {
    // `zed:user:settings#context_servers` is about MCP. Matching on the whole
    // id would let the filename outvote the branch that actually matters.
    expect(conceptFor('zed:user:settings#context_servers')).toBe('mcp')
    expect(conceptFor('zed:user:settings#agent')).toBe('agent')
    expect(conceptFor('zed:user:settings#theme')).toBe('editor')
  })

  it('REGRESSION: the primary settings store is not "other"', () => {
    // `claude-code:user:settings` is the most common store in the product and
    // fell through to the catch-all. It went unnoticed only because that
    // adapter sets `concept` by hand.
    expect(conceptFor('claude-code:user:settings')).toBe('permissions')
  })

  it('does not let the generic settings match swallow editor config', () => {
    expect(conceptFor('cursor:user:ide-settings')).toBe('editor')
    expect(conceptFor('claude-code:user:keybindings')).toBe('editor')
  })

  it('keeps the obvious cases obvious', () => {
    expect(conceptFor('claude-code:user:skills')).toBe('skills')
    expect(conceptFor('claude-code:user:memory')).toBe('rules')
    expect(conceptFor('cursor:user:permissions')).toBe('permissions')
    expect(conceptFor('something:unrecognised')).toBe('other')
  })
})
