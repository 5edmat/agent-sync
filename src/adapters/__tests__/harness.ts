/**
 * Test harness for the adapter apply tests.
 *
 * Everything here works against a REAL filesystem in a real temp directory.
 * Mocking `fs` for these tests would test nothing that matters: the whole point
 * of `apply()` is the interaction between JSONC byte-span editing, atomic
 * temp+rename, advisory locking, backup files and a rollback manifest. A fake
 * fs would happily "pass" while the real one lost a user's comments.
 *
 * Not named `*.test.ts` so vitest does not collect it as a suite.
 */

import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { ConfigDoc, HostEnv, StoreDescriptor, ToolAdapter } from '../../core/types.js'

/**
 * A host whose `home` is a temp directory.
 *
 * `home` is load-bearing beyond the path table: `resolveStateDir` derives the
 * rollback-manifest directory from it, so pointing it at a temp dir is what
 * keeps an apply test from writing into the developer's real state directory.
 */
export function makeHost(home: string, over: Partial<HostEnv> = {}): HostEnv {
  const base: HostEnv = {
    os: 'macos',
    runtime: 'native',
    arch: 'arm64',
    home,
    supportsSymlinks: true,
    hasKeyring: true,
    supportsLongPaths: true,
    shell: 'zsh',
    deviceId: '11111111-2222-4333-8444-555555555555',
  }
  return { ...base, ...over }
}

export interface TempHome {
  /** Realpath'd, because macOS hands out /var/... symlinks to /private/var/... */
  home: string
  host: HostEnv
  cleanup: () => Promise<void>
}

export async function makeTempHome(over: Partial<HostEnv> = {}): Promise<TempHome> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agentsync-adapter-')))
  return {
    home: dir,
    host: makeHost(dir, over),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Write a fixture file, creating its parents. */
export async function writeFixture(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

export const readText = (path: string): Promise<string> => readFile(path, 'utf8')

/**
 * Compare paths as filesystem identities rather than as strings.
 *
 * These tests deliberately pin `HostEnv.os` to macOS so the expected path table
 * is one a reader can hold in their head, then point it at a real temp
 * directory. On Windows that means the table is `/`-joined onto a `C:\...` home
 * — `C:\Users\…\Temp\x/.cursor/mcp.json`. Windows opens that file perfectly
 * happily, which is why every behavioural assertion in these files passes there;
 * what it is *not* is string-equal to the all-backslash form `path.resolve`
 * returns, and `withBackup()` resolves before recording a rollback token's path.
 *
 * So the mismatch is between a macOS-shaped fixture and a Windows filesystem,
 * not a defect in either the token or the table. Normalizing both sides keeps
 * the assertion exactly as strong — "the rollback token names this file" — and
 * drops only the separator spelling, which is not what the test is about.
 */
export const samePath = (p: string): string => resolve(p)

export async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

export function storeById(adapter: ToolAdapter, host: HostEnv, id: string): StoreDescriptor {
  const store = adapter.locations(host).find((s) => s.id === id)
  if (!store) throw new Error(`no such store "${id}" in the ${adapter.id} table`)
  return store
}

/** Absolute path of a file-kind store. Throws for the other location kinds. */
export function pathOf(adapter: ToolAdapter, host: HostEnv, id: string): string {
  const loc = storeById(adapter, host, id).location
  if (loc.kind !== 'file' && loc.kind !== 'dir') throw new Error(`"${id}" is a ${loc.kind} store`)
  return loc.path
}

/** Read the given stores, in order — this is what `plan()` wants as `observed`. */
export async function observe(
  adapter: ToolAdapter,
  host: HostEnv,
  ids: string[],
): Promise<ConfigDoc[]> {
  const docs: ConfigDoc[] = []
  for (const id of ids) docs.push(await adapter.read(storeById(adapter, host, id), host))
  return docs
}

/**
 * How many backup files exist beside `filePath`.
 *
 * This is the direct measure of "how many times was this file written": the
 * engine takes exactly one backup per write, inside the lock, immediately
 * before the rename.
 */
export async function backupCount(filePath: string): Promise<number> {
  try {
    return (await readdir(join(dirname(filePath), '.agent-backups'))).length
  } catch {
    return 0
  }
}

/**
 * `stateDir()` honors an `AGENTSYNC_STATE_DIR` env override before it looks at
 * `host.home`. A developer with that exported would send rollback manifests
 * somewhere outside the temp dir and these tests would read the wrong file.
 */
export function isolateStateDir(): void {
  delete process.env['AGENTSYNC_STATE_DIR']
}

export interface RollbackManifestShape {
  v: number
  rollbackId: string
  planId: string
  tokens: Array<{ path: string; existed: boolean }>
}

/** The manifest `applyPlan` persisted, read back from the temp state dir. */
export async function readManifest(
  host: HostEnv,
  rollbackId: string,
): Promise<RollbackManifestShape> {
  const file = join(
    host.home,
    'Library',
    'Application Support',
    'agentsync',
    'rollbacks',
    `${rollbackId}.json`,
  )
  return JSON.parse(await readFile(file, 'utf8')) as RollbackManifestShape
}
