/**
 * Zed adapter: subtree reads and the write path, against a real filesystem.
 *
 * Zed is the hard case in the survey and every test here is aimed at a way it
 * could go wrong in a user's home directory rather than at line coverage:
 *
 *   - ONE settings.json carries ten concepts as peer top-level keys, so a
 *     subtree read that returns the whole document makes every store report
 *     identical data and every plan built from it wrong;
 *   - that same file is the most comment-dense config of any tool we sync, so a
 *     write that round-trips through JSON.stringify silently deletes a user's
 *     annotations;
 *   - two changes to two different subtrees are two stores but ONE file, and
 *     writing per store means the second write clobbers the first.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { zedAdapter, STORE } from '../zed.js'
import { byStore } from '../../core/desired.js'
import type { Change, ConfigDoc, DesiredState, Plan } from '../../core/types.js'
import {
  backupCount,
  isolateStateDir,
  makeTempHome,
  observe,
  pathOf,
  readManifest,
  readText,
  storeById,
  writeFixture,
  type TempHome,
} from './harness.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A settings.json written the way Zed's own docs teach people to write one:
 * line comments, a block comment, blank lines between sections, a
 * commented-out example kept for later, and trailing commas throughout.
 *
 * Every one of those is user data we were never asked to touch.
 */
const ANNOTATED_SETTINGS = `// Zed settings. See https://zed.dev/docs/configuring-zed
{
  // Big enough to read on the couch.
  "buffer_font_size": 14,

  /* Agent configuration.
     Kept as a block comment on purpose — the parser has to handle both. */
  "agent": {
    "default_model": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5" // pinned deliberately, do not float
    },
  },

  "context_servers": {
    "github": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
    },
  },

  // Do NOT turn this on, it fights my muscle memory.
  // "vim_mode": true,

  "theme": "One Dark",
}
`

const ANNOTATED_KEYMAP = `// Keymap is a top-level ARRAY, not an object.
[
  {
    "context": "Editor",
    "bindings": {
      "cmd-k": "editor::Cancel" // legacy binding
    }
  }
]
`

const SETTINGS_STORE = (subtree: string): string => `${STORE.userSettings}#${subtree}`

/**
 * Lay down `~/.config/zed/*`. settings.json is always written — it is both the
 * subject of most of these tests and the evidence `detect()` needs, since the
 * write path now refuses a tool it cannot find on the device.
 */
async function seed(t: TempHome, files: Record<string, string> = {}): Promise<void> {
  const cfg = join(t.home, '.config', 'zed')
  for (const [name, contents] of Object.entries({ 'settings.json': ANNOTATED_SETTINGS, ...files })) {
    await writeFixture(join(cfg, name), contents)
  }
}

