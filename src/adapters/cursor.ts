/**
 * Cursor adapter.
 *
 * Tag convention matches claude-code.ts:
 *   [V-doc] verified against official Cursor docs (cursor.com/docs/<page>.md),
 *           page cited on the line
 *   [V-fs]  verified by inspecting a real install
 *   [I]     inferred — needs CI / real-device confirmation
 *
 * NOTHING here is [V-fs]. The machine this adapter was authored on had no
 * Cursor install (`~/.cursor`, `~/Library/Application Support/Cursor` and
 * `/Applications/Cursor.app` all absent), so docs are the only source and
 * `detect()` is what closes the gap on a real device.
 *
 * Cursor turns out to be a much closer structural match to Claude Code than
 * expected: it has skills (the same Agent Skills / SKILL.md open standard),
 * subagents, hooks, permission allowlists, sandbox policy, MDM policy and a
 * server-delivered team layer. It even reads `.claude/skills/`, `.claude/agents/`
 * and `.claude/settings.json` hooks for cross-tool compatibility. The places it
 * genuinely does NOT fit the interface are catalogued in
 * `UNREPRESENTABLE_STORES` below and argued in docs/adapter-fit.md.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath, join as joinNative } from 'node:path'

import type {
  ApplyResult,
  Change,
  Concept,
  ConfigDoc,
  DesiredState,
  Detection,
  HostEnv,
  KeyRule,
  Plan,
  ProjectContext,
  Provenance,
  Scope,
  StoreDescriptor,
  ToolAdapter,
} from '../core/types.js'
import {
  deepEqual,
  fingerprint,
  flatten,
  getPath,
  mergeValue,
  ruleFor,
  setPath,
} from '../core/reconcile.js'
import {
  classifyInstallEvidence,
  decideInstalled,
  resolveStorePath,
  withConcepts,
  type EvidenceStrength,
} from '../core/concepts.js'
import { applyPlan, rollbackApply } from '../core/apply-engine.js'
import { storesOf } from '../core/desired.js'
import { canonicalJson, canonicalizeText, sha256Hex } from '../platform/canonical.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`NotImplemented: ${what}`)
    this.name = 'NotImplementedError'
  }
}

export class UnsupportedStoreError extends Error {
  constructor(storeId: string, kind: string) {
    super(
      `Store "${storeId}" has location kind "${kind}"; reading it needs a platform channel ` +
        `(MDM query / registry read / vendor API) this adapter does not own.`,
    )
    this.name = 'UnsupportedStoreError'
  }
}

// ---------------------------------------------------------------------------
// Path helpers (same shape as claude-code.ts — locations() must be able to
// produce a Windows table while running on the macOS control plane, so
// node:path is not usable here).
// ---------------------------------------------------------------------------

const posix = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
const win = (...parts: string[]) => parts.join('\\').replace(/\\+/g, '\\')

/** WSL is a Linux userland: posix separators, posix system paths. */
const joiner = (host: HostEnv) => (host.os === 'windows' && host.runtime === 'native' ? win : posix)

// ---------------------------------------------------------------------------
// Store ids
// ---------------------------------------------------------------------------

export const STORE = {
  userMcp: 'cursor:user:mcp',
  projectMcp: 'cursor:project:mcp',
  userCliConfig: 'cursor:user:cli-config',
  projectCli: 'cursor:project:cli',
  userPermissions: 'cursor:user:permissions',
  projectPermissions: 'cursor:project:permissions',
  userSandbox: 'cursor:user:sandbox',
  projectSandbox: 'cursor:project:sandbox',
  userHooks: 'cursor:user:hooks',
  projectHooks: 'cursor:project:hooks',
  managedHooks: 'cursor:managed:hooks',
  projectRules: 'cursor:project:rules',
  projectAgentsMd: 'cursor:project:agents-md',
  projectCursorrules: 'cursor:project:cursorrules-legacy',
  userSkills: 'cursor:user:skills',
  projectSkills: 'cursor:project:skills',
  userSkillsAgents: 'cursor:user:skills-agents',
  projectSkillsAgents: 'cursor:project:skills-agents',
  userSubagents: 'cursor:user:subagents',
  projectSubagents: 'cursor:project:subagents',
  userCommands: 'cursor:user:commands',
  projectCommands: 'cursor:project:commands',
  userIdeSettings: 'cursor:user:ide-settings',
  managedPolicyFile: 'cursor:managed:policy-file',
  managedPolicyPlist: 'cursor:managed:policy-plist',
  managedPolicyRegistry: 'cursor:managed:policy-registry',
  remoteTeamRules: 'cursor:managed:team-rules',
  remoteTeamHooks: 'cursor:managed:team-hooks',
  remoteTeamMcp: 'cursor:managed:team-mcp',
} as const

/**
 * The six policies Cursor documents for Group Policy / configuration profile /
 * Linux policy file. [V-doc] enterprise/deployment-patterns
 */
export const MANAGED_POLICY_NAMES = [
  'AllowedExtensions',
  'AllowedTeamId',
  'ExtensionGalleryServiceUrl',
  'NetworkDisableHttp2',
  'UpdateMode',
  'WorkspaceTrustEnabled',
] as const

/** [V-doc] enterprise/deployment-patterns — PayloadType must equal the bundle id. */
export const MACOS_POLICY_DOMAIN = 'com.todesktop.230313mzl4w4u92'
export const MACOS_POLICY_DOMAIN_NIGHTLY = 'co.anysphere.cursor.nightly'

