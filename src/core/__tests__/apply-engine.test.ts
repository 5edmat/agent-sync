/**
 * Tests for the only code that writes to a user's config.
 *
 * These run against a REAL filesystem in a temp dir, not a fake. The whole
 * point of this layer is that atomic writes, backups and restores behave
 * correctly against actual syscalls; mocking that away would test nothing.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyPlan, rollbackApply, applyChangesToDoc, StalePlanError } from '../apply-engine.js'
import { buildPlan } from '../reconcile.js'
import { canonicalJson, sha256Hex } from '../../platform/canonical.js'
import { parseJsonc } from '../../platform/jsonc.js'
import type { Change, ConfigDoc, HostEnv, KeyRule, Plan, StoreDescriptor, ToolAdapter } from '../types.js'

let work: string
let stateDir: string

const HOST: HostEnv = {
  os: 'macos',
  runtime: 'native',
  arch: 'arm64',
  home: '/home/test',
  supportsSymlinks: true,
  hasKeyring: true,
  supportsLongPaths: true,
  shell: 'zsh',
  deviceId: 'dev-test',
}

const RULES: KeyRule[] = [{ match: '**', portability: 'portable', merge: 'deep-merge' }]

/** Adapter whose stores point into the temp dir, so writes are real but scoped. */
function testAdapter(overrides: Partial<StoreDescriptor>[] = []): ToolAdapter {
  return {
    id: 'claude-code',
    displayName: 'Test',
    capabilities: { apply: true },
    locations: () =>
      [
        {
          id: 'settings',
          scope: 'user',
          location: { kind: 'file', path: join(work, 'settings.json'), format: 'json' },
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
        ...overrides,
      ] as StoreDescriptor[],
    detect: async () => ({ installed: true, present: ['settings'] }),
    rules: () => RULES,
    read: async (store) => {
      const loc = store.location as { kind: 'file'; path: string }
      let data: unknown = {}
      let exists = false
      try {
        data = JSON.parse(await readFile(loc.path, 'utf8'))
        exists = true
      } catch {
        /* absent */
      }
      return { storeId: store.id, data, hash: sha256Hex(canonicalJson(data)), exists }
    },
    plan: () => {
      throw new Error('unused')
    },
    apply: async () => {
      throw new Error('unused')
    },
    rollback: async () => {},
    canonicalize: (doc: ConfigDoc) => canonicalJson(doc.data),
  }
}

function planFor(changes: Change[], baseHashes: Record<string, string> = {}): Plan {
  return { id: 'plan-test', deviceId: 'dev-test', toolId: 'claude-code', changes, baseHashes, warnings: [] }
}

const change = (path: string, after: unknown, storeId = 'settings'): Change => ({
  storeId,
  op: 'update',
  path,
  after,
  reason: 'test',
  risk: 'none',
})

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'apply-'))
  stateDir = await mkdtemp(join(tmpdir(), 'state-'))
})
afterEach(async () => {
  await rm(work, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

const deps = (adapter = testAdapter()) => ({
  adapter,
  host: HOST,
  now: () => '2026-07-29T12:00:00.000Z',
  stateDirOverride: stateDir,
})

// ---------------------------------------------------------------------------

describe('applyPlan — writing', () => {
  it('writes a new value to disk', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ theme: 'light' }), 'utf8')

    const res = await applyPlan(planFor([change('theme', 'dark')]), deps())

    expect(res.applied).toHaveLength(1)
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('creates the file and parent directory when absent', async () => {
    const adapter = testAdapter()
    adapter.locations = () =>
      [
        {
          id: 'settings',
          scope: 'user',
          location: { kind: 'file', path: join(work, 'nested', 'deep', 'settings.json'), format: 'json' },
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
      ] as StoreDescriptor[]

    await applyPlan(planFor([change('model', 'opus')]), deps(adapter))
    const written = JSON.parse(await readFile(join(work, 'nested', 'deep', 'settings.json'), 'utf8'))
    expect(written).toEqual({ model: 'opus' })
  })

  it('PRESERVES keys it does not model', async () => {
    // These formats are versioned and will grow keys we have never seen.
    // Rewriting the file from our own model would silently delete them.
    await writeFile(
      join(work, 'settings.json'),
      JSON.stringify({ theme: 'light', someFutureKey: { deeply: ['nested', 1, true] } }),
      'utf8',
    )

    await applyPlan(planFor([change('theme', 'dark')]), deps())

    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      someFutureKey: { deeply: ['nested', 1, true] },
    })
  })

  it('replaces the whole document for array-rooted files', async () => {
    // Regression: flatten() used to return [] for array roots, so this produced
    // zero changes and reported success while syncing nothing.
    const next = applyChangesToDoc([{ old: true }], [{ ...change('', [{ shell: 'echo hi' }]) }])
    expect(next).toEqual([{ shell: 'echo hi' }])
  })
})

