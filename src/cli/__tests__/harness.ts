/**
 * Test harness: an entire CLI environment in memory.
 *
 * Nothing here spawns a process or touches a real filesystem. `runCli` calls
 * `run()` as a function with an injected `CliDeps`, so a test asserts on the
 * exact bytes written to stdout/stderr and the exact number returned.
 */

import type {
  ApplyResult,
  ConfigDoc,
  DesiredState,
  Detection,
  HostEnv,
  KeyRule,
  Plan,
  StoreDescriptor,
  ToolAdapter,
} from '../../core/types.js'
import { buildPlan } from '../../core/reconcile.js'
import { documentOf } from '../../core/desired.js'
import { canonicalJson, sha256Hex } from '../../platform/canonical.js'
import type { CliDeps, CliFs, RollbackRecord, Writer } from '../deps.js'
import { run } from '../run.js'

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

export class Capture implements Writer {
  readonly chunks: string[] = []
  write(chunk: string): void {
    this.chunks.push(chunk)
  }
  get text(): string {
    return this.chunks.join('')
  }
  get lines(): string[] {
    return this.text.split('\n')
  }
}

/** Any CSI sequence. Used to prove nothing escape-shaped reaches a pipe. */
export const ANSI_PRESENT = /\u001B\[/

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface MemFs extends CliFs {
  files: Map<string, string>
  dirs: Set<string>
}

export function memFs(seed: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()

  const parents = (p: string): string[] => {
    const out: string[] = []
    let cur = p
    while (cur.includes('/') && cur !== '/') {
      cur = cur.slice(0, cur.lastIndexOf('/'))
      if (cur) out.push(cur)
    }
    return out
  }
  for (const f of files.keys()) for (const d of parents(f)) dirs.add(d)

  return {
    files,
    dirs,
    async readFile(path) {
      return files.get(path) ?? null
    },
    async writeFile(path, contents) {
      files.set(path, contents)
      for (const d of parents(path)) dirs.add(d)
    },
    async mkdirp(path) {
      dirs.add(path)
      for (const d of parents(path)) dirs.add(d)
    },
    async exists(path) {
      return files.has(path) || dirs.has(path)
    },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head) names.add(head)
      }
      return [...names].sort()
    },
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export const TEST_DEVICE_ID = '11111111-2222-3333-4444-555555555555'

