/**
 * Cursor adapter: the write path, against a real filesystem.
 *
 * Cursor's shape is the opposite of Zed's — many small files rather than one
 * big one — so what needs proving here is different: that a plan spanning
 * several stores writes every one of them, that each gets its own backup and
 * rollback token, and that the one JSONC file in the set (permissions.json)
 * keeps its comments.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { cursorAdapter, STORE } from '../cursor.js'
import { byStore } from '../../core/desired.js'
import type { Change, ConfigDoc, Plan, StoreDescriptor } from '../../core/types.js'
import {
  isolateStateDir,
  makeTempHome,
  observe,
  pathOf,
  readManifest,
  readText,
  samePath,
  storeById,
  writeFixture,
  type TempHome,
} from './harness.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_JSON = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_alreadyonthisdevice" }
    }
  }
}
`

/** [V-doc] reference/permissions is JSONC, and users annotate it heavily. */
const PERMISSIONS_JSONC = `// Cursor CLI permissions. Deny always wins over allow.
{
  "permissions": {
    // Safe enough to run without being asked.
    "allow": ["Read(**)", "Shell(git status)"],
    "deny": ["Shell(rm -rf *)"], // never, under any circumstances
  },
}
`

async function seed(t: TempHome, files: Record<string, string> = {}): Promise<void> {
  const dir = join(t.home, '.cursor')
  const all = { 'mcp.json': MCP_JSON, 'permissions.json': PERMISSIONS_JSONC, ...files }
  for (const [name, contents] of Object.entries(all)) await writeFixture(join(dir, name), contents)
}

