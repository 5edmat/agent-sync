/**
 * Everything the CLI touches that is not a pure function, behind one interface.
 *
 * Command handlers take `CliDeps` and return an exit code. That is the whole
 * testing strategy: the test suite constructs a `CliDeps` with in-memory
 * streams, a frozen clock, a fake host and a stub apply engine, calls the
 * handler as a function, and asserts on the captured bytes and the returned
 * number. No subprocesses, no temp directories, no snapshot of a real machine.
 *
 * The shapes of `applyPlan` / `rollbackApply` / `listRollbacks` are taken from
 * the real exports via `typeof`, so if the apply engine changes its signature
 * this file stops compiling rather than silently diverging.
 */

import { createInterface } from 'node:readline'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ToolAdapter } from '../core/types.js'
import { detectHost as realDetectHost } from '../platform/host.js'
import { selectSecretStore as realSelectSecretStore } from '../platform/secrets.js'
import { applyPlan, rollbackApply, listRollbacks } from '../core/apply-engine.js'
import { claudeCodeAdapter } from '../adapters/claude-code.js'
import { cursorAdapter } from '../adapters/cursor.js'
import { zedAdapter } from '../adapters/zed.js'

export interface Writer {
  write(chunk: string): void
}

export interface CliIO {
  stdout: Writer
  stderr: Writer
  stdoutIsTTY: boolean
  stderrIsTTY: boolean
  stdinIsTTY: boolean
}

/**
 * The narrow filesystem surface the CLI itself needs for its own state. Config
 * reads and writes go through the adapters and the apply engine — never here.
 */
export interface CliFs {
  /** `null` on ENOENT rather than throwing; a missing state file is normal. */
  readFile(path: string): Promise<string | null>
  writeFile(path: string, contents: string, mode?: number): Promise<void>
  mkdirp(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
}

/**
 * `listRollbacks` returns a type the apply engine does not export. Recovering
 * it structurally keeps the CLI honest without reaching into a private name.
 */
export type RollbackRecord = Awaited<ReturnType<typeof listRollbacks>>[number]

export interface CliDeps {
  io: CliIO
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  cwd: string
  hostname: string
  nodeVersion: string
  /** CLI version, for `--version` and `doctor`. */
  version: string
  now: () => Date
  fs: CliFs
  adapters: ToolAdapter[]
  detectHost: typeof realDetectHost
  selectSecretStore: typeof realSelectSecretStore
  applyPlan: typeof applyPlan
  rollbackApply: typeof rollbackApply
  listRollbacks: typeof listRollbacks
  /**
   * Interactive yes/no. Prompts on stderr (it is a diagnostic, not output) and
   * must return false when there is no TTY to ask.
   */
  confirm(question: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Real implementations
// ---------------------------------------------------------------------------

export const nodeCliFs: CliFs = {
  readFile: async (path) => {
    try {
      return await fsp.readFile(path, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') return null
      throw err
    }
  },
  writeFile: async (path, contents, mode) => {
    await fsp.mkdir(dirname(path), { recursive: true })
    await fsp.writeFile(path, contents, mode !== undefined ? { mode } : {})
  },
  mkdirp: async (path) => {
    await fsp.mkdir(path, { recursive: true })
  },
  exists: async (path) => {
    try {
      await fsp.stat(path)
      return true
    } catch {
      return false
    }
  },
  readdir: async (path) => {
    try {
      return await fsp.readdir(path)
    } catch {
      return []
    }
  },
}

/** Adapters the CLI knows about, in the order they are listed to the user. */
export const BUILTIN_ADAPTERS: ToolAdapter[] = [claudeCodeAdapter, cursorAdapter, zedAdapter]

async function readPackageVersion(): Promise<string> {
  // dist/cli/deps.js and src/cli/deps.ts both sit two levels below the root, so
  // one relative URL works for the built CLI and for vitest.
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = await fsp.readFile(join(here, '..', '..', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function nodeConfirm(io: CliIO): (question: string) => Promise<boolean> {
  return (question) =>
    new Promise<boolean>((resolve) => {
      if (!io.stdinIsTTY) {
        // Nothing to ask. Callers turn this into an actionable error rather
        // than a hang, which is what a CI job needs.
        resolve(false)
        return
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      rl.question(`${question} `, (answer) => {
        rl.close()
        resolve(/^(y|yes)$/i.test(answer.trim()))
      })
    })
}

export async function nodeDeps(overrides: Partial<CliDeps> = {}): Promise<CliDeps> {
  const io: CliIO = overrides.io ?? {
    stdout: { write: (c) => void process.stdout.write(c) },
    stderr: { write: (c) => void process.stderr.write(c) },
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
  }

  return {
    io,
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    hostname: os.hostname(),
    nodeVersion: process.version,
    version: await readPackageVersion(),
    now: () => new Date(),
    fs: nodeCliFs,
    adapters: BUILTIN_ADAPTERS,
    detectHost: realDetectHost,
    selectSecretStore: realSelectSecretStore,
    applyPlan,
    rollbackApply,
    listRollbacks,
    confirm: nodeConfirm(io),
    ...overrides,
  }
}