describe('applyPlan — refusals', () => {
  it('refuses to write to an inferred path', async () => {
    const adapter = testAdapter()
    adapter.locations = () =>
      [
        {
          id: 'settings',
          scope: 'user',
          location: { kind: 'file', path: join(work, 'settings.json'), format: 'json' },
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'inferred', // never verified on this OS
        },
      ] as StoreDescriptor[]

    const res = await applyPlan(planFor([change('theme', 'dark')]), deps(adapter))

    expect(res.applied).toHaveLength(0)
    expect(res.skipped[0]?.skipReason).toMatch(/unverified/i)
    await expect(readFile(join(work, 'settings.json'), 'utf8')).rejects.toThrow()
  })

  it('skips managed stores instead of fighting policy', async () => {
    const adapter = testAdapter([
      {
        id: 'managed',
        scope: 'managed',
        location: { kind: 'file', path: join(work, 'managed.json'), format: 'json' },
        readable: true,
        writable: false,
        syncable: false,
        provenance: 'verified-doc',
      } as StoreDescriptor,
    ])

    const res = await applyPlan(planFor([change('x', 1, 'managed')]), deps(adapter))
    expect(res.skipped[0]?.skipReason).toMatch(/organization policy/i)
  })

  it('skips non-file stores (registry/plist need a platform channel)', async () => {
    const adapter = testAdapter([
      {
        id: 'reg',
        scope: 'user',
        location: { kind: 'registry', hive: 'HKCU', key: 'Software\\X', value: 'Settings' },
        readable: true,
        writable: true,
        syncable: true,
        provenance: 'verified-doc',
      } as StoreDescriptor,
    ])

    const res = await applyPlan(planFor([change('x', 1, 'reg')]), deps(adapter))
    expect(res.skipped[0]?.skipReason).toMatch(/registry/i)
  })

  it('fails an unknown store rather than guessing', async () => {
    const res = await applyPlan(planFor([change('x', 1, 'nope')]), deps())
    expect(res.failed[0]?.error).toMatch(/unknown store/i)
  })
})

describe('applyPlan — staleness', () => {
  it('aborts and writes NOTHING when the file moved since planning', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ theme: 'light' }), 'utf8')

    // Plan computed against a hash that no longer matches what is on disk.
    const stale = planFor([change('theme', 'dark')], { settings: sha256Hex('something-else') })

    await expect(applyPlan(stale, deps())).rejects.toThrow(StalePlanError)
    // Original content untouched — the user approved a diff against a state
    // that no longer exists, so applying it would write something unreviewed.
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({ theme: 'light' })
  })

  it('proceeds when the hash still matches', async () => {
    const data = { theme: 'light' }
    await writeFile(join(work, 'settings.json'), JSON.stringify(data), 'utf8')

    const fresh = planFor([change('theme', 'dark')], { settings: sha256Hex(canonicalJson(data)) })
    const res = await applyPlan(fresh, deps())
    expect(res.applied).toHaveLength(1)
  })
})

describe('applyPlan — secrets', () => {
  it('never writes an unresolved secret reference into config', async () => {
    await writeFile(join(work, 'settings.json'), '{}', 'utf8')

    const res = await applyPlan(
      planFor([change('env.TOKEN', '${secret:github.token}')]),
      deps(), // no secrets provided
    )

    expect(res.applied).toHaveLength(0)
    expect(res.failed[0]?.error).toMatch(/unresolved secret/i)
    // The literal placeholder must NOT reach disk — it would break the tool
    // in a way that looks like our config is correct.
    expect(await readFile(join(work, 'settings.json'), 'utf8')).toBe('{}')
  })

  it('materializes secrets when the device has them', async () => {
    await writeFile(join(work, 'settings.json'), '{}', 'utf8')

    const res = await applyPlan(planFor([change('env.TOKEN', '${secret:github.token}')]), {
      ...deps(),
      secrets: new Map([['github.token', 'ghp_real']]),
    })

    expect(res.applied).toHaveLength(1)
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({
      env: { TOKEN: 'ghp_real' },
    })
  })
})