/**
 * Real Cursor state that `StoreLocation` cannot express. Surfaced as data so
 * the UI can say "we know, and we deliberately do not touch this" rather than
 * implying Cursor has no such state.
 */
export const UNREPRESENTABLE_STORES = [
  {
    what: '.cursorignore / .cursorindexingignore',
    path: '<project>/.cursorignore',
    why: "gitignore syntax — StoreLocation.file.format has no 'text' member",
    provenance: '[V-doc] reference/ignore-file',
  },
  {
    what: 'Cursor Settings blob',
    path: '<userData>/User/globalStorage/state.vscdb',
    why: "SQLite — StoreLocation has no 'sqlite' kind. Much of the Cursor Settings pane lives here, not in settings.json.",
    provenance: '[I] community-corroborated, absent from official docs',
  },
  {
    what: 'User Rules',
    path: 'n/a — account/UI state',
    why: 'Cursor docs state User Rules "are not stored on the file system".',
    provenance: '[V-doc] rules, skills',
  },
] as const

// ---------------------------------------------------------------------------
// Path table
// ---------------------------------------------------------------------------

/** [V-doc] hooks — enterprise (MDM, system-wide) hooks file. */
function managedHooksPath(host: HostEnv): string {
  switch (host.os) {
    case 'macos':
      return '/Library/Application Support/Cursor/hooks.json'
    case 'linux':
      return '/etc/cursor/hooks.json' // also WSL
    case 'windows':
      // Docs print this literal. HostEnv has no %ProgramData%, so we cannot
      // honor a relocated ProgramData root.
      return host.runtime === 'wsl' ? '/etc/cursor/hooks.json' : 'C:\\ProgramData\\Cursor\\hooks.json'
  }
}

/**
 * VS Code fork layout. [V-doc] enterprise/endpoint-security confirms
 * `%APPDATA%\Cursor\` is "User data, settings, and workspace storage"; the
 * `User/settings.json` leaf and the macOS/Linux roots are [I].
 */