/** A plan the engine will accept, with base hashes taken from `observed`. */
function planFrom(observed: ConfigDoc[], changes: Change[]): Plan {
  const baseHashes: Record<string, string> = {}
  for (const doc of observed) baseHashes[doc.storeId] = doc.hash
  return {
    id: 'test-plan-000000000000',
    deviceId: 'test-device',
    toolId: 'zed',
    changes,
    baseHashes,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------

describe('zed adapter', () => {
  let t: TempHome

  beforeEach(async () => {
    isolateStateDir()
    t = await makeTempHome()
  })
  afterEach(async () => {
    await t.cleanup()
  })

  // -------------------------------------------------------------------------
  // read(): subtree addressing
  // -------------------------------------------------------------------------

  describe('read() honors store.subtree', () => {
    it('returns ONLY the branch a descriptor owns, not the whole document', async () => {
      await seed(t)

      const agent = await zedAdapter.read(storeById(zedAdapter, t.host, SETTINGS_STORE('agent')), t.host)
      const servers = await zedAdapter.read(
        storeById(zedAdapter, t.host, SETTINGS_STORE('context_servers')),
        t.host,
      )

      expect(agent.data).toEqual({
        default_model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      })
      expect(servers.data).toEqual({
        github: {
          source: 'custom',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      })
      // The whole-document leak this test exists to catch: neither branch may
      // contain a peer key that belongs to a different store.
      expect(agent.data).not.toHaveProperty('theme')
      expect(agent.data).not.toHaveProperty('context_servers')
      expect(servers.data).not.toHaveProperty('buffer_font_size')
    })

    it('hashes only the subtree, so ten stores over one file do not share a hash', async () => {
      await seed(t)

      const ids = ['agent', 'context_servers', 'theme', 'buffer_font_size'].map(SETTINGS_STORE)
      const docs = await observe(zedAdapter, t.host, ids)
      const hashes = docs.map((d) => d.hash)

      expect(new Set(hashes).size).toBe(hashes.length)
      expect(hashes.every((h) => h.length === 64)).toBe(true)
    })

    it('a change to one subtree does not move a sibling subtree hash', async () => {
      await seed(t)
      const ids = [SETTINGS_STORE('agent'), SETTINGS_STORE('theme')]
      const [agentBefore, themeBefore] = await observe(zedAdapter, t.host, ids)

      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('agent'))
      await writeFixture(settings, (await readText(settings)).replace('"One Dark"', '"Ayu Dark"'))

      const [agentAfter, themeAfter] = await observe(zedAdapter, t.host, ids)

      // This is the whole reason the hash is per-subtree: an editor-appearance
      // change must not make the MCP/agent stores report drift.
      expect(agentAfter?.hash).toBe(agentBefore?.hash)
      expect(themeAfter?.hash).not.toBe(themeBefore?.hash)
    })

    it('reports a subtree that is absent from the file as empty, not as a missing file', async () => {
      await seed(t)
      const doc = await zedAdapter.read(storeById(zedAdapter, t.host, SETTINGS_STORE('lsp')), t.host)

      expect(doc.exists).toBe(true) // the FILE is there
      expect(doc.data).toEqual({}) // the BRANCH is not
    })

    it('reports a missing file as absent for every descriptor over it', async () => {
      const doc = await zedAdapter.read(storeById(zedAdapter, t.host, SETTINGS_STORE('agent')), t.host)
      expect(doc.exists).toBe(false)
      expect(doc.hash).toBe('')
    })

    it('carries the whole file bytes in ConfigDoc.raw, even for a subtree store', async () => {
      await seed(t)
      const doc = await zedAdapter.read(storeById(zedAdapter, t.host, SETTINGS_STORE('agent')), t.host)

      expect(doc.raw).toBeInstanceOf(Uint8Array)
      // A branch of a document has no byte range of its own, so `raw` is the
      // whole file — which is what a format-preserving write is computed from.
      expect(Buffer.from(doc.raw as Uint8Array).toString('utf8')).toBe(ANNOTATED_SETTINGS)
    })

    it('hands the parse-error marker to every descriptor when the file does not parse', async () => {
      await seed(t, { 'settings.json': '{ "agent": { unquoted } }' })

      const agent = await zedAdapter.read(storeById(zedAdapter, t.host, SETTINGS_STORE('agent')), t.host)
      const remainder = await zedAdapter.read(storeById(zedAdapter, t.host, STORE.userSettings), t.host)

      // A subtree store must not report a healthy empty branch of a file we
      // could not read at all — plan() refuses to write on this marker.
      expect(agent.data).toHaveProperty('__parseError')
      expect(remainder.data).toHaveProperty('__parseError')
    })
  })

  // -------------------------------------------------------------------------
  // plan(): subtree-relative paths, whole-document rules
  // -------------------------------------------------------------------------

  describe('plan() over a subtree store', () => {
    it('emits subtree-RELATIVE paths, because that is what apply() rebases from', async () => {
      await seed(t)
      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('context_servers')])
      const plan = zedAdapter.plan(
        byStore({ [SETTINGS_STORE('context_servers')]: { github: { command: 'bunx' } } }),
        observed,
        t.host,
      )

      const change = plan.changes.find((c) => c.op === 'update')
      expect(change?.path).toBe('github.command')
      expect(change?.storeId).toBe(SETTINGS_STORE('context_servers'))
    })

    it('still classifies risk and never-sync rules against the WHOLE-document path', async () => {
      await seed(t)
      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('context_servers')])
      const plan = zedAdapter.plan(
        byStore({
          [SETTINGS_STORE('context_servers')]: {
            github: { command: 'bunx', env: { GITHUB_TOKEN: 'ghp_realtoken' } },
          },
        }),
        observed,
        t.host,
      )

      // `context_servers.*.command` spawns a process. Read with the relative
      // path 'github.command' the rule table matches only `**` and this comes
      // back 'none' — under-reporting code execution to the approval gate.
      const command = plan.changes.find((c) => c.path === 'github.command')
      expect(command?.risk).toBe('code-execution')

      // Same for `context_servers.*.env.**`: never-sync, and the credential
      // must not be carried.
      const env = plan.changes.find((c) => c.path === 'github.env.GITHUB_TOKEN')
      expect(env?.op).toBe('skip')
      expect(env?.after).toBeUndefined()
      expect(JSON.stringify(plan)).not.toContain('ghp_realtoken')
    })
  })

  // -------------------------------------------------------------------------
  // apply(): the write path
  // -------------------------------------------------------------------------

  describe('apply()', () => {
    it('declares itself able to apply, with the limits spelled out', () => {
      expect(zedAdapter.capabilities.apply).toBe(true)
      expect(zedAdapter.capabilities.reason).toMatch(/markdown/i)
      expect(zedAdapter.capabilities.reason).toMatch(/untrusted worktree/i)
    })

    it('preserves comments, blank lines and trailing commas', async () => {
      await seed(t)
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('agent'))

      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('agent')])
      const plan = zedAdapter.plan(
        byStore({ [SETTINGS_STORE('agent')]: { default_model: { model: 'claude-opus-4-5' } } }),
        observed,
        t.host,
      )
      const result = await zedAdapter.apply({ ...plan, createdAt: '2026-07-29T00:00:00.000Z' }, t.host)

      expect(result.failed).toEqual([])
      expect(result.applied).toHaveLength(1)

      const after = await readText(settings)

      // The change landed…
      expect(after).toContain('"claude-opus-4-5"')
      expect(after).not.toContain('claude-sonnet-4-5')

      // …and nothing else in the file moved.
      expect(after).toContain('// Zed settings. See https://zed.dev/docs/configuring-zed')
      expect(after).toContain('// Big enough to read on the couch.')
      expect(after).toContain('/* Agent configuration.')
      expect(after).toContain('the parser has to handle both. */')
      expect(after).toContain('// pinned deliberately, do not float')
      expect(after).toContain('// Do NOT turn this on, it fights my muscle memory.')
      expect(after).toContain('// "vim_mode": true,')
      // Trailing commas survive because those bytes are never rewritten.
      expect(after).toContain('},\n  },\n\n  "context_servers"')
      expect(after).toContain('"theme": "One Dark",\n}')
      // Blank line between sections.
      expect(after).toMatch(/"buffer_font_size": 14,\n\n {2}\/\* Agent configuration\./)
    })

    it('coalesces two subtrees of one file into ONE write, and both land', async () => {
      await seed(t)
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('agent'))

      const ids = [SETTINGS_STORE('agent'), SETTINGS_STORE('context_servers')]
      const observed = await observe(zedAdapter, t.host, ids)
      const plan = zedAdapter.plan(
        byStore({
          [SETTINGS_STORE('agent')]: { default_model: { model: 'claude-opus-4-5' } },
          [SETTINGS_STORE('context_servers')]: { github: { command: 'bunx' } },
        }),
        observed,
        t.host,
      )

      expect(plan.changes.filter((c) => c.op === 'update')).toHaveLength(2)

      const result = await zedAdapter.apply(plan, t.host)
      expect(result.failed).toEqual([])
      expect(result.applied).toHaveLength(2)

      const after = await readText(settings)

      // BOTH changes are present. Written per STORE instead of per FILE, the
      // second read-modify-write would have started from the pre-edit bytes and
      // the first change would be gone.
      expect(after).toContain('"claude-opus-4-5"')
      expect(after).toContain('"command": "bunx"')

      // One physical write: one backup, one rollback token.
      expect(await backupCount(settings)).toBe(1)
      const manifest = await readManifest(t.host, result.rollbackId)
      expect(manifest.tokens).toHaveLength(1)
      expect(manifest.tokens[0]?.path).toBe(settings)

      // The unrelated peer key — a different store over the same file, not in
      // this plan — is untouched, comment and all.
      expect(after).toContain('// Big enough to read on the couch.\n  "buffer_font_size": 14,')
      expect(after).toContain('"theme": "One Dark",')
    })

    it('rebases a subtree path onto the whole document', async () => {
      await seed(t)
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('context_servers'))
      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('context_servers')])

      // A change at `github.command` in a store with subtree `context_servers`
      // must land at `context_servers.github.command` in the file — and must
      // NOT create a top-level `github` key.
      const plan = planFrom(observed, [
        {
          storeId: SETTINGS_STORE('context_servers'),
          op: 'update',
          path: 'github.command',
          after: 'bunx',
          reason: 'test',
          risk: 'code-execution',
        },
      ])

      await zedAdapter.apply(plan, t.host)

      // Read the file back through the descriptor that owns the WHOLE document
      // (`zed:user:settings`, the unclaimed remainder — it has no subtree).
      const whole = (await zedAdapter.read(storeById(zedAdapter, t.host, STORE.userSettings), t.host))
        .data as Record<string, Record<string, Record<string, unknown>>>

      expect(whole['context_servers']?.['github']?.['command']).toBe('bunx')
      // The failure this guards against: writing `github.command` at the TOP
      // level, next to `theme`, instead of inside `context_servers`.
      expect(whole).not.toHaveProperty('github')
      expect(await readText(settings)).toContain('"command": "bunx"')
    })

    it('creates settings.json when the tool is installed but has no config yet', async () => {
      // Detection evidence that is NOT the file we are about to write.
      await writeFixture(join(t.home, '.config', 'zed', 'keymap.json'), '[]\n')

      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('context_servers'))
      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('context_servers')])
      const plan = zedAdapter.plan(
        byStore({ [SETTINGS_STORE('context_servers')]: { github: { url: 'https://example.test/mcp' } } }),
        observed,
        t.host,
      )

      const result = await zedAdapter.apply(plan, t.host)
      expect(result.failed).toEqual([])
      expect(result.applied).toHaveLength(1)

      // A whole-store create is rebased to the subtree, so it writes
      // `{ "context_servers": { … } }` and not a bare `{ "github": … }`.
      const written = JSON.parse(await readText(settings)) as Record<string, unknown>
      expect(written).toEqual({ context_servers: { github: { url: 'https://example.test/mcp' } } })
    })

    it('refuses a plan for a tool that is not installed, and writes nothing', async () => {
      // A LINUX host on purpose: Zed's macOS install probe hits the absolute
      // `/Applications/Zed.app`, so on a developer machine that happens to have
      // Zed this test would be asserting the wrong thing. Linux's probes are
      // home-relative apart from `/usr/bin/zed`, and the config root is the
      // same `~/.config/zed`.
      const host = { ...t.host, os: 'linux' as const }
      // No fixture at all: nothing under ~/.config/zed.
      const settings = pathOf(zedAdapter, host, SETTINGS_STORE('context_servers'))
      const plan = planFrom([], [
        {
          storeId: SETTINGS_STORE('context_servers'),
          op: 'create',
          path: 'github.url',
          after: 'https://example.test/mcp',
          reason: 'test',
          risk: 'elevated',
        },
      ])

      const result = await zedAdapter.apply(plan, host)

      expect(result.applied).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0]?.skipReason).toMatch(/not installed on this device/i)
      await expect(stat(settings)).rejects.toThrow()
    })

    it('does not count the shared ~/.agents tree as evidence that Zed is installed', async () => {
      const host = { ...t.host, os: 'linux' as const }
      await writeFixture(join(t.home, '.agents', 'skills', 'demo', 'SKILL.md'), '# demo\n')
      const detection = await zedAdapter.detect(host)

      // `~/.agents/skills` is the cross-tool Agent Skills directory. Claiming
      // Zed on the strength of it would gate a write on nothing at all.
      expect(detection.present).toContain(STORE.userSkills)
      expect(detection.installed).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Array-rooted documents
  // -------------------------------------------------------------------------

  describe('array-rooted stores (keymap.json / tasks.json)', () => {
    it('replaces the whole document and keeps the comments around it', async () => {
      await seed(t, { 'keymap.json': ANNOTATED_KEYMAP })
      const keymap = pathOf(zedAdapter, t.host, STORE.userKeymap)

      const observed = await observe(zedAdapter, t.host, [STORE.userKeymap])
      expect(observed[0]?.data).toEqual([
        { context: 'Editor', bindings: { 'cmd-k': 'editor::Cancel' } },
      ])

      // `byStore`'s type is Record<string, Record<string, unknown>>, which
      // cannot express an array-rooted desired document — Zed has two of them.
      // The cast is the finding, not a shortcut.
      const desired = byStore({
        [STORE.userKeymap]: [
          { context: 'Editor', bindings: { 'cmd-k': 'editor::Cancel', 'cmd-p': 'file_finder::Toggle' } },
        ] as unknown as Record<string, unknown>,
      }) as DesiredState

      const plan = zedAdapter.plan(desired, observed, t.host)
      const change = plan.changes.find((c) => c.storeId === STORE.userKeymap)
      expect(change?.op).toBe('update')
      expect(change?.path).toBe('') // whole document: arrays have no dot paths

      const result = await zedAdapter.apply(plan, t.host)
      expect(result.failed).toEqual([])
      expect(result.applied).toHaveLength(1)

      const after = await readText(keymap)
      expect(after).toContain('file_finder::Toggle')
      // The banner comment sits outside the root value's span, so it survives a
      // whole-document replacement.
      expect(after).toContain('// Keymap is a top-level ARRAY, not an object.')
    })

    it('refuses a keyed change against an array root and leaves the file byte-identical', async () => {
      await seed(t, { 'keymap.json': ANNOTATED_KEYMAP })
      const keymap = pathOf(zedAdapter, t.host, STORE.userKeymap)
      const before = await readText(keymap)

      const observed = await observe(zedAdapter, t.host, [STORE.userKeymap])
      const plan = planFrom(observed, [
        {
          storeId: STORE.userKeymap,
          op: 'update',
          // Meaningless against an array root, and the reconcile engine would
          // never emit it — but a hand-built or stale plan can.
          path: 'bindings.cmd-k',
          after: 'editor::Nothing',
          reason: 'test',
          risk: 'none',
        },
      ])

      await expect(zedAdapter.apply(plan, t.host)).rejects.toThrow(/document root is a array|not an object/i)
      expect(await readText(keymap)).toBe(before)
    })
  })

  // -------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------

  describe('provenance gate', () => {
    /**
     * There is no `inferred` FILE store anywhere in the POSIX Zed table — the
     * one that exists is `zed:user:tasks` on NATIVE Windows, where tasks.md
     * only ever prints the `~/.config/zed` form. So this test drives the
     * Windows table while running on a POSIX filesystem, which is fine because
     * the whole point is that nothing is written.
     *
     * Detection now gates the write too, and it runs FIRST, so the fixture has
     * to make Zed look installed or we would be asserting the wrong refusal.
     *
     * This used to use a repo-relative `.rules` plus a chdir. That no longer
     * works, and correctly so: project-scope files carry no install weight now,
     * because counting them made `detect()` answer differently depending on the
     * working directory — same machine, different answer, gating writes. A
     * user-scope config file is the honest signal, and it needs no chdir.
     */
    it('refuses to write a path we only inferred, and creates nothing', async () => {
      const cwd = process.cwd()
      try {
        const host = { ...t.host, os: 'windows' as const, runtime: 'native' as const }
        const settings = storeById(zedAdapter, host, STORE.userSettings)
        if (settings.location.kind === 'file') {
          await writeFixture(settings.location.path, '{}\n')
        }

        const detection = await zedAdapter.detect(host)
        expect(detection.installed).toBe(true)
        // Only a file we can write ourselves vouches for it, so say so.
        expect(detection.confidence).toBe('weak')

        const tasks = storeById(zedAdapter, host, STORE.userTasks)
        expect(tasks.provenance).toBe('inferred')

        const plan = planFrom([], [
          {
            storeId: STORE.userTasks,
            op: 'create',
            path: '',
            after: [{ label: 'build', command: 'cargo build' }],
            reason: 'test',
            risk: 'code-execution',
          },
        ])

        const result = await zedAdapter.apply(plan, host)

        expect(result.applied).toEqual([])
        expect(result.rollbackId).toBe('')
        expect(result.skipped[0]?.skipReason).toMatch(/unverified|only inferred/i)

        const target = tasks.location.kind === 'file' ? tasks.location.path : ''
        await expect(stat(target)).rejects.toThrow()
        // The settings fixture that established detection is untouched — the
        // refusal wrote nothing at all, not just nothing to the inferred path.
        if (settings.location.kind === 'file') {
          expect(await readFile(settings.location.path, 'utf8')).toBe('{}\n')
        }
      } finally {
        process.chdir(cwd)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Report-only changes must never mutate the file
  // -------------------------------------------------------------------------

  describe('report-only changes', () => {
    it('reports a never-sync key as skipped WITHOUT deleting it from the file', async () => {
      await seed(
        t,
        {
          'settings.json': `{
  // Token lives here because the user put it here.
  "context_servers": {
    "github": {
      "command": "npx",
      "env": { "GITHUB_TOKEN": "ghp_alreadyonthisdevice" }
    }
  }
}
`,
        },
      )
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('context_servers'))
      const before = await readText(settings)

      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('context_servers')])
      const plan = zedAdapter.plan(
        byStore({
          [SETTINGS_STORE('context_servers')]: { github: { env: { GITHUB_TOKEN: 'ghp_fromanotherdevice' } } },
        }),
        observed,
        t.host,
      )
      expect(plan.changes.every((c) => c.op === 'skip')).toBe(true)

      const result = await zedAdapter.apply(plan, t.host)

      // Reported, not written, and above all not DELETED. `after` is undefined
      // on a skip, and an undefined value in the JSONC writer means "remove".
      expect(result.applied).toEqual([])
      expect(result.skipped.map((c) => c.path)).toContain('github.env.GITHUB_TOKEN')
      expect(await readText(settings)).toBe(before)
    })
  })

  // -------------------------------------------------------------------------
  // Rollback
  // -------------------------------------------------------------------------

  describe('rollback()', () => {
    it('restores the original bytes exactly, comments included', async () => {
      await seed(t)
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('agent'))
      const original = await readFile(settings)

      const ids = [SETTINGS_STORE('agent'), SETTINGS_STORE('context_servers')]
      const observed = await observe(zedAdapter, t.host, ids)
      const plan = zedAdapter.plan(
        byStore({
          [SETTINGS_STORE('agent')]: { default_model: { model: 'claude-opus-4-5' } },
          [SETTINGS_STORE('context_servers')]: { github: { command: 'bunx' } },
        }),
        observed,
        t.host,
      )

      const result = await zedAdapter.apply(plan, t.host)
      expect(await readText(settings)).not.toBe(original.toString('utf8'))

      await zedAdapter.rollback(result.rollbackId, t.host)

      const restored = await readFile(settings)
      expect(restored.equals(original)).toBe(true)
      expect(restored.toString('utf8')).toContain('// pinned deliberately, do not float')
    })

    it('rolls a created file back out of existence', async () => {
      await writeFixture(join(t.home, '.config', 'zed', 'keymap.json'), '[]\n')
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('context_servers'))

      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('context_servers')])
      const plan = zedAdapter.plan(
        byStore({ [SETTINGS_STORE('context_servers')]: { github: { url: 'https://example.test/mcp' } } }),
        observed,
        t.host,
      )
      const result = await zedAdapter.apply(plan, t.host)
      await expect(stat(settings)).resolves.toBeTruthy()

      await zedAdapter.rollback(result.rollbackId, t.host)
      await expect(stat(settings)).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Staleness
  // -------------------------------------------------------------------------

  describe('staleness', () => {
    it('aborts when the file moved under a plan, and leaves it alone', async () => {
      await seed(t)
      const settings = pathOf(zedAdapter, t.host, SETTINGS_STORE('agent'))

      const observed = await observe(zedAdapter, t.host, [SETTINGS_STORE('agent')])
      const plan = zedAdapter.plan(
        byStore({ [SETTINGS_STORE('agent')]: { default_model: { model: 'claude-opus-4-5' } } }),
        observed,
        t.host,
      )

      // Someone else edits the same subtree between plan and apply.
      await writeFixture(
        settings,
        (await readText(settings)).replace('claude-sonnet-4-5', 'claude-haiku-4-5'),
      )
      const interloper = await readText(settings)

      await expect(zedAdapter.apply(plan, t.host)).rejects.toThrow(/changed on disk/i)
      expect(await readText(settings)).toBe(interloper)
    })
  })
})