describe('rollback', () => {
  it('restores the previous contents', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ theme: 'light' }), 'utf8')

    const res = await applyPlan(planFor([change('theme', 'dark')]), deps())
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8')).theme).toBe('dark')

    await rollbackApply(res.rollbackId, deps())
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8')).theme).toBe('light')
  })

  it('deletes a file that did not exist before the apply', async () => {
    const res = await applyPlan(planFor([change('model', 'opus')]), deps())
    expect(await readdir(work)).toContain('settings.json')

    await rollbackApply(res.rollbackId, deps())
    expect(await readdir(work)).not.toContain('settings.json')
  })

  it('persists the manifest so rollback works from a later process', async () => {
    const res = await applyPlan(planFor([change('theme', 'dark')]), deps())
    const files = await readdir(join(stateDir, 'rollbacks'))
    expect(files).toContain(`${res.rollbackId}.json`)
  })
})

describe('applyPlan — format preservation', () => {
  /**
   * An adapter that reads JSONC, because every tool we sync accepts it. The
   * default test adapter uses JSON.parse and would report an annotated file as
   * absent, which is a different bug than the one under test here.
   */
  function jsoncAdapter(format: 'json' | 'jsonc' = 'jsonc'): ToolAdapter {
    const adapter = testAdapter()
    adapter.locations = () =>
      [
        {
          id: 'settings',
          scope: 'user',
          location: { kind: 'file', path: join(work, 'settings.json'), format },
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
      ] as StoreDescriptor[]
    adapter.read = async (store) => {
      const loc = store.location as { kind: 'file'; path: string }
      let data: unknown = {}
      let exists = false
      try {
        data = parseJsonc(await readFile(loc.path, 'utf8'))
        exists = true
      } catch {
        /* absent */
      }
      return { storeId: store.id, data, hash: sha256Hex(canonicalJson(data)), exists }
    }
    return adapter
  }

  /** What a real annotated Claude Code settings.json looks like. */
  const ANNOTATED = `{
  // Opus for planning, sonnet for grinding.
  "model": "sonnet",

  /* Permission rules merge across scopes rather than override,
     so keep this list tight. */
  "permissions": {
    "allow": [
      "Bash(ls:*)", // harmless
      "Read(**)"
    ],
    "deny": ["Bash(rm:*)"]
  },

  "env": {
    "EDITOR": "vim"
  }
}
`

  it('writes through a commented settings.json without eating the comments', async () => {
    await writeFile(join(work, 'settings.json'), ANNOTATED, 'utf8')

    const res = await applyPlan(
      planFor([change('model', 'opus'), change('env.PAGER', 'less')]),
      deps(jsoncAdapter()),
    )
    expect(res.applied).toHaveLength(2)

    const after = await readFile(join(work, 'settings.json'), 'utf8')

    // Every comment survives, in place.
    expect(after).toContain('// Opus for planning, sonnet for grinding.')
    expect(after).toContain('/* Permission rules merge across scopes rather than override,')
    expect(after).toContain('     so keep this list tight. */')
    expect(after).toContain('"Bash(ls:*)", // harmless')

    // So does key order, indentation, and the blank line between sections.
    expect(after).toBe(
      ANNOTATED.replace('"sonnet"', '"opus"').replace(
        '    "EDITOR": "vim"\n',
        '    "EDITOR": "vim",\n    "PAGER": "less"\n',
      ),
    )
  })

  it('leaves the file byte-identical when the planned value is already there', async () => {
    await writeFile(join(work, 'settings.json'), ANNOTATED, 'utf8')
    await applyPlan(planFor([change('model', 'sonnet')]), deps(jsoncAdapter()))
    expect(await readFile(join(work, 'settings.json'), 'utf8')).toBe(ANNOTATED)
  })

  it('preserves CRLF and a BOM', async () => {
    const crlf = '﻿{\r\n  // keep me\r\n  "theme": "light"\r\n}\r\n'
    await writeFile(join(work, 'settings.json'), crlf, 'utf8')

    await applyPlan(planFor([change('theme', 'dark')]), deps(jsoncAdapter()))

    const after = await readFile(join(work, 'settings.json'), 'utf8')
    expect(after).toBe('﻿{\r\n  // keep me\r\n  "theme": "dark"\r\n}\r\n')
  })

  it('preserves formatting for format: "json" too — those files hold comments in practice', async () => {
    await writeFile(join(work, 'settings.json'), ANNOTATED, 'utf8')
    await applyPlan(planFor([change('model', 'opus')]), deps(jsoncAdapter('json')))
    expect(await readFile(join(work, 'settings.json'), 'utf8')).toContain('// Opus for planning')
  })

  it('still writes a canonical file when there was no file to preserve', async () => {
    const res = await applyPlan(planFor([change('model', 'opus')]), deps(jsoncAdapter()))
    expect(res.applied).toHaveLength(1)
    expect(await readFile(join(work, 'settings.json'), 'utf8')).toBe('{\n  "model": "opus"\n}\n')
  })

  it('REFUSES an unparseable file rather than rebuilding it', async () => {
    // EXPECTATION DELIBERATELY REVERSED. This used to assert a canonical-write
    // fallback, on the reasoning that the file is already broken for its own
    // tool so refusing would abort the rest of the plan over it.
    //
    // That justifies not failing the apply. It does not justify OVERWRITING.
    // The fallback rebuilds the file from our model, and our model of a file we
    // could not parse is wrong by definition — for a subtree store it is `{}`,
    // so we would write one branch over a file still holding every other key
    // the user had. Losing a plan is recoverable; losing their settings is not.
    await writeFile(join(work, 'settings.json'), '{ this is not json', 'utf8')
    const original = await readFile(join(work, 'settings.json'), 'utf8')

    await expect(applyPlan(planFor([change('model', 'opus')]), deps(jsoncAdapter()))).rejects.toThrow(
      /not valid JSON/i,
    )
    expect(await readFile(join(work, 'settings.json'), 'utf8')).toBe(original)
  })

  it('rolls a surgical write back to the original bytes, comments and all', async () => {
    await writeFile(join(work, 'settings.json'), ANNOTATED, 'utf8')

    const res = await applyPlan(planFor([change('model', 'opus')]), deps(jsoncAdapter()))
    await rollbackApply(res.rollbackId, deps(jsoncAdapter()))

    expect(await readFile(join(work, 'settings.json'), 'utf8')).toBe(ANNOTATED)
  })

  it('deletes a key without leaving a dangling comma', async () => {
    await writeFile(join(work, 'settings.json'), ANNOTATED, 'utf8')

    const del: Change = {
      storeId: 'settings',
      op: 'delete',
      path: 'env.EDITOR',
      reason: 'test',
      risk: 'none',
    }
    await applyPlan(planFor([del]), deps(jsoncAdapter()))

    const after = await readFile(join(work, 'settings.json'), 'utf8')
    expect(after).toContain('"env": {}')
    expect(parseJsonc(after)).toMatchObject({ env: {} })
    expect(after).toContain('// Opus for planning, sonnet for grinding.')
  })

  it('replaces an array-rooted document at the "" path, keeping the header comment', async () => {
    const keymap = '// Zed keymap — do not sort\n[\n  { "context": "Editor" }\n]\n'
    await writeFile(join(work, 'settings.json'), keymap, 'utf8')

    await applyPlan(
      planFor([change('', [{ context: 'Workspace' }])]),
      deps(jsoncAdapter()),
    )

    const after = await readFile(join(work, 'settings.json'), 'utf8')
    expect(after).toBe(
      '// Zed keymap — do not sort\n[\n  {\n    "context": "Workspace"\n  }\n]\n',
    )
  })

  it('never writes a secret placeholder through the preserving path either', async () => {
    await writeFile(join(work, 'settings.json'), ANNOTATED, 'utf8')

    const res = await applyPlan(planFor([change('env.TOKEN', '${secret:github.token}')]), {
      ...deps(jsoncAdapter()),
      secrets: new Map([['github.token', 'ghp_real']]),
    })

    expect(res.applied).toHaveLength(1)
    const after = await readFile(join(work, 'settings.json'), 'utf8')
    expect(after).toContain('"TOKEN": "ghp_real"')
    expect(after).not.toContain('${secret:')
    expect(after).toContain('// Opus for planning, sonnet for grinding.')
  })
})

describe('integration with buildPlan', () => {
  it('plans and applies a real diff end to end', async () => {
    const current = { theme: 'light', permissions: { allow: ['Bash(ls)'] } }
    await writeFile(join(work, 'settings.json'), JSON.stringify(current), 'utf8')

    const observed: ConfigDoc[] = [
      { storeId: 'settings', data: current, hash: sha256Hex(canonicalJson(current)), exists: true },
    ]
    const plan = buildPlan({
      deviceId: 'dev-test',
      toolId: 'claude-code',
      desired: { theme: 'dark', model: 'opus' },
      observed,
      rules: RULES,
      now: '2026-07-29T12:00:00.000Z',
    })

    expect(plan.changes.map((c) => c.path).sort()).toEqual(['model', 'theme'])

    const res = await applyPlan(plan, deps())
    expect(res.applied).toHaveLength(2)
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] }, // untouched
    })
  })
})