function ideSettingsPath(host: HostEnv): string {
  const j = joiner(host)
  switch (host.os) {
    case 'macos':
      return j(host.home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
    case 'windows':
      return j(host.appData ?? j(host.home, 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json')
    case 'linux':
      return j(host.home, '.config', 'Cursor', 'User', 'settings.json')
  }
}

function locations(host: HostEnv, ctx?: ProjectContext): StoreDescriptor[] {
  const j = joiner(host)
  // [V-doc] cli/reference/configuration gives Windows global config as
  // `$env:USERPROFILE\.cursor\cli-config.json`, i.e. the same `~/.cursor` on
  // every platform. HostEnv.home is %USERPROFILE% on Windows.
  const userDir = j(host.home, '.cursor')

  const out: StoreDescriptor[] = []

  /**
   * Project paths are repo-relative by house convention, and a caller that
   * supplies a root gets them resolved against it HERE.
   *
   * That placement is deliberate. Nothing in the product actually passes a
   * `ProjectContext` to `read()` — both `cli/planner.ts` and `apply-engine.ts`
   * call `adapter.read(store, host)` with two arguments — so a descriptor that
   * stays repo-relative is resolved against `projectRoot` on the WRITE side and
   * against `process.cwd()` on the READ side. Baking the root into the
   * descriptor makes both sides see one absolute path and removes the
   * disagreement at its source. `read()` still honors `ctx` as well, so it is
   * correct whether or not `locations()` was given one.
   */
  const proj = (...parts: string[]): string => {
    const rel = j(...parts)
    return ctx?.projectRoot ? j(ctx.projectRoot, rel) : rel
  }

  const file = (
    id: string,
    scope: Scope,
    path: string,
    format: 'json' | 'jsonc' | 'markdown',
    opts: { writable?: boolean; syncable?: boolean; provenance?: Provenance; concept?: Concept } = {},
  ): void => {
    out.push({
      id,
      scope,
      location: { kind: 'file', path, format },
      readable: true,
      writable: opts.writable ?? true,
      syncable: opts.syncable ?? true,
      ...(opts.concept ? { concept: opts.concept } : {}),
      // No Cursor install existed on the host this table was authored against,
      // so nothing here is 'verified-fs' — docs are the ceiling until CI runs
      // against a real install.
      provenance: opts.provenance ?? 'verified-doc',
    })
  }

  const dir = (id: string, scope: Scope, path: string, entryFile?: string): void => {
    out.push({
      id,
      scope,
      location: entryFile ? { kind: 'dir', path, entryFile } : { kind: 'dir', path },
      readable: true,
      writable: true,
      // `entryFile` means installed packages, which are re-resolved per device
      // from a lockfile — `writeVerdict` refuses them, so claiming they sync
      // would be two answers to one question. Authored directories (sub-agents,
      // slash commands) genuinely do sync: their bytes are the only source.
      syncable: !entryFile,
      provenance: 'verified-doc',
    })
  }

  // ----------------------------------------------------------------- managed
  // Read so the UI can say "your org overrides this", never written.
  out.push({
    id: STORE.managedHooks,
    scope: 'managed',
    location: { kind: 'file', path: managedHooksPath(host), format: 'json' }, // [V-doc] hooks
    readable: true,
    writable: false,
    syncable: false,
    provenance: 'verified-doc',
  })

  if (host.os === 'macos') {
    out.push({
      id: STORE.managedPolicyPlist,
      scope: 'managed',
      location: { kind: 'plist', domain: MACOS_POLICY_DOMAIN }, // [V-doc] enterprise/deployment-patterns
      readable: true,
      writable: false,
      syncable: false,
      provenance: 'verified-doc',
    })
  } else if (host.os === 'windows') {
    // [V-doc] confirms Registry-based Group Policy, ADMX templates shipped at
    // %LOCALAPPDATA%\Programs\cursor\policies, and that both Computer (HKLM)
    // and User (HKCU) levels apply with Computer winning.
    // [I] THE KEY PATH ITSELF. Cursor's docs never print it. `Software\Policies\
    // Cursor` follows the VS Code ADMX convention and the docs' note that the
    // Group Policy category was renamed to "Cursor" in 2.1. Do not write here.
    for (const hive of ['HKLM', 'HKCU'] as const) {
      for (const name of MANAGED_POLICY_NAMES) {
        out.push({
          id: `${STORE.managedPolicyRegistry}:${hive}:${name}`,
          scope: 'managed',
          location: { kind: 'registry', hive, key: 'Software\\Policies\\Cursor', value: name }, // [I]
          readable: true,
          writable: false,
          syncable: false,
          provenance: 'inferred',
          provenanceNote:
            "Cursor's docs confirm ADMX Group Policy at HKLM/HKCU but never print the key " +
            'path. This follows the VS Code convention and is UNCONFIRMED — reads may return ' +
            'nothing, and writes are blocked by provenance.',
        })
      }
    }
  } else {
    // [V-doc] "The policy file is located at `~/.cursor/policy.json`." (Linux,
    // Cursor 2.0+). Note it sits in $HOME even though it is a machine policy.
    out.push({
      id: STORE.managedPolicyFile,
      scope: 'managed',
      location: { kind: 'file', path: j(userDir, 'policy.json'), format: 'json' }, // [V-doc]
      readable: true,
      writable: false,
      syncable: false,
      provenance: 'verified-doc',
    })
  }

  // Team Rules / Team hooks / Team MCP + MCP allowlist are configured in the
  // Cursor dashboard and pushed to clients. Observable in effect, never local.
  // [V-doc] rules ("Team Rules"), hooks ("Team hooks"), mcp ("MCP Allowlist")
  for (const id of [STORE.remoteTeamRules, STORE.remoteTeamHooks, STORE.remoteTeamMcp]) {
    out.push({
      id,
      scope: 'managed',
      location: { kind: 'remote', provider: 'cursor-dashboard' },
      readable: false,
      writable: false,
      syncable: false,
      provenance: 'verified-doc',
    })
  }

  // -------------------------------------------------------------------- user
  file(STORE.userMcp, 'user', j(userDir, 'mcp.json'), 'json') // [V-doc] mcp
  file(STORE.userCliConfig, 'user', j(userDir, 'cli-config.json'), 'json') // [V-doc] cli/reference/configuration
  file(STORE.userPermissions, 'user', j(userDir, 'permissions.json'), 'jsonc') // [V-doc] reference/permissions (JSONC)
  file(STORE.userSandbox, 'user', j(userDir, 'sandbox.json'), 'json') // [V-doc] reference/sandbox
  file(STORE.userHooks, 'user', j(userDir, 'hooks.json'), 'json') // [V-doc] hooks
  dir(STORE.userSkills, 'user', j(userDir, 'skills'), 'SKILL.md') // [V-doc] skills
  dir(STORE.userSkillsAgents, 'user', j(host.home, '.agents', 'skills'), 'SKILL.md') // [V-doc] skills
  dir(STORE.userSubagents, 'user', j(userDir, 'agents')) // [V-doc] subagents
  dir(STORE.userCommands, 'user', j(userDir, 'commands')) // [I] user-level spelling
  file(STORE.userIdeSettings, 'user', ideSettingsPath(host), 'jsonc') // [I] leaf; parent [V-doc]

  // NOTE: Cursor also reads `~/.claude/skills`, `~/.claude/agents`,
  // `~/.codex/skills`, `~/.codex/agents` for cross-tool compatibility
  // ([V-doc] skills, subagents). Those paths are deliberately NOT emitted here
  // — they belong to the claude-code / codex adapters, and two adapters owning
  // one path is how you get two writers fighting over the same file.

  // ---------------------------------------------------- project (relative)
  // Same convention as claude-code.ts: project paths are repo-relative unless a
  // ProjectContext resolved them, and read() resolves them the same way.
  file(STORE.projectMcp, 'project', proj('.cursor', 'mcp.json'), 'json') // [V-doc] mcp
  file(STORE.projectCli, 'project', proj('.cursor', 'cli.json'), 'json') // [V-doc] permissions only
  file(STORE.projectPermissions, 'project', proj('.cursor', 'permissions.json'), 'jsonc') // [V-doc]
  file(STORE.projectSandbox, 'project', proj('.cursor', 'sandbox.json'), 'json') // [V-doc]
  file(STORE.projectHooks, 'project', proj('.cursor', 'hooks.json'), 'json') // [V-doc]
  dir(STORE.projectRules, 'project', proj('.cursor', 'rules')) // [V-doc] rules — .mdc ONLY
  dir(STORE.projectSkills, 'project', proj('.cursor', 'skills'), 'SKILL.md') // [V-doc] skills
  dir(STORE.projectSkillsAgents, 'project', proj('.agents', 'skills'), 'SKILL.md') // [V-doc] skills
  dir(STORE.projectSubagents, 'project', proj('.cursor', 'agents')) // [V-doc] subagents
  dir(STORE.projectCommands, 'project', proj('.cursor', 'commands')) // [V-doc] reference/sandbox lists it writable
  file(STORE.projectAgentsMd, 'project', proj('AGENTS.md'), 'markdown') // [V-doc] rules — nested files also honored

  // Legacy. NOT documented anywhere in current Cursor docs — it has been
  // removed from them. Community sources agree it is still read for backwards
  // compatibility but is deprecated and reportedly ignored in Agent mode.
  // We read it to offer a migration and refuse to write it.
  file(STORE.projectCursorrules, 'project', proj('.cursorrules'), 'markdown', {
    writable: false,
    syncable: false,
  }) // [I]

  return withConcepts(out)
}

// ---------------------------------------------------------------------------
// Portability + merge rules
//
// core/reconcile.ts `ruleFor` picks the MOST SPECIFIC match, so ordering here
// is for humans, not for semantics. The `**` fallback is mandatory.
// ---------------------------------------------------------------------------

function rules(): KeyRule[] {
  return [
    // ------------------------------------------------------------ never-sync
    // Cursor's MCP docs are explicit that env/headers/auth carry API keys and
    // tokens, and that `${env:NAME}` indirection is the recommended shape.
    // We refuse the literal values; the indirection survives because the
    // interpolation string itself is what gets written.
    { match: 'mcpServers.*.env.**', portability: 'never-sync', merge: 'never', secret: true },
    { match: 'mcpServers.*.headers.**', portability: 'never-sync', merge: 'never', secret: true },
    { match: 'mcpServers.*.auth.**', portability: 'never-sync', merge: 'never', secret: true },
    { match: 'cursorAuth.**', portability: 'never-sync', merge: 'never', secret: true },
    // Team identity: writing it locally is pointless (MDM policy overrides it)
    // and leaking it across devices is an auth problem.
    { match: 'AllowedTeamId', portability: 'never-sync', merge: 'never' },
    // Docs: "Some fields are CLI-managed and may be overwritten." Syncing these
    // produces write-fights with the CLI itself.
    { match: 'hasChangedDefaultModel', portability: 'never-sync', merge: 'never' },

    // -------------------------------------------------------- machine-scoped
    // envFile is a filesystem path ("`.env`", "`${workspaceFolder}/.env`").
    { match: 'mcpServers.*.envFile', portability: 'machine-scoped', merge: 'replace' },
    // sandbox.json path grants are absolute and device-local. Docs: paths are
    // unioned across policy sources, so union-list is the faithful strategy.
    { match: 'additionalReadwritePaths', portability: 'machine-scoped', merge: 'union-list' },
    { match: 'additionalReadonlyPaths', portability: 'machine-scoped', merge: 'union-list' },
    // Release channel is per-install, not per-user.
    { match: 'channel', portability: 'machine-scoped', merge: 'replace' },
    // Proxy / HTTP2 workarounds are corporate-network facts about one machine.
    { match: 'network.**', portability: 'machine-scoped', merge: 'replace' },

    // ------------------------------------------------------------- os-scoped
    // Every hook is a spawned process. Order matters within an event, so
    // `concat` — a union would silently reorder a formatter after a linter.
    { match: 'hooks.**', portability: 'os-scoped', merge: 'concat' },
    // MCP stdio servers: `command` is an executable name and `args` is its
    // argv. Neither survives macOS -> Windows.
    { match: 'mcpServers.*.command', portability: 'os-scoped', merge: 'replace' },
    { match: 'mcpServers.*.args', portability: 'os-scoped', merge: 'replace' },
    // CLI permission tokens are Shell(...)/Read(...)/Write(...) — the Shell
    // ones name real binaries (`rm` vs `del`, `ls` vs `dir`).
    { match: 'permissions.allow', portability: 'os-scoped', merge: 'union-list' },
    { match: 'permissions.deny', portability: 'os-scoped', merge: 'union-list' },
    // IDE run-mode allowlist entries are raw command prefixes.
    { match: 'terminalAllowlist', portability: 'os-scoped', merge: 'union-list' },

    // -------------------------------------------------------------- portable
    // `server:tool` identifiers are pure names.
    { match: 'mcpAllowlist', portability: 'portable', merge: 'union-list' },
    // Docs: per-user and per-repo autoRun arrays are CONCATENATED. They are
    // natural-language steering hints, so duplicates are noise -> union-list.
    { match: 'autoRun.allow_instructions', portability: 'portable', merge: 'union-list' },
    { match: 'autoRun.block_instructions', portability: 'portable', merge: 'union-list' },
    // Remote MCP servers are just URLs.
    { match: 'mcpServers.*.url', portability: 'portable', merge: 'replace' },
    { match: 'mcpServers.*.type', portability: 'portable', merge: 'replace' },
    // Docs: network deny lists always union and deny beats allow.
    { match: 'networkPolicy.allow', portability: 'portable', merge: 'union-list' },
    { match: 'networkPolicy.deny', portability: 'portable', merge: 'union-list' },
    { match: 'networkPolicy.default', portability: 'portable', merge: 'replace' },
    { match: 'disableTmpWrite', portability: 'portable', merge: 'replace' },
    { match: 'enableSharedBuildCache', portability: 'portable', merge: 'replace' },
    // sandbox.json `type`: workspace_readwrite | workspace_readonly | insecure_none
    { match: 'type', portability: 'portable', merge: 'replace' },
    { match: 'approvalMode', portability: 'portable', merge: 'replace' },
    { match: 'sandbox.**', portability: 'portable', merge: 'replace' },
    { match: 'model.**', portability: 'portable', merge: 'replace' },
    { match: 'editor.**', portability: 'portable', merge: 'replace' },
    { match: 'display.**', portability: 'portable', merge: 'replace' },
    { match: 'attribution.**', portability: 'portable', merge: 'replace' },
    { match: 'version', portability: 'portable', merge: 'replace' },

    // Managed policy values: observable, never writable from here.
    ...MANAGED_POLICY_NAMES.map(
      (name): KeyRule => ({ match: name, portability: 'never-sync', merge: 'never' }),
    ),

    // Cursor ships versioned formats that WILL gain keys we have never seen.
    // Pass them through untouched rather than rewriting what we do not model.
    { match: '**', portability: 'portable', merge: 'deep-merge' },
  ]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strip `//` and block comments plus trailing commas. String-literal aware. */
export function stripJsonc(input: string): string {
  let out = ''
  let inStr = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i] ?? ''
    const n = input[i + 1] ?? ''
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (c === '\\') {
        out += n
        i++
      } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>
  body: string
  /** Kept so canonicalize() hashes the real bytes, not a lossy re-render. */
  raw: string
}

/**
 * Minimal YAML frontmatter reader — scalars and `- ` lists only, which covers
 * every field Cursor documents for .mdc rules (description, globs, alwaysApply),
 * SKILL.md (name, description, paths, disable-model-invocation) and subagents
 * (name, description, model, readonly, is_background).
 */
export function parseFrontmatter(text: string): ParsedMarkdown {
  const normalized = canonicalizeText(text, { trailingNewline: false })
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!m) return { frontmatter: {}, body: normalized, raw: normalized }

  const fm: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const line of (m[1] ?? '').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && listKey) {
      const arr = Array.isArray(fm[listKey]) ? (fm[listKey] as unknown[]) : []
      arr.push(coerce(item[1] ?? ''))
      fm[listKey] = arr
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] ?? ''
    const val = kv[2] ?? ''
    if (val.trim() === '') {
      listKey = key
      fm[key] = []
      continue
    }
    listKey = null
    fm[key] = coerce(val)
  }
  return { frontmatter: fm, body: normalized.slice(m[0].length), raw: normalized }
}