export function makeHost(overrides: Partial<HostEnv> = {}): HostEnv {
  return {
    os: 'macos',
    runtime: 'native',
    arch: 'arm64',
    home: '/home/test',
    supportsSymlinks: true,
    hasKeyring: true,
    supportsLongPaths: true,
    shell: 'zsh',
    deviceId: TEST_DEVICE_ID,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const SETTINGS_PATH = '/home/test/.claude/settings.json'
export const MANAGED_PATH = '/managed/managed-settings.json'
export const INFERRED_PATH = '/home/test/.claude/keybindings.json'

export interface FakeAdapterOptions {
  /** Store id -> parsed document. Absent means the file does not exist. */
  docs?: Record<string, unknown>
  /** Make the primary settings store `inferred`, i.e. write-blocked. */
  primaryInferred?: boolean
  readThrows?: Record<string, string>
  id?: ToolAdapter['id']
}

const RULES: KeyRule[] = [
  { match: 'oauthAccount', portability: 'never-sync', merge: 'never', secret: true },
  { match: 'env.*_TOKEN', portability: 'never-sync', merge: 'never', secret: true },
  { match: 'apiKeyHelper', portability: 'machine-scoped', merge: 'replace', secret: true },
  { match: 'hooks.**', portability: 'os-scoped', merge: 'concat' },
  { match: 'permissions.allow', portability: 'portable', merge: 'union-list' },
  { match: 'installPath', portability: 'machine-scoped', merge: 'replace' },
  { match: '**', portability: 'portable', merge: 'deep-merge' },
]

export function makeFakeAdapter(options: FakeAdapterOptions = {}): ToolAdapter {
  const { docs = {}, primaryInferred = false, readThrows = {} } = options
  const id = options.id ?? 'claude-code'

  const stores: StoreDescriptor[] = [
    {
      id: `${id}:managed:settings`,
      scope: 'managed',
      location: { kind: 'file', path: MANAGED_PATH, format: 'json' },
      readable: true,
      writable: false,
      syncable: false,
      provenance: 'verified-doc',
    },
    {
      id: `${id}:user:settings`,
      scope: 'user',
      location: { kind: 'file', path: SETTINGS_PATH, format: 'json' },
      readable: true,
      writable: true,
      syncable: true,
      provenance: primaryInferred ? 'inferred' : 'verified-fs',
      ...(primaryInferred ? { provenanceNote: 'never confirmed against a real install on this OS' } : {}),
    },
    {
      id: `${id}:user:keybindings`,
      scope: 'user',
      location: { kind: 'file', path: INFERRED_PATH, format: 'json' },
      readable: true,
      writable: true,
      syncable: true,
      provenance: 'inferred',
    },
    {
      id: `${id}:managed:plist`,
      scope: 'managed',
      location: { kind: 'plist', domain: 'com.example.tool' },
      readable: true,
      writable: false,
      syncable: false,
      provenance: 'verified-doc',
    },
  ]

  const adapter: ToolAdapter = {
    id,
    displayName: id === 'claude-code' ? 'Claude Code' : id,
    capabilities: { apply: true },

    locations: () => stores,
    rules: () => RULES,

    async detect(): Promise<Detection> {
      const present = stores.filter((s) => docs[s.id] !== undefined).map((s) => s.id)
      return { installed: present.length > 0, present }
    },

    async read(store: StoreDescriptor): Promise<ConfigDoc> {
      const thrown = readThrows[store.id]
      if (thrown) throw new Error(thrown)
      if (store.location.kind !== 'file') {
        throw new Error(`store "${store.id}" needs a platform channel this adapter does not own`)
      }
      const data = docs[store.id]
      if (data === undefined) return { storeId: store.id, data: {}, hash: '', exists: false }
      return { storeId: store.id, data, hash: sha256Hex(canonicalJson(data)), exists: true }
    },

    plan(desired: DesiredState, observed: ConfigDoc[], host: HostEnv): Plan {
      const managed = observed.find((d) => d.storeId.includes(':managed:'))
      return buildPlan({
        deviceId: host.deviceId,
        toolId: id,
        desired: documentOf(desired),
        observed: observed.filter((d) => !d.storeId.includes(':managed:')),
        rules: RULES,
        ...(managed ? { managed: managed.data as Record<string, unknown> } : {}),
        now: '',
      })
    },

    async apply(): Promise<ApplyResult> {
      throw new Error('fake adapter apply() should not be reached; inject deps.applyPlan')
    },
    async rollback(): Promise<void> {
      throw new Error('fake adapter rollback() should not be reached')
    },
    canonicalize: (doc) => canonicalJson(doc.data),
  }

  return adapter
}

/** An adapter that refuses to apply, like the real Cursor and Zed adapters. */
export function makeRefusingAdapter(id: ToolAdapter['id'] = 'cursor'): ToolAdapter {
  const base = makeFakeAdapter({ id, docs: {} })
  const err = new Error(`${id}Adapter.apply is not implemented`)
  err.name = 'NotImplementedError'
  return {
    ...base,
    // Declared, not just thrown: the CLI routes on this, and an adapter that
    // says it can write but then throws is lying about its own contract.
    capabilities: {
      apply: false,
      reason: `${id} cannot be applied by this build yet — writing would strip comments from JSONC settings.`,
    },
    async apply(): Promise<ApplyResult> {
      throw err
    },
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TestEnv {
  deps: CliDeps
  stdout: Capture
  stderr: Capture
  fs: MemFs
  applyCalls: Array<{ plan: Plan }>
  rollbackCalls: string[]
  confirmAnswers: boolean[]
  confirmPrompts: string[]
}

export interface MakeDepsOptions {
  host?: HostEnv
  adapters?: ToolAdapter[]
  files?: Record<string, string>
  env?: NodeJS.ProcessEnv
  stdoutIsTTY?: boolean
  stderrIsTTY?: boolean
  stdinIsTTY?: boolean
  platform?: NodeJS.Platform
  confirmAnswers?: boolean[]
  applyResult?: Partial<ApplyResult>
  applyThrows?: unknown
  rollbacks?: RollbackRecord[]
  rollbackThrows?: unknown
  detectHostThrows?: unknown
  selectSecretStoreThrows?: unknown
}

export function makeDeps(options: MakeDepsOptions = {}): TestEnv {
  const stdout = new Capture()
  const stderr = new Capture()
  const fs = memFs(options.files ?? {})
  const host = options.host ?? makeHost()
  const applyCalls: Array<{ plan: Plan }> = []
  const rollbackCalls: string[] = []
  const confirmAnswers = [...(options.confirmAnswers ?? [])]
  const confirmPrompts: string[] = []

  const deps: CliDeps = {
    io: {
      stdout,
      stderr,
      stdoutIsTTY: options.stdoutIsTTY ?? false,
      stderrIsTTY: options.stderrIsTTY ?? false,
      stdinIsTTY: options.stdinIsTTY ?? false,
    },
    env: options.env ?? {},
    platform: options.platform ?? 'darwin',
    cwd: '/work',
    hostname: 'test-box',
    nodeVersion: 'v20.11.0',
    version: '9.9.9',
    now: () => new Date('2026-07-29T12:00:00.000Z'),
    fs,
    adapters: options.adapters ?? [makeFakeAdapter()],

    detectHost: async () => {
      if (options.detectHostThrows) throw options.detectHostThrows
      return host
    },

    selectSecretStore: async () => {
      if (options.selectSecretStoreThrows) throw options.selectSecretStoreThrows
      return {
        store: {
          backend: 'macos-keychain' as const,
          description: 'macOS login Keychain (test double)',
          capabilities: { list: false, persistent: true, osProtected: true },
          isAvailable: async () => true,
          get: async () => null,
          set: async () => {},
          delete: async () => false,
          list: async () => [],
        },
        chosen: 'macos-keychain' as const,
        attempted: [{ backend: 'macos-keychain' as const, available: true }],
        degraded: false,
      }
    },

    applyPlan: async (plan) => {
      if (options.applyThrows) throw options.applyThrows
      applyCalls.push({ plan })
      return {
        planId: plan.id,
        applied: plan.changes,
        skipped: [],
        failed: [],
        rollbackId: 'rb-testplan0000-abcdef01',
        ...options.applyResult,
      }
    },

    rollbackApply: async (id) => {
      if (options.rollbackThrows) throw options.rollbackThrows
      rollbackCalls.push(id)
    },

    listRollbacks: async () => options.rollbacks ?? [],

    confirm: async (question) => {
      confirmPrompts.push(question)
      return confirmAnswers.shift() ?? false
    },
  }

  return { deps, stdout, stderr, fs, applyCalls, rollbackCalls, confirmAnswers, confirmPrompts }
}

export async function runCli(argv: string[], env: TestEnv): Promise<number> {
  return run(argv, env.deps)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const STATE_DIR = '/state'

export function desiredFile(layers: Array<{ id: string; data: unknown }>): string {
  return `${JSON.stringify(
    { v: 1, toolId: 'claude-code', updatedAt: '2026-07-29T12:00:00.000Z', layers },
    null,
    2,
  )}\n`
}

export function stateFile(devices: Array<Record<string, unknown>> = []): string {
  return `${JSON.stringify(
    {
      v: 1,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      devices,
      tools: {},
    },
    null,
    2,
  )}\n`
}

export function rollbackRecord(overrides: Partial<RollbackRecord> = {}): RollbackRecord {
  return {
    v: 1,
    rollbackId: 'rb-abc123def456-01234567',
    planId: 'plan-0123456789abcdef',
    createdAt: '2026-07-29T11:00:00.000Z',
    tokens: [
      {
        v: 1,
        id: 'tok-1',
        path: SETTINGS_PATH,
        existed: true,
        createdAt: '2026-07-29T11:00:00.000Z',
      },
    ],
    ...overrides,
  }
}