describe('non-JSON formats', () => {
  const mdAdapter = () => {
    const a = testAdapter()
    a.locations = () =>
      [
        {
          id: 'memory',
          scope: 'user',
          location: { kind: 'file', path: join(work, 'CLAUDE.md'), format: 'markdown' },
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
      ] as StoreDescriptor[]
    a.read = async (store) => {
      const loc = store.location as { path: string }
      let text = ''
      let exists = false
      try {
        text = await readFile(loc.path, 'utf8')
        exists = true
      } catch {
        /* absent */
      }
      return { storeId: store.id, data: text, hash: sha256Hex(text), exists }
    }
    return a
  }

  it('DATA LOSS: never writes JSON over a markdown file', async () => {
    const md = '# My instructions\n\nAlways use tabs.\n'
    await writeFile(join(work, 'CLAUDE.md'), md, 'utf8')

    // A dot-path change makes no sense for markdown. It must be refused,
    // not serialized into the file as a JSON object.
    const res = await applyPlan(
      planFor([{ ...change('theme', 'dark', 'memory') }]),
      deps(mdAdapter()),
    )

    expect(res.applied).toHaveLength(0)
    expect(await readFile(join(work, 'CLAUDE.md'), 'utf8')).toBe(md)
  })

  it('replaces markdown wholesale via a root change', async () => {
    await writeFile(join(work, 'CLAUDE.md'), '# Old\n', 'utf8')
    const res = await applyPlan(
      planFor([{ ...change('', '# New\n\nBe concise.\n', 'memory') }]),
      deps(mdAdapter()),
    )
    expect(res.applied).toHaveLength(1)
    expect(await readFile(join(work, 'CLAUDE.md'), 'utf8')).toBe('# New\n\nBe concise.\n')
  })
})

describe('fileId coalescing — several subtrees, one file', () => {
  /** Two descriptors over ONE settings.json, addressing disjoint branches. */
  const zedish = () => {
    const a = testAdapter()
    const path = join(work, 'settings.json')
    const mk = (id: string, subtree: string): StoreDescriptor => ({
      id,
      scope: 'user',
      location: { kind: 'file', path, format: 'jsonc' },
      subtree,
      fileId: 'settings-file',
      readable: true,
      writable: true,
      syncable: true,
      provenance: 'verified-fs',
    })
    a.locations = () => [mk('s#agent', 'agent'), mk('s#mcp', 'context_servers')]
    a.read = async (store) => {
      const loc = store.location as { path: string }
      let whole: Record<string, unknown> = {}
      let exists = false
      try {
        whole = JSON.parse(await readFile(loc.path, 'utf8'))
        exists = true
      } catch {
        /* absent */
      }
      const data = store.subtree ? ((whole[store.subtree] as unknown) ?? {}) : whole
      return { storeId: store.id, data, hash: sha256Hex(canonicalJson(data)), exists }
    }
    return a
  }

  it('applies BOTH subtrees — the second must not clobber the first', async () => {
    await writeFile(
      join(work, 'settings.json'),
      JSON.stringify({ agent: { model: 'sonnet' }, context_servers: {}, buffer_font_size: 15 }),
      'utf8',
    )

    const res = await applyPlan(
      planFor([
        { ...change('model', 'opus', 's#agent') },
        { ...change('github.command', 'npx server-github', 's#mcp') },
      ]),
      deps(zedish()),
    )

    expect(res.applied).toHaveLength(2)
    const after = JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))
    // Without coalescing, one of these two would be missing.
    expect(after.agent.model).toBe('opus')
    expect(after.context_servers.github.command).toBe('npx server-github')
    // And the unrelated peer key survives untouched.
    expect(after.buffer_font_size).toBe(15)
  })

  it('writes the file exactly once', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ agent: {}, context_servers: {} }), 'utf8')

    const res = await applyPlan(
      planFor([
        { ...change('model', 'opus', 's#agent') },
        { ...change('gh.command', 'x', 's#mcp') },
      ]),
      deps(zedish()),
    )

    // One backup token per physical file, not per descriptor — otherwise a
    // rollback would restore an intermediate state rather than the original.
    const manifest = JSON.parse(
      await readFile(join(stateDir, 'rollbacks', `${res.rollbackId}.json`), 'utf8'),
    )
    expect(manifest.tokens).toHaveLength(1)
  })

  it('rolls back to the ORIGINAL file, not an intermediate write', async () => {
    const original = JSON.stringify({ agent: { model: 'sonnet' }, context_servers: {} })
    await writeFile(join(work, 'settings.json'), original, 'utf8')

    const res = await applyPlan(
      planFor([
        { ...change('model', 'opus', 's#agent') },
        { ...change('gh.command', 'x', 's#mcp') },
      ]),
      deps(zedish()),
    )
    await rollbackApply(res.rollbackId, deps(zedish()))

    const back = JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))
    expect(back.agent.model).toBe('sonnet')
    expect(back.context_servers).toEqual({})
  })
})