function planFrom(observed: ConfigDoc[], changes: Change[]): Plan {
  const baseHashes: Record<string, string> = {}
  for (const doc of observed) baseHashes[doc.storeId] = doc.hash
  return {
    id: 'test-plan-cursor0000',
    deviceId: 'test-device',
    toolId: 'cursor',
    changes,
    baseHashes,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------

describe('cursor adapter', () => {
  let t: TempHome

  beforeEach(async () => {
    isolateStateDir()
    t = await makeTempHome()
  })
  afterEach(async () => {
    await t.cleanup()
  })

  // -------------------------------------------------------------------------
  // read()
  // -------------------------------------------------------------------------

  describe('read()', () => {
    it('carries the bytes as read in ConfigDoc.raw', async () => {
      await seed(t)
      const doc = await cursorAdapter.read(storeById(cursorAdapter, t.host, STORE.userMcp), t.host)

      expect(doc.exists).toBe(true)
      expect(doc.raw).toBeInstanceOf(Uint8Array)
      expect(Buffer.from(doc.raw as Uint8Array).toString('utf8')).toBe(MCP_JSON)
    })

    it('resolves a project-relative store against a ProjectContext, not the cwd', async () => {
      const projectRoot = join(t.home, 'repo')
      const ctx = { projectRoot }
      await writeFixture(join(projectRoot, '.cursor', 'mcp.json'), '{ "mcpServers": {} }\n')

      // Two routes to the same file, and they must agree — apply-engine.ts
      // resolves the descriptor path with `resolveStorePath(path, project)`
      // while nothing in the product passes a context to `read()`.
      const resolved = cursorAdapter
        .locations(t.host, ctx)
        .find((s) => s.id === STORE.projectMcp) as StoreDescriptor
      const relative = cursorAdapter
        .locations(t.host)
        .find((s) => s.id === STORE.projectMcp) as StoreDescriptor

      expect(samePath((resolved.location as { path: string }).path)).toBe(
        samePath(join(projectRoot, '.cursor', 'mcp.json')),
      )
      expect(relative.location).toMatchObject({ path: '.cursor/mcp.json' })

      expect((await cursorAdapter.read(resolved, t.host)).exists).toBe(true)
      expect((await cursorAdapter.read(relative, t.host, ctx)).exists).toBe(true)
      // Without a context the relative path falls back to the process cwd,
      // which is the repository this test runs in — not the fixture.
      expect((await cursorAdapter.read(relative, t.host)).exists).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // apply()
  // -------------------------------------------------------------------------

  describe('apply()', () => {
    it('declares itself able to apply, with the limits spelled out', () => {
      expect(cursorAdapter.capabilities.apply).toBe(true)
      expect(cursorAdapter.capabilities.reason).toMatch(/markdown/i)
      expect(cursorAdapter.capabilities.reason).toMatch(/director(y|ies)/i)
    })

    it('applies changes to two different stores in one plan', async () => {
      await seed(t)
      const mcp = pathOf(cursorAdapter, t.host, STORE.userMcp)
      const permissions = pathOf(cursorAdapter, t.host, STORE.userPermissions)

      const ids = [STORE.userMcp, STORE.userPermissions]
      const observed = await observe(cursorAdapter, t.host, ids)
      const plan = cursorAdapter.plan(
        byStore({
          [STORE.userMcp]: { mcpServers: { github: { command: 'bunx' } } },
          [STORE.userPermissions]: { permissions: { allow: ['Shell(npm test)'] } },
        }),
        observed,
        t.host,
      )

      const result = await cursorAdapter.apply(plan, t.host)

      expect(result.failed).toEqual([])
      expect(result.applied).toHaveLength(2)
      expect(result.applied.map((c) => c.storeId).sort()).toEqual([...ids].sort())

      expect(await readText(mcp)).toContain('"command": "bunx"')

      const perms = await readText(permissions)
      expect(perms).toContain('Shell(npm test)')
      // union-list, so what was already allowed is still allowed.
      expect(perms).toContain('Read(**)')
      expect(perms).toContain('Shell(git status)')

      // Multi-FILE, so two writes and two rollback tokens — the opposite of
      // Zed, where several stores collapse onto one file and must not.
      const manifest = await readManifest(t.host, result.rollbackId)
      expect(manifest.tokens).toHaveLength(2)
      expect(manifest.tokens.map((tok) => samePath(tok.path)).sort()).toEqual(
        [mcp, permissions].map(samePath).sort(),
      )
    })

    it('keeps the comments and trailing commas in permissions.json', async () => {
      await seed(t)
      const permissions = pathOf(cursorAdapter, t.host, STORE.userPermissions)

      const observed = await observe(cursorAdapter, t.host, [STORE.userPermissions])
      const plan = cursorAdapter.plan(
        byStore({ [STORE.userPermissions]: { permissions: { allow: ['Shell(npm test)'] } } }),
        observed,
        t.host,
      )
      await cursorAdapter.apply(plan, t.host)

      const after = await readText(permissions)
      expect(after).toContain('// Cursor CLI permissions. Deny always wins over allow.')
      expect(after).toContain('// Safe enough to run without being asked.')
      expect(after).toContain('// never, under any circumstances')
      // The untouched sibling key keeps its exact bytes, trailing comma and all.
      expect(after).toContain('"deny": ["Shell(rm -rf *)"], // never, under any circumstances')
      expect(after).toContain('  },\n}')
    })

    it('creates a store that does not exist yet on an installed tool', async () => {
      // mcp.json is the detection evidence; sandbox.json is what we create.
      await seed(t)
      const sandbox = pathOf(cursorAdapter, t.host, STORE.userSandbox)

      const observed = await observe(cursorAdapter, t.host, [STORE.userSandbox])
      expect(observed[0]?.exists).toBe(false)

      const plan = cursorAdapter.plan(
        byStore({ [STORE.userSandbox]: { type: 'workspace_readwrite' } }),
        observed,
        t.host,
      )
      const result = await cursorAdapter.apply(plan, t.host)

      expect(result.failed).toEqual([])
      expect(JSON.parse(await readText(sandbox))).toEqual({ type: 'workspace_readwrite' })
    })

    it('refuses a plan for a tool that is not installed, and writes nothing', async () => {
      // Linux: Cursor documents no canonical install root there, so detection
      // rests entirely on config files — none of which exist in this temp home.
      const host = { ...t.host, os: 'linux' as const }
      const mcp = pathOf(cursorAdapter, host, STORE.userMcp)

      const plan = planFrom([], [
        {
          storeId: STORE.userMcp,
          op: 'create',
          path: 'mcpServers.github.url',
          after: 'https://example.test/mcp',
          reason: 'test',
          risk: 'elevated',
        },
      ])

      const result = await cursorAdapter.apply(plan, host)

      expect(result.applied).toEqual([])
      expect(result.skipped[0]?.skipReason).toMatch(/not installed on this device/i)
      await expect(stat(mcp)).rejects.toThrow()
    })

    it('skips directory stores and fails markdown stores rather than mangling them', async () => {
      await seed(t)
      const observed = await observe(cursorAdapter, t.host, [STORE.userMcp])

      const plan = planFrom(observed, [
        {
          storeId: STORE.userSkills, //  a dir store
          op: 'create',
          path: 'demo/SKILL.md',
          after: { path: 'demo/SKILL.md', frontmatter: {}, body: '# demo' },
          reason: 'test',
          risk: 'code-execution',
        },
        {
          storeId: STORE.projectAgentsMd, //  a markdown store, addressed by key
          op: 'update',
          path: 'body',
          after: '# rules',
          reason: 'test',
          risk: 'none',
        },
      ])

      const result = await cursorAdapter.apply(plan, t.host)

      expect(result.applied).toEqual([])
      // Directory stores are no longer refused wholesale. `cursor:user:skills`
      // is an INSTALLED-package store (`entryFile: SKILL.md`), which is still
      // refused — but now for the true reason: those are re-resolved per device
      // from a lockfile, so copying the tree would fight the installer.
      // Authored directories (sub-agents, slash commands) do write now.
      expect(result.skipped[0]?.skipReason).toMatch(/installed from a marketplace/i)
      expect(result.failed[0]?.error).toMatch(/markdown file and has no key "body"/i)
      // Nothing was written, and in particular no AGENTS.md was created in the
      // repository this test happens to be running from.
      expect(result.rollbackId).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // Report-only changes
  // -------------------------------------------------------------------------

  describe('report-only changes', () => {
    it('reports a never-sync secret as skipped WITHOUT deleting it from the file', async () => {
      await seed(t)
      const mcp = pathOf(cursorAdapter, t.host, STORE.userMcp)
      const before = await readText(mcp)

      const observed = await observe(cursorAdapter, t.host, [STORE.userMcp])
      const plan = cursorAdapter.plan(
        byStore({
          [STORE.userMcp]: {
            mcpServers: { github: { env: { GITHUB_TOKEN: 'ghp_fromanotherdevice' } } },
          },
        }),
        observed,
        t.host,
      )
      expect(plan.changes.every((c) => c.op === 'skip')).toBe(true)

      const result = await cursorAdapter.apply(plan, t.host)

      // `after` is undefined on a skip, and an undefined value in the JSONC
      // writer means "remove this key" — so a report about a secret we would
      // not sync must never reach the engine as a change.
      expect(result.applied).toEqual([])
      expect(result.skipped.map((c) => c.path)).toContain('mcpServers.github.env.GITHUB_TOKEN')
      expect(await readText(mcp)).toBe(before)
      expect(await readText(mcp)).toContain('ghp_alreadyonthisdevice')
    })
  })

  // -------------------------------------------------------------------------
  // Rollback
  // -------------------------------------------------------------------------

  describe('rollback()', () => {
    it('restores every file in the apply to its original bytes', async () => {
      await seed(t)
      const mcp = pathOf(cursorAdapter, t.host, STORE.userMcp)
      const permissions = pathOf(cursorAdapter, t.host, STORE.userPermissions)
      const originals = { mcp: await readFile(mcp), permissions: await readFile(permissions) }

      const observed = await observe(cursorAdapter, t.host, [STORE.userMcp, STORE.userPermissions])
      const plan = cursorAdapter.plan(
        byStore({
          [STORE.userMcp]: { mcpServers: { github: { command: 'bunx' } } },
          [STORE.userPermissions]: { permissions: { allow: ['Shell(npm test)'] } },
        }),
        observed,
        t.host,
      )
      const result = await cursorAdapter.apply(plan, t.host)
      expect(await readText(mcp)).not.toBe(originals.mcp.toString('utf8'))

      await cursorAdapter.rollback(result.rollbackId, t.host)

      expect((await readFile(mcp)).equals(originals.mcp)).toBe(true)
      expect((await readFile(permissions)).equals(originals.permissions)).toBe(true)
      expect(await readText(permissions)).toContain('// never, under any circumstances')
    })
  })

  // -------------------------------------------------------------------------
  // Staleness
  // -------------------------------------------------------------------------

  describe('staleness', () => {
    it('aborts the whole apply when one file moved, leaving the other alone', async () => {
      await seed(t)
      const mcp = pathOf(cursorAdapter, t.host, STORE.userMcp)
      const permissions = pathOf(cursorAdapter, t.host, STORE.userPermissions)

      const observed = await observe(cursorAdapter, t.host, [STORE.userMcp, STORE.userPermissions])
      const plan = cursorAdapter.plan(
        byStore({
          [STORE.userMcp]: { mcpServers: { github: { command: 'bunx' } } },
          [STORE.userPermissions]: { permissions: { allow: ['Shell(npm test)'] } },
        }),
        observed,
        t.host,
      )

      await writeFixture(permissions, PERMISSIONS_JSONC.replace('Read(**)', 'Read(src/**)'))
      const interloper = await readText(permissions)
      const mcpBefore = await readText(mcp)

      await expect(cursorAdapter.apply(plan, t.host)).rejects.toThrow(/changed on disk/i)

      // All-or-nothing: the store that did NOT move is not written either.
      expect(await readText(permissions)).toBe(interloper)
      expect(await readText(mcp)).toBe(mcpBefore)
    })
  })
})