function coerce(v: string): unknown {
  const s = v.trim()
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

// ---------------------------------------------------------------------------
// detect / read
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** [V-doc] enterprise/endpoint-security — install roots per platform. */
function installPaths(host: HostEnv): string[] {
  const j = joiner(host)
  switch (host.os) {
    case 'macos':
      return ['/Applications/Cursor.app']
    case 'windows':
      return [
        j(host.localAppData ?? j(host.home, 'AppData', 'Local'), 'Programs', 'cursor'),
        j(host.programFiles ?? 'C:\\Program Files', 'cursor'),
      ]
    case 'linux':
      return [] // No documented canonical install root (AppImage/deb/nix all differ).
  }
}

async function detect(host: HostEnv): Promise<Detection> {
  const present: string[] = []

  for (const store of locations(host)) {
    const loc = store.location
    if (loc.kind !== 'file' && loc.kind !== 'dir' && loc.kind !== 'dropin') continue
    // Project stores are repo-relative; resolve against cwd like read() does.
    if (await pathExists(absolutize(loc.path))) present.push(store.id)
  }

  // Evidence is RANKED, not counted. `~/.agents/skills` is shared across tools
  // and proves nothing about THIS one; a project-scope file describes a repo,
  // not a machine; and a config file we can WRITE only weakly implies the tool
  // is here, because a file we left behind after an uninstall looks identical.
  const table = locations(host)
  const found: EvidenceStrength[] = present.map((id) => {
    const s = table.find((x) => x.id === id)
    return s ? classifyInstallEvidence(s) : 'none'
  })

  // An app bundle is definitive — we could never have authored it, so it
  // outranks every config file and cannot be self-confirmed.
  for (const p of installPaths(host)) {
    if (await pathExists(p)) {
      found.push('definitive')
      break
    }
  }

  const { installed, confidence } = decideInstalled(found)
  const version = await readMacVersion(host)
  return version === undefined
    ? { installed, confidence, present }
    : { installed, confidence, version, present }
}

/**
 * macOS only, and deliberately fs-only — detect() must not shell out.
 * /Applications/Cursor.app is [V-doc]; Info.plist inside it is standard bundle
 * layout. Windows/Linux expose no documented version file, so we return
 * undefined rather than guess.
 */
async function readMacVersion(host: HostEnv): Promise<string | undefined> {
  if (host.os !== 'macos') return undefined
  try {
    const plist = await readFile('/Applications/Cursor.app/Contents/Info.plist', 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch {
    return undefined
  }
}

/** Project-scoped descriptors are repo-relative; resolve against cwd. */
function absolutize(p: string): string {
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p)
}

async function read(store: StoreDescriptor, host: HostEnv, ctx?: ProjectContext): Promise<ConfigDoc> {
  void host
  const loc = store.location
  if (loc.kind === 'plist' || loc.kind === 'registry' || loc.kind === 'remote') {
    throw new UnsupportedStoreError(store.id, loc.kind)
  }
  // Resolve through the SAME resolver `apply-engine.ts` uses, so read() and
  // apply() cannot disagree about which file a project-relative path names.
  // Without a context both fall back to the process working directory, which
  // is what `resolveStorePath` leaves a relative path to do.
  const abs = resolveStorePath(loc.path, ctx)
  if (loc.kind === 'dir') return readDirStore(store, abs, loc.entryFile)
  // 'dropin' is unused by Cursor but shares file semantics.
  return readFileStore(store, abs, loc.kind === 'file' ? loc.format : 'json')
}

async function readFileStore(
  store: StoreDescriptor,
  abs: string,
  format: 'json' | 'jsonc' | 'markdown' | 'toml' | 'yaml',
): Promise<ConfigDoc> {
  let bytes: Buffer
  try {
    bytes = await readFile(abs)
  } catch {
    return { storeId: store.id, data: null, hash: '', exists: false }
  }

  const hash = sha256Hex(bytes)
  const text = bytes.toString('utf8')
  let data: unknown

  if (format === 'markdown') {
    data = parseFrontmatter(text)
  } else if (format === 'json' || format === 'jsonc') {
    try {
      data = JSON.parse(format === 'jsonc' ? stripJsonc(canonicalizeText(text)) : canonicalizeText(text))
    } catch (e) {
      // Never explode a whole sync over one malformed user file. plan() turns
      // this into a refuse-to-write warning.
      data = { __parseError: String(e), raw: text }
    }
  } else {
    data = { raw: text }
  }

  const version = getPath(data, 'version')
  // The bytes exactly as read travel with the doc. `ConfigDoc.raw` is what a
  // format-preserving write is computed from, and shipping a doc without it is
  // how an adapter ends up quietly rewriting a user's JSONC through
  // `JSON.stringify` and deleting every comment in it.
  const base: ConfigDoc = { storeId: store.id, data, hash, exists: true, raw: bytes }
  return typeof version === 'number' ? { ...base, schemaVersion: version } : base
}

export interface DirEntry {
  /** Path relative to the store root, always posix-separated. */
  path: string
  frontmatter: Record<string, unknown>
  body: string
  hash: string
}

/** Recursive: rules/, skills/, agents/ and commands/ all nest. [V-doc] */
async function readDirStore(
  store: StoreDescriptor,
  root: string,
  entryFile: string | undefined,
): Promise<ConfigDoc> {
  if (!(await pathExists(root))) return { storeId: store.id, data: null, hash: '', exists: false }

  const entries: DirEntry[] = []

  const walk = async (dirPath: string): Promise<void> => {
    let items
    try {
      items = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const full = joinNative(dirPath, it.name)
      if (it.isDirectory()) {
        await walk(full)
        continue
      }
      if (!isEntryFile(store.id, it.name, entryFile)) continue
      try {
        const bytes = await readFile(full)
        const parsed = parseFrontmatter(bytes.toString('utf8'))
        entries.push({
          path: full.slice(root.length + 1).split(/[\\/]/).join('/'),
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          hash: sha256Hex(bytes),
        })
      } catch {
        /* unreadable entry — detect() already reported the directory exists */
      }
    }
  }
  await walk(root)

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = sha256Hex(entries.map((e) => `${e.path}:${e.hash}`).join('\n'))
  return { storeId: store.id, data: { entries }, hash, exists: true }
}

function isEntryFile(storeId: string, name: string, entryFile: string | undefined): boolean {
  // Skills are folders containing SKILL.md; nothing else in the tree counts.
  if (entryFile) return name === entryFile
  // [V-doc] rules: "Project rules must use the `.mdc` extension. A plain `.md`
  // file in `.cursor/rules` is ignored." Reporting a .md there as a live rule
  // would be a lie.
  if (storeId === STORE.projectRules) return name.endsWith('.mdc')
  // [V-doc] reference/plugins — commands accept .md/.mdc/.markdown/.txt.
  // Subagents are markdown. Same filter serves both.
  return /\.(md|mdc|markdown|txt)$/.test(name)
}

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

function canonicalize(doc: ConfigDoc): string {
  const data = doc.data
  // Markdown docs carry their raw text; hash the text, not our parse of it.
  if (data && typeof data === 'object' && typeof (data as ParsedMarkdown).raw === 'string') {
    return canonicalizeText((data as ParsedMarkdown).raw)
  }
  return canonicalJson(data)
}

// ---------------------------------------------------------------------------
// plan — PURE. No fs, no clock, no randomness.
// ---------------------------------------------------------------------------

export interface CursorDesiredState {
  /** storeId -> desired document. Cursor has no single settings file. */
  stores?: Record<string, unknown>
}

/**
 * Which managed store, when present, beats a writable one.
 * [V-doc] precedence:
 *   hooks       Enterprise > Team > Project > User
 *   allowlists  team admin > permissions.json > IDE settings
 *   rules       Team Rules > Project Rules > User Rules
 */
const MANAGED_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  [STORE.userHooks]: [STORE.managedHooks, STORE.remoteTeamHooks],
  [STORE.projectHooks]: [STORE.managedHooks, STORE.remoteTeamHooks],
  [STORE.userPermissions]: [STORE.remoteTeamMcp],
  [STORE.projectPermissions]: [STORE.remoteTeamMcp],
  [STORE.projectRules]: [STORE.remoteTeamRules],
  [STORE.projectAgentsMd]: [STORE.remoteTeamRules],
}

/**
 * Cursor-specific risk. core/reconcile.ts `classifyRisk` is shaped for Claude
 * Code's single settings file and would under-report here: Cursor's shell
 * allowlists live at top-level `terminalAllowlist`, and `type: "insecure_none"`
 * disables the sandbox outright.
 */
export function classifyCursorRisk(storeId: string, path: string): Change['risk'] {
  if (storeId === STORE.userHooks || storeId === STORE.projectHooks) return 'code-execution'
  if (/^hooks\./.test(path)) return 'code-execution'
  if (/^mcpServers\.[^.]+\.(command|args|env|envFile)/.test(path)) return 'code-execution'
  if (/^mcpServers\./.test(path)) return 'elevated'
  if (/^(permissions\.|terminalAllowlist|mcpAllowlist|autoRun|approvalMode)/.test(path)) {
    return 'elevated'
  }
  if (/^(type|networkPolicy|sandbox|additionalRead|disableTmpWrite)/.test(path)) return 'elevated'
  return 'none'
}

function plan(
  desired: DesiredState, observed: ConfigDoc[], host: HostEnv): Plan {
  const table = rules()
  const stores = new Map(locations(host).map((s) => [s.id, s]))
  const obs = new Map(observed.map((d) => [d.storeId, d]))
  const changes: Change[] = []
  const warnings: string[] = []

  const baseHashes: Record<string, string> = {}
  for (const doc of observed) baseHashes[doc.storeId] = doc.hash

  // ---- Host facts worth surfacing regardless of `desired` ----------------
  if (host.os === 'linux') {
    warnings.push(
      'HostEnv exposes no environment. CURSOR_CONFIG_DIR and XDG_CONFIG_HOME both relocate ' +
        "Cursor's user config directory; this table assumes ~/.cursor. Confirm on-device.",
    )
  }
  if (host.os === 'windows') {
    warnings.push(
      'Windows managed-policy key (Software\\Policies\\Cursor) is INFERRED — Cursor documents ' +
        'ADMX Group Policy but never prints the registry key. Managed reads are unverified.',
    )
    if (!host.supportsLongPaths) {
      warnings.push(
        'Long paths are disabled: nested .cursor/skills/<category>/<skill>/references/ trees can exceed MAX_PATH.',
      )
    }
  }
  if (host.runtime === 'wsl') {
    warnings.push(
      'WSL: enterprise hooks resolve to /etc/cursor/hooks.json, but a Win32-side Cursor reads ' +
        'C:\\ProgramData\\Cursor\\hooks.json. Both can be live for the same user.',
    )
  }
  if (obs.get(STORE.projectCursorrules)?.exists) {
    warnings.push(
      'Legacy .cursorrules found. It is absent from current Cursor docs and reportedly ignored in ' +
        'Agent mode. Migrate it to .cursor/rules/*.mdc or AGENTS.md.',
    )
  }
  warnings.push(
    'Much of the Cursor Settings pane is stored in a SQLite blob (User/globalStorage/state.vscdb), ' +
      'not settings.json. It is out of scope and will not be synced.',
  )

  // ---- Desired-state validation ------------------------------------------
  // Shape is decided once, at the boundary, by normalizeDesired(). An
  // adapter sniffing it again is how the two shapes diverged in the first
  // place.
  const desiredStores = storesOf(desired)

  if (Object.keys(desiredStores).length === 0) {
    warnings.push(
      'Desired state has no per-store map. Nothing to plan.',
    )
    return {
    id: fingerprint(JSON.stringify({ deviceId: host.deviceId, toolId: 'cursor', changes, baseHashes })),
    deviceId: host.deviceId,
    toolId: 'cursor',
    changes,
    baseHashes,
    warnings,
  }
  }

  for (const [storeId, want] of Object.entries(desiredStores)) {
    const store = stores.get(storeId)
    if (!store) {
      warnings.push(`Unknown cursor store id "${storeId}" — skipped.`)
      continue
    }

    if (!store.writable) {
      changes.push({
        storeId,
        op: 'skip',
        path: '',
        reason:
          store.scope === 'managed'
            ? 'Managed scope: observable only, never written.'
            : 'Read-only store (deprecated format).',
        risk: 'none',
        ...(store.scope === 'managed' ? { overriddenBy: 'managed' as Scope } : {}),
      })
      continue
    }

    const overriddenBy = overrideFor(storeId, obs)
    if (overriddenBy) {
      warnings.push(
        `"${storeId}" is governed by a higher-precedence managed source; these writes may have no effect.`,
      )
    }

    const current = obs.get(storeId)

    if (store.location.kind === 'dir') {
      changes.push(...planDir(store, want, current, overriddenBy))
      continue
    }

    if (getPath(current?.data, '__parseError') !== undefined) {
      warnings.push(`${storeId} exists but does not parse; refusing to overwrite unparseable user config.`)
      changes.push({
        storeId,
        op: 'skip',
        path: '',
        reason: 'Existing file is unparseable. Manual repair required.',
        risk: 'none',
      })
      continue
    }

    const leaves = flatten(want)

    // Whole-file create when nothing is on disk.
    if (!current?.exists) {
      const safe: Record<string, unknown> = {}
      let stripped = false
      let risk: Change['risk'] = 'none'
      for (const [path, value] of leaves) {
        const rule = ruleFor(table, path)
        if (rule.portability === 'never-sync' || rule.merge === 'never') {
          stripped = true
          changes.push({
            storeId,
            op: 'skip',
            path,
            reason: `${rule.portability}${rule.secret ? ' (secret)' : ''}: never leaves the device.`,
            risk: classifyCursorRisk(storeId, path),
          })
          continue
        }
        setPath(safe, path, value)
        risk = worst(risk, classifyCursorRisk(storeId, path))
      }
      changes.push({
        storeId,
        op: 'create',
        path: '',
        after: safe,
        reason: stripped ? 'File absent; creating with never-sync keys stripped.' : 'File absent; creating.',
        risk,
        ...(overriddenBy ? { overriddenBy } : {}),
      })
      continue
    }

    // Per-key diff.
    for (const [path, value] of leaves) {
      const rule = ruleFor(table, path)
      if (rule.portability === 'never-sync' || rule.merge === 'never') {
        changes.push({
          storeId,
          op: 'skip',
          path,
          reason: `${rule.portability}${rule.secret ? ' (secret)' : ''}: never leaves the device.`,
          risk: classifyCursorRisk(storeId, path),
        })
        continue
      }

      const before = getPath(current.data, path)
      const after = mergeValue(before, value, rule.merge)
      if (deepEqual(before, after)) continue

      changes.push({
        storeId,
        op: before === undefined ? 'create' : 'update',
        path,
        before,
        after,
        reason: `${rule.portability} / ${rule.merge} (rule "${rule.match}")`,
        risk: classifyCursorRisk(storeId, path),
        ...(overriddenBy ? { overriddenBy } : {}),
      })
    }
  }

  return {
    id: fingerprint(JSON.stringify({ deviceId: host.deviceId, toolId: 'cursor', changes, baseHashes })),
    deviceId: host.deviceId,
    toolId: 'cursor',
    changes,
    baseHashes,
    warnings,
  }
}

function overrideFor(storeId: string, obs: Map<string, ConfigDoc>): Scope | undefined {
  for (const id of MANAGED_OVERRIDES[storeId] ?? []) {
    if (obs.get(id)?.exists) return 'managed'
  }
  return undefined
}

function worst(a: Change['risk'], b: Change['risk']): Change['risk'] {
  const rank = { none: 0, elevated: 1, 'code-execution': 2 } as const
  return rank[b] > rank[a] ? b : a
}

/**
 * Directory stores diff per entry file, not per JSON key — a rule, skill,
 * subagent or command is an indivisible unit.
 */
function planDir(
  store: StoreDescriptor,
  want: unknown,
  current: ConfigDoc | undefined,
  overriddenBy: Scope | undefined,
): Change[] {
  const changes: Change[] = []
  const have = new Map(entriesOf(current?.data).map((e) => [e.path, e]))

  for (const entry of entriesOf(want)) {
    if (store.id === STORE.projectRules && !entry.path.endsWith('.mdc')) {
      changes.push({
        storeId: store.id,
        op: 'skip',
        path: entry.path,
        reason:
          'Cursor ignores non-.mdc files in .cursor/rules (no frontmatter to carry description/globs/alwaysApply). Compile to AGENTS.md instead.',
        risk: 'none',
      })
      continue
    }

    const existing = have.get(entry.path)
    if (
      existing &&
      deepEqual(existing.body, entry.body) &&
      deepEqual(existing.frontmatter, entry.frontmatter)
    ) {
      continue
    }

    changes.push({
      storeId: store.id,
      op: existing ? 'update' : 'create',
      path: entry.path,
      ...(existing ? { before: existing } : {}),
      after: entry,
      reason: existing ? 'Entry content differs.' : 'Entry absent on device.',
      // Skills and commands may ship scripts/ that the agent is told to run.
      risk: store.id.includes('skills') || store.id.includes('commands') ? 'code-execution' : 'none',
      ...(overriddenBy ? { overriddenBy } : {}),
    })
  }
  return changes
}

function entriesOf(data: unknown): Array<Omit<DirEntry, 'hash'>> {
  const raw = getPath(data, 'entries')
  if (!Array.isArray(raw)) return []
  const out: Array<Omit<DirEntry, 'hash'>> = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    if (typeof o['path'] !== 'string') continue
    const fm = o['frontmatter']
    out.push({
      path: o['path'],
      frontmatter: fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {},
      body: typeof o['body'] === 'string' ? o['body'] : '',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const cursorAdapter: ToolAdapter = {
  id: 'cursor',
  displayName: 'Cursor',

  capabilities: {
    apply: true,
    // `reason` is normally the explanation for a refusal. It is set here
    // because "can apply" is not all-or-nothing for Cursor and a bare `true`
    // would overclaim: two of its store KINDS still cannot be written, and a
    // user deserves to know that before the failure rather than after it.
    reason:
      'JSON and JSONC stores (mcp.json, permissions.json, sandbox.json, hooks.json, cli-config.json, ' +
      'IDE settings) apply through the shared engine: validated first, atomic, backed up, rolled back ' +
      'as a unit, and format-preserving so comments in permissions.json survive. Two kinds do NOT ' +
      'write yet. Directory stores (.cursor/rules, skills, agents, commands) are planned per entry but ' +
      'skipped by the engine, which writes files and not trees. Markdown stores (AGENTS.md, ' +
      '.cursorrules) are diffed per frontmatter key while the engine can only replace a text file ' +
      'whole, so those changes are reported as failures instead of being written. Every path in the ' +
      'table is verified-doc at best — no Cursor install has ever been inspected — so writes are also ' +
      'gated on detect() finding a real one.',
  },
  detect,
  locations,
  rules,
  read,
  plan,
  canonicalize,

  /**
   * Three lines of delegation, deliberately. `core/apply-engine.ts` is the only
   * code in the product that writes to a user's config; an adapter that grew
   * its own write path would be a second place for the validate / stale-check /
   * backup / rollback rules to drift out of.
   *
   * That includes the `op: 'skip'` reports `plan()` emits. `validatePlan`
   * filters them into `ApplyResult.skipped` before anything reaches the writer,
   * so an adapter does not — and must not — pre-filter them itself.
   */
  async apply(plan: Plan, host: HostEnv): Promise<ApplyResult> {
    return applyPlan(plan, {
      adapter: cursorAdapter,
      host,
      now: () => new Date().toISOString(),
    })
  },

  async rollback(rollbackId: string, host: HostEnv): Promise<void> {
    return rollbackApply(rollbackId, {
      adapter: cursorAdapter,
      host,
      now: () => new Date().toISOString(),
    })
  },
}

export default cursorAdapter