describe('TOCTOU — concurrent writers', () => {
  it('aborts when a FOREIGN writer changes the file mid-apply', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ theme: 'light' }), 'utf8')

    const adapter = testAdapter()
    const realRead = adapter.read.bind(adapter)
    let raced = false
    // Simulate an editor (or Claude Code itself) writing between the staleness
    // read and our write. This is the exact window the last-moment
    // re-fingerprint exists to catch.
    adapter.read = async (store, host, ctx) => {
      const doc = await realRead(store, host, ctx)
      if (!raced) {
        raced = true
        await writeFile(
          join(work, 'settings.json'),
          JSON.stringify({ theme: 'light', addedByOtherProcess: true }),
          'utf8',
        )
      }
      return doc
    }

    await expect(applyPlan(planFor([change('theme', 'dark')]), deps(adapter))).rejects.toThrow(
      StalePlanError,
    )

    // The other process's change must survive untouched.
    const after = JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))
    expect(after.addedByOtherProcess).toBe(true)
    expect(after.theme).toBe('light')
  })

  it('leaves no lock file behind on success', async () => {
    await writeFile(join(work, 'settings.json'), '{}', 'utf8')
    await applyPlan(planFor([change('theme', 'dark')]), deps())
    expect((await readdir(work)).filter((f) => f.includes('lock'))).toEqual([])
  })

  it('leaves no lock file behind when the apply fails', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ a: 1 }), 'utf8')
    const stale = planFor([change('a', 2)], { settings: sha256Hex('nope') })
    await expect(applyPlan(stale, deps())).rejects.toThrow(StalePlanError)
    // A leaked lock would block every later run until it went stale — a worse
    // failure than the one being guarded against.
    expect((await readdir(work)).filter((f) => f.includes('lock'))).toEqual([])
  })

  it('serializes two concurrent applies rather than interleaving them', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ n: 0 }), 'utf8')

    // Both plans were computed against the same original bytes. Exactly one may
    // win; the other must abort rather than silently overwrite the winner.
    const p1 = applyPlan(planFor([change('n', 1)]), deps())
    const p2 = applyPlan(planFor([change('n', 2)]), deps())
    const results = await Promise.allSettled([p1, p2])

    const ok = results.filter((r) => r.status === 'fulfilled')
    expect(ok.length).toBeGreaterThanOrEqual(1)

    // Whatever happened, the file is complete and one of the two values won.
    const after = JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))
    expect([1, 2]).toContain(after.n)
    expect((await readdir(work)).filter((f) => f.includes('lock'))).toEqual([])
  })
})

describe('contradictory changes', () => {
  it('refuses a whole-document replacement mixed with keyed edits', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ a: 1 }), 'utf8')

    // applyChangesToDoc used to let the root win and drop the rest silently, so
    // a plan could report 2 changes, "succeed", and land one.
    const res = await applyPlan(
      planFor([change('', { replaced: true }), change('theme', 'dark')]),
      deps(),
    )

    expect(res.applied).toHaveLength(0)
    expect(res.failed).toHaveLength(2)
    expect(res.failed[0]?.error).toMatch(/ambiguous/i)
    // Nothing written.
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({ a: 1 })
  })

  it('allows a whole-document replacement on its own', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ a: 1 }), 'utf8')
    const res = await applyPlan(planFor([change('', { replaced: true })]), deps())
    expect(res.applied).toHaveLength(1)
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({ replaced: true })
  })

  it('does not penalise a different store in the same plan', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ a: 1 }), 'utf8')
    const adapter = testAdapter([
      {
        id: 'other',
        scope: 'user',
        location: { kind: 'file', path: join(work, 'other.json'), format: 'json' },
        readable: true,
        writable: true,
        syncable: true,
        provenance: 'verified-fs',
      } as StoreDescriptor,
    ])

    const res = await applyPlan(
      planFor([
        change('', { replaced: true }),
        change('theme', 'dark'),
        change('ok', 1, 'other'),
      ]),
      deps(adapter),
    )

    expect(res.failed).toHaveLength(2)
    expect(res.applied.map((c) => c.storeId)).toEqual(['other'])
  })
})

describe('detection gate', () => {
  it('refuses to write config for a tool that is not installed', async () => {
    // provenance says "we believe this path"; detection says "is it even here?"
    // A verified-doc path is writable, so without this gate we would happily
    // create config for software the user does not have.
    const adapter = testAdapter()
    adapter.detect = async () => ({ installed: false, present: [] })

    const res = await applyPlan(planFor([change('theme', 'dark')]), deps(adapter))

    expect(res.applied).toHaveLength(0)
    expect(res.skipped[0]?.skipReason).toMatch(/not installed/i)
    await expect(readFile(join(work, 'settings.json'), 'utf8')).rejects.toThrow()
  })

  it('writes normally when the tool IS installed', async () => {
    await writeFile(join(work, 'settings.json'), '{}', 'utf8')
    const res = await applyPlan(planFor([change('theme', 'dark')]), deps())
    expect(res.applied).toHaveLength(1)
  })

  it('still allows creating a first config file for an installed tool', async () => {
    // "Installed but no settings yet" is a legitimate fresh-install state and
    // must not be confused with "tool absent".
    const adapter = testAdapter()
    adapter.detect = async () => ({ installed: true, present: [] })
    const res = await applyPlan(planFor([change('model', 'opus')]), deps(adapter))
    expect(res.applied).toHaveLength(1)
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({ model: 'opus' })
  })
})

describe("op: 'skip' — report-only changes", () => {
  it('DATA LOSS: reporting a withheld key must not delete it', async () => {
    // Adapters emit op:'skip' so a user can SEE what was withheld. A skip
    // carries no `after`, and undefined maps to a delete edit — so telling
    // someone "we did not sync your token" removed their token.
    await writeFile(
      join(work, 'settings.json'),
      JSON.stringify({ env: { GITHUB_TOKEN: 'ghp_theirs' }, theme: 'dark' }),
      'utf8',
    )

    const res = await applyPlan(
      planFor([
        { ...change('theme', 'light'), op: 'update' },
        { storeId: 'settings', op: 'skip', path: 'env.GITHUB_TOKEN', reason: 'secret', risk: 'none' },
      ]),
      deps(),
    )

    const after = JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))
    expect(after.env.GITHUB_TOKEN).toBe('ghp_theirs')
    expect(after.theme).toBe('light')
    expect(res.skipped.some((s) => s.path === 'env.GITHUB_TOKEN')).toBe(true)
  })

  it('DATA LOSS: a store-level skip must not turn the file into "null"', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ keep: 'me' }), 'utf8')

    const res = await applyPlan(
      planFor([{ storeId: 'settings', op: 'skip', path: '', reason: 'file does not parse', risk: 'none' }]),
      deps(),
    )

    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({ keep: 'me' })
    expect(res.applied).toHaveLength(0)
    expect(res.skipped).toHaveLength(1)
  })
})

describe('contradiction check spans the physical file', () => {
  /** Two stores, disjoint subtrees, ONE settings.json — plus the remainder. */
  const sharedFile = () => {
    const a = testAdapter()
    const path = join(work, 'settings.json')
    a.locations = () =>
      [
        {
          id: 'whole',
          scope: 'user',
          location: { kind: 'file', path, format: 'jsonc' },
          fileId: 'settings-file',
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
        {
          id: 'branch',
          scope: 'user',
          location: { kind: 'file', path, format: 'jsonc' },
          subtree: 'agent',
          fileId: 'settings-file',
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
      ] as StoreDescriptor[]
    a.read = async (store) => {
      const loc = store.location as { path: string }
      let whole: Record<string, unknown> = {}
      let exists = false
      try {
        whole = JSON.parse(await readFile(loc.path, 'utf8'))
        exists = true
      } catch {
        /* absent */
      }
      const data = store.subtree ? ((whole[store.subtree] as unknown) ?? {}) : whole
      return { storeId: store.id, data, hash: sha256Hex(canonicalJson(data)), exists }
    }
    return a
  }

  it('refuses a root replacement and keyed edits on DIFFERENT stores over one file', async () => {
    await writeFile(join(work, 'settings.json'), JSON.stringify({ agent: { model: 'sonnet' } }), 'utf8')

    // Grouping by storeId saw two unrelated stores and waved this through.
    // Phase 3 then coalesced them and the root replacement ate the keyed edit.
    const res = await applyPlan(
      planFor([change('', { replaced: true }, 'whole'), change('model', 'opus', 'branch')]),
      deps(sharedFile()),
    )

    expect(res.applied).toHaveLength(0)
    expect(res.failed).toHaveLength(2)
    expect(res.failed[0]?.error).toMatch(/shares that file|ambiguous/i)
    expect(JSON.parse(await readFile(join(work, 'settings.json'), 'utf8'))).toEqual({
      agent: { model: 'sonnet' },
    })
  })
})

describe('unparseable existing file', () => {
  it('refuses rather than rebuilding it from our model', async () => {
    // The canonical fallback would write our model over content we could not
    // read — and for a subtree store our model is `{}`.
    await writeFile(join(work, 'settings.json'), '{ this is not: valid json at all', 'utf8')
    const original = await readFile(join(work, 'settings.json'), 'utf8')

    await expect(applyPlan(planFor([change('theme', 'dark')]), deps())).rejects.toThrow(
      /not valid JSON/i,
    )
    expect(await readFile(join(work, 'settings.json'), 'utf8')).toBe(original)
  })

  it('still creates a file that is absent or empty', async () => {
    const res = await applyPlan(planFor([change('theme', 'dark')]), deps())
    expect(res.applied).toHaveLength(1)
  })
})

describe('directory stores — authored entries', () => {
  /** `agents/` and `commands/`: flat files the user wrote, no entryFile. */
  const dirAdapter = () => {
    const a = testAdapter()
    a.locations = () =>
      [
        {
          id: 'agents',
          scope: 'user',
          location: { kind: 'dir', path: join(work, 'agents') },
          readable: true,
          writable: true,
          syncable: true,
          provenance: 'verified-fs',
        },
        {
          id: 'skills',
          scope: 'user',
          // entryFile => installed packages, re-resolved from a lockfile
          location: { kind: 'dir', path: join(work, 'skills'), entryFile: 'SKILL.md' },
          readable: true,
          writable: true,
          syncable: false,
          provenance: 'verified-fs',
        },
      ] as StoreDescriptor[]
    a.read = async (store) => ({ storeId: store.id, data: {}, hash: '', exists: false })
    return a
  }

  it('writes each entry as its own file', async () => {
    const res = await applyPlan(
      planFor([
        change('reviewer.md', '# Reviewer\n\nBe strict.\n', 'agents'),
        change('planner.md', '# Planner\n', 'agents'),
      ]),
      deps(dirAdapter()),
    )

    expect(res.applied).toHaveLength(2)
    expect(await readFile(join(work, 'agents', 'reviewer.md'), 'utf8')).toBe('# Reviewer\n\nBe strict.\n')
    expect(await readFile(join(work, 'agents', 'planner.md'), 'utf8')).toBe('# Planner\n')
  })

  it('rolls every entry back together', async () => {
    await mkdir(join(work, 'agents'), { recursive: true })
    await writeFile(join(work, 'agents', 'reviewer.md'), 'original\n', 'utf8')

    const res = await applyPlan(
      planFor([
        change('reviewer.md', 'replaced\n', 'agents'),
        change('planner.md', 'new\n', 'agents'),
      ]),
      deps(dirAdapter()),
    )
    await rollbackApply(res.rollbackId, deps(dirAdapter()))

    expect(await readFile(join(work, 'agents', 'reviewer.md'), 'utf8')).toBe('original\n')
    // The entry that did not exist before must be gone again, not left behind.
    await expect(readFile(join(work, 'agents', 'planner.md'), 'utf8')).rejects.toThrow()
  })

  it('still refuses installed-package directories, with the real reason', async () => {
    const res = await applyPlan(
      planFor([change('gws-gmail', 'x', 'skills')]),
      deps(dirAdapter()),
    )
    expect(res.applied).toHaveLength(0)
    expect(res.skipped[0]?.skipReason).toMatch(/installed from a marketplace/i)
  })

  describe('entry names arrive from another machine, so they are hostile input', () => {
    it.each([
      // Caught by the separator check before the traversal check — both
      // refuse; the separator message is the more specific of the two.
      ['../../.ssh/authorized_keys', /path separator/i],
      ['sub/dir.md', /path separator/i],
      ['..', /escape the directory/i],
      ['', /empty/i],
    ])('refuses %s', async (name, pattern) => {
      const res = await applyPlan(planFor([change(name, 'pwned', 'agents')]), deps(dirAdapter()))
      expect(res.applied).toHaveLength(0)
      expect(res.failed[0]?.error).toMatch(pattern)
    })

    it('does not write anything outside the directory', async () => {
      await applyPlan(
        planFor([change('../escaped.md', 'pwned', 'agents')]),
        deps(dirAdapter()),
      )
      await expect(readFile(join(work, 'escaped.md'), 'utf8')).rejects.toThrow()
    })
  })

  it('deletes an entry only when told to, never by omission', async () => {
    await mkdir(join(work, 'agents'), { recursive: true })
    await writeFile(join(work, 'agents', 'keep.md'), 'keep\n', 'utf8')
    await writeFile(join(work, 'agents', 'drop.md'), 'drop\n', 'utf8')

    const res = await applyPlan(
      planFor([{ ...change('drop.md', undefined, 'agents'), op: 'delete' }]),
      deps(dirAdapter()),
    )

    expect(res.applied).toHaveLength(1)
    await expect(readFile(join(work, 'agents', 'drop.md'), 'utf8')).rejects.toThrow()
    // Absent from the plan is not the same as deleted.
    expect(await readFile(join(work, 'agents', 'keep.md'), 'utf8')).toBe('keep\n')
  })
})
