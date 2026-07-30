/**
 * Claude Code adapter.
 *
 * Every location below is tagged:
 *   [V-doc] verified against code.claude.com/docs/en/settings
 *   [V-fs]  verified by inspecting a real install on macOS
 *   [I]     inferred (homedir-relative, same on every OS) — needs CI confirmation
 *
 * A wrong entry in this table is the worst bug this product can ship, so the
 * tags are load-bearing. Anything still marked [I] must be confirmed by the
 * cross-OS conformance job before we claim support for that platform.
 */

import { readFile, readdir, stat } from 'node:fs/promises'

import type {
  ApplyResult,
  ConfigDoc,
  DesiredState,
  Detection,
  HostEnv,
  KeyRule,
  Plan,
  ProjectContext,
  Provenance,
  StoreDescriptor,
  ToolAdapter,
} from '../core/types.js'
import { buildPlan, getPath } from '../core/reconcile.js'
import { documentOf } from '../core/desired.js'
import {
  classifyInstallEvidence,
  decideInstalled,
  resolveStorePath,
  withConcepts,
} from '../core/concepts.js'
import { applyPlan, rollbackApply } from '../core/apply-engine.js'
import { canonicalJson, canonicalizeText, sha256Hex, stripBom } from '../platform/canonical.js'

const posix = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
const win = (...parts: string[]) => parts.join('\\').replace(/\\+/g, '\\')

/**
 * Filesystem verification is host-specific and we have only ever inspected a
 * real install on macOS. The same homedir-relative path is therefore only
 * *inferred* on Linux and Windows until the cross-OS conformance job confirms
 * it on a real runner.
 *
 * Consequence, deliberately: `apply()` refuses to write to inferred locations,
 * so writes are gated off on Windows/Linux until CI proves the table. Refusing
 * to write is the correct failure mode — a wrong path corrupts a config we were
 * trusted with. CI flipping these to verified is what unlocks those platforms.
 */
function fsVerified(host: HostEnv): Provenance {
  return host.os === 'macos' && host.runtime === 'native' ? 'verified-fs' : 'inferred'
}

/** [V-doc] Managed policy roots. Note Linux and WSL share the same root. */
function managedRoot(host: HostEnv): string {
  switch (host.os) {
    case 'macos':
      return '/Library/Application Support/ClaudeCode'
    case 'linux':
      return '/etc/claude-code' //  also WSL
    case 'windows':
      return win(host.programFiles ?? 'C:\\Program Files', 'ClaudeCode')
  }
}

export const claudeCodeAdapter: ToolAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: { apply: true },

  locations(host: HostEnv): StoreDescriptor[] {
    const j = host.os === 'windows' ? win : posix
    const userDir = j(host.home, '.claude')
    const managed = managedRoot(host)

    // withConcepts() fills in any descriptor that did not declare one, so the
    // conditional plist/registry/remote entries below stay grouped in the UI.
    return withConcepts([
      // ---------------------------------------------------------------- managed
      // Highest precedence and NOT overridable. We read these purely so the UI
      // can tell a user "your org overrides this" instead of them filing a bug
      // when a write appears to do nothing. Never writable, never syncable.
      {
        id: 'claude-code:managed:settings',
        concept: 'permissions',
        scope: 'managed',
        location: { kind: 'file', path: j(managed, 'managed-settings.json'), format: 'json' }, // [V-doc]
        readable: true,
        writable: false,
        syncable: false,
        provenance: 'verified-doc',
      },
      {
        id: 'claude-code:managed:dropin',
        concept: 'permissions',
        scope: 'managed',
        location: { kind: 'dropin', path: j(managed, 'managed-settings.d'), format: 'json' }, // [V-doc]
        readable: true,
        writable: false,
        syncable: false,
        provenance: 'verified-doc',
      },
      // Policy delivered by MDM / Group Policy. NOT a file — this is why
      // StoreLocation is a union. A path-string-only design breaks here.
      ...(host.os === 'macos'
        ? ([
            {
              id: 'claude-code:managed:plist',
              scope: 'managed',
              location: { kind: 'plist', domain: 'com.anthropic.claudecode' }, // [V-doc]
              readable: true,
              writable: false,
              syncable: false,
              provenance: 'verified-doc',
            },
          ] as StoreDescriptor[])
        : []),
      ...(host.os === 'windows'
        ? ([
            {
              id: 'claude-code:managed:registry-machine',
              scope: 'managed',
              location: {
                kind: 'registry',
                hive: 'HKLM',
                key: 'SOFTWARE\\Policies\\ClaudeCode',
                value: 'Settings',
              }, // [V-doc]
              readable: true,
              writable: false,
              syncable: false,
              provenance: 'verified-doc',
            },
            {
              id: 'claude-code:managed:registry-user',
              scope: 'managed',
              location: {
                kind: 'registry',
                hive: 'HKCU',
                key: 'SOFTWARE\\Policies\\ClaudeCode',
                value: 'Settings',
              }, // [V-doc] user-level fallback
              readable: true,
              writable: false,
              syncable: false,
              provenance: 'verified-doc',
            },
          ] as StoreDescriptor[])
        : []),
      {
        // Pushed from the claude.ai admin console at sign-in. We can observe its
        // effect but never its source. Modeled so drift caused by it is
        // attributable rather than mysterious.
        id: 'claude-code:managed:server',
        scope: 'managed',
        location: { kind: 'remote', provider: 'anthropic-admin-console' }, // [V-doc]
        readable: false,
        writable: false,
        syncable: false,
        provenance: 'verified-doc',
      },

      // ------------------------------------------------------------------- user
      {
        id: 'claude-code:user:settings',
        concept: 'permissions',
        scope: 'user',
        location: { kind: 'file', path: j(userDir, 'settings.json'), format: 'json' }, // [V-fs]
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      {
        id: 'claude-code:user:memory',
        concept: 'rules',
        scope: 'user',
        location: { kind: 'file', path: j(userDir, 'CLAUDE.md'), format: 'markdown' }, // [V-fs]
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      {
        id: 'claude-code:user:keybindings',
        concept: 'editor',
        scope: 'user',
        location: { kind: 'file', path: j(userDir, 'keybindings.json'), format: 'json' }, // [I]
        readable: true,
        writable: true,
        syncable: true,
        provenance: 'inferred',
      },
      {
        id: 'claude-code:user:agents',
        concept: 'agent',
        scope: 'user',
        location: { kind: 'dir', path: j(userDir, 'agents') }, // [V-fs]
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      {
        id: 'claude-code:user:commands',
        concept: 'agent',
        scope: 'user',
        location: { kind: 'dir', path: j(userDir, 'commands') }, // [V-fs]
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      {
        // On a real install these entries are relative symlinks into ~/.agents.
        // Windows can't create symlinks unprivileged, so materialization is a
        // per-OS decision (junction or real copy) — see platform/links.ts.
        id: 'claude-code:user:skills',
        concept: 'skills',
        scope: 'user',
        location: { kind: 'dir', path: j(userDir, 'skills'), entryFile: 'SKILL.md' }, // [V-fs]
        readable: true,
        writable: true,
        syncable: false, // synced via the lockfile below, not by copying bytes
        provenance: fsVerified(host),
      },
      {
        // The real sync unit for skills: source repo + folder hash per skill.
        // This is a lockfile, so we sync ~15KB of JSON and re-resolve per device.
        id: 'claude-code:user:skill-lock',
        concept: 'skills',
        scope: 'user',
        location: { kind: 'file', path: j(host.home, '.agents', '.skill-lock.json'), format: 'json' }, // [V-fs] version 3
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      {
        // Same story for plugins: repo + version + gitCommitSha. Manifest only.
        id: 'claude-code:user:plugins',
        concept: 'agent',
        scope: 'user',
        location: { kind: 'file', path: j(userDir, 'plugins', 'installed_plugins.json'), format: 'json' }, // [V-fs] version 2
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      {
        id: 'claude-code:user:marketplaces',
        concept: 'agent',
        scope: 'user',
        location: { kind: 'file', path: j(userDir, 'plugins', 'known_marketplaces.json'), format: 'json' }, // [V-fs]
        readable: true,
        writable: true,
        syncable: true,
        provenance: fsVerified(host),
      },
      // ~/.claude.json braids real config together with identity and session
      // history. Subtree addressing lets us say that precisely instead of
      // shipping one syncable:true store with a warning comment and hoping the
      // never-sync key rules catch everything.
      //
      // Both descriptors share a fileId, so apply() coalesces them into a
      // single atomic read-modify-write.
      {
        id: 'claude-code:user:mcp',
        scope: 'user',
        location: { kind: 'file', path: j(host.home, '.claude.json'), format: 'json' }, // [V-fs]
        subtree: 'mcpServers',
        fileId: 'claude-code:user:global-config',
        concept: 'mcp',
        readable: true,
        writable: true,
        syncable: true, // genuinely portable config
        provenance: fsVerified(host),
      },
      {
        id: 'claude-code:user:global-config',
        scope: 'user',
        location: { kind: 'file', path: j(host.home, '.claude.json'), format: 'json' }, // [V-fs]
        fileId: 'claude-code:user:global-config',
        concept: 'other',
        readable: true,
        writable: true,
        // The remainder — oauthAccount, machineID, userID, projects, caches.
        // Never syncable, and now that is a property of the store rather than
        // something the key rules have to defend after the fact.
        syncable: false,
        provenance: fsVerified(host),
        provenanceNote:
          'Holds account identity and per-project history alongside config. Only the mcpServers subtree is syncable.',
      },

      // ---------------------------------------------------- project + local
      {
        id: 'claude-code:project:settings',
        concept: 'permissions',
        scope: 'project',
        location: { kind: 'file', path: j('.claude', 'settings.json'), format: 'json' }, // [V-doc]
        readable: true,
        writable: true,
        syncable: true,
        provenance: 'verified-doc',
      },
      {
        id: 'claude-code:project:mcp',
        concept: 'mcp',
        scope: 'project',
        location: { kind: 'file', path: '.mcp.json', format: 'json' }, // [V-doc]
        readable: true,
        writable: true,
        syncable: true,
        provenance: 'verified-doc',
      },
      {
        // Gitignored by convention and machine-specific by definition.
        // This is the layer that never leaves the device.
        id: 'claude-code:local:settings',
        concept: 'permissions',
        scope: 'local',
        location: { kind: 'file', path: j('.claude', 'settings.local.json'), format: 'json' }, // [V-doc]
        readable: true,
        writable: true,
        syncable: false,
        provenance: 'verified-doc',
      },
    ])
  },

  rules(): KeyRule[] {
    return [
      // ---------------------------------------------------------- never sync
      // Identity and session state living in ~/.claude.json. Syncing any of
      // these would either leak credentials or corrupt the target device.
      { match: 'oauthAccount', portability: 'never-sync', merge: 'never', secret: true },
      { match: 'machineID', portability: 'never-sync', merge: 'never' },
      { match: 'userID', portability: 'never-sync', merge: 'never' },
      { match: 'projects', portability: 'never-sync', merge: 'never' },
      { match: '*Cache', portability: 'never-sync', merge: 'never' },
      { match: 'numStartups', portability: 'never-sync', merge: 'never' },
      { match: 'firstStartTime', portability: 'never-sync', merge: 'never' },
      { match: 'tipsHistory', portability: 'never-sync', merge: 'never' },
      { match: 'seenNotifications', portability: 'never-sync', merge: 'never' },
      // Secrets by shape, wherever they appear. Belt and braces: the scanner
      // also refuses on value entropy, not just key name.
      { match: 'env.*_KEY', portability: 'never-sync', merge: 'never', secret: true },
      { match: 'env.*_TOKEN', portability: 'never-sync', merge: 'never', secret: true },
      { match: 'env.*_SECRET', portability: 'never-sync', merge: 'never', secret: true },
      { match: 'mcpServers.*.env.**', portability: 'never-sync', merge: 'never', secret: true },
      { match: 'apiKeyHelper', portability: 'machine-scoped', merge: 'replace', secret: true },

      // ------------------------------------------------------ machine-scoped
      // Absolute paths with the username baked in. Observed on a real install:
      //   installPath:     /Users/<user>/.claude/plugins/cache/<mkt>/<plugin>/<ver>
      //   installLocation: /Users/<user>/.claude/plugins/marketplaces/<mkt>
      // These get recomputed per device, never copied.
      { match: 'plugins.*.*.installPath', portability: 'machine-scoped', merge: 'replace' },
      { match: '*.installLocation', portability: 'machine-scoped', merge: 'replace' },
      { match: 'skills.*.skillPath', portability: 'machine-scoped', merge: 'replace' },

      // ----------------------------------------------------------- os-scoped
      // Hooks are shell commands and `defaultShell` is bash | powershell.
      // A macOS hook synced to Windows fails at runtime inside Claude Code and
      // the user blames us. So: hooks may never live in the `base` layer.
      { match: 'hooks.**', portability: 'os-scoped', merge: 'concat' },
      { match: 'defaultShell', portability: 'os-scoped', merge: 'replace' },
      { match: 'statusLine.**', portability: 'os-scoped', merge: 'replace' },
      { match: 'permissions.additionalDirectories', portability: 'os-scoped', merge: 'union-list' },

      // ------------------------------------------------------------ portable
      // Permission rules MERGE across scopes rather than override, so a
      // union-list (dedupe, order-insensitive) is the only correct strategy.
      // 'replace' here would silently drop rules the user still has active.
      { match: 'permissions.allow', portability: 'portable', merge: 'union-list' },
      { match: 'permissions.deny', portability: 'portable', merge: 'union-list' },
      { match: 'permissions.ask', portability: 'portable', merge: 'union-list' },
      { match: 'permissions.defaultMode', portability: 'portable', merge: 'replace' },

      { match: 'model', portability: 'portable', merge: 'replace' },
      { match: 'effortLevel', portability: 'portable', merge: 'replace' },
      { match: 'theme', portability: 'portable', merge: 'replace' },
      { match: 'editorMode', portability: 'portable', merge: 'replace' },
      { match: 'enabledPlugins', portability: 'portable', merge: 'deep-merge' },
      { match: 'extraKnownMarketplaces', portability: 'portable', merge: 'deep-merge' },
      { match: 'env.**', portability: 'portable', merge: 'deep-merge' },

      // MCP server definitions are portable in shape but their `command` is
      // executable and their `env` is secret-bearing — handled above.
      { match: 'mcpServers.*.command', portability: 'os-scoped', merge: 'replace' },
      { match: 'mcpServers.**', portability: 'portable', merge: 'deep-merge' },

      // Default for anything we don't recognize: pass through untouched.
      // These files are versioned internal formats (skill-lock v3, plugins v2)
      // and WILL gain keys we've never seen. Never rewrite what we don't model.
      { match: '**', portability: 'portable', merge: 'deep-merge' },
    ]
  },

  async detect(host: HostEnv): Promise<Detection> {
    const present: string[] = []
    for (const store of claudeCodeAdapter.locations(host)) {
      if (store.location.kind !== 'file' && store.location.kind !== 'dir') continue
      if (await pathExists(store.location.path)) present.push(store.id)
    }
    // A version probe would mean shelling out to `claude --version`, which we
    // deliberately avoid: reading config must never execute the tool we are
    // configuring.
    //
    // Evidence is RANKED rather than counted. Shared roots (`~/.agents/skills`)
    // prove nothing — Cursor and Codex read them too. Project-scope files prove
    // nothing about the machine. And a config file we can WRITE is only weak
    // evidence, because a file we left behind would otherwise keep vouching for
    // a tool that has since been uninstalled.
    const found = claudeCodeAdapter
      .locations(host)
      .filter((s) => present.includes(s.id))
      .map((s) => classifyInstallEvidence(s))

    const { installed, confidence } = decideInstalled(found)
    return { installed, confidence, present }
  },

  async read(store: StoreDescriptor, host: HostEnv, ctx?: ProjectContext): Promise<ConfigDoc> {
    void host
    // Resolve through the shared helper so a project-scope store reads the same
    // file `apply()` will later write. Without this the read resolved against
    // process.cwd() and the write against projectRoot — different files.
    const loc =
      store.location.kind === 'file' ||
      store.location.kind === 'dir' ||
      store.location.kind === 'dropin'
        ? { ...store.location, path: resolveStorePath(store.location.path, ctx) }
        : store.location

    if (loc.kind === 'file') {
      const raw = await readFileOrNull(loc.path)
      if (raw === null)
        return { storeId: store.id, data: loc.format === 'markdown' ? '' : {}, hash: '', exists: false }

      const text = stripBom(raw)
      if (loc.format === 'markdown')
        return { storeId: store.id, data: text, hash: sha256Hex(canonicalizeText(text)), exists: true }

      const whole = parseJsonLenient(text, store.id)
      // A descriptor with a `subtree` owns only that branch of the file. It must
      // read, hash and diff the branch alone — otherwise two descriptors over
      // one file would both report drift whenever either side changed.
      const data = store.subtree ? (getPath(whole, store.subtree) ?? {}) : whole

      return {
        storeId: store.id,
        data,
        // Hash the CANONICAL form, not the raw bytes: a file that differs only
        // by key order or line endings is not drift, and reporting it as drift
        // would make the matrix permanently red on mixed-OS fleets.
        hash: sha256Hex(canonicalJson(data)),
        // Raw bytes travel with the doc so apply() can do a format-preserving
        // write and keep the user's comments and indentation.
        raw: new TextEncoder().encode(raw),
        ...(typeof (whole as { version?: unknown })?.version === 'number'
          ? { schemaVersion: (whole as { version: number }).version }
          : {}),
        exists: true,
      }
    }

    if (loc.kind === 'dir') {
      const entries = await listDirEntries(loc.path, loc.entryFile)

      // Installed packages: their identity is which ones are present. The
      // bytes belong to the installer and are re-resolved from a lockfile, so
      // reading them would invite a diff we must never act on.
      if (loc.entryFile) {
        return {
          storeId: store.id,
          data: entries,
          hash: sha256Hex(canonicalJson(entries)),
          exists: entries.length > 0,
        }
      }

      // Authored entries: the CONTENT is the thing. Sub-agents and slash
      // commands are files the user wrote, with no source to re-resolve from,
      // so the document is a map of entry name to file contents — which is
      // also what makes them diffable at all.
      const files: Record<string, string> = {}
      for (const name of entries) {
        const text = await readFileOrNull(`${loc.path}/${name}`)
        if (text !== null) files[name] = canonicalizeText(stripBom(text))
      }
      return {
        storeId: store.id,
        data: files,
        hash: sha256Hex(canonicalJson(files)),
        exists: entries.length > 0,
      }
    }

    if (loc.kind === 'dropin') {
      // Fragments merge in lexical filename order, matching how drop-in
      // directories are conventionally consumed.
      const names = (await listDirEntries(loc.path)).sort()
      const merged: Record<string, unknown> = {}
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const raw = await readFileOrNull(`${loc.path}/${name}`)
        if (raw === null) continue
        Object.assign(merged, parseJsonLenient(stripBom(raw), `${store.id}/${name}`))
      }
      return { storeId: store.id, data: merged, hash: sha256Hex(canonicalJson(merged)), exists: names.length > 0 }
    }

    // plist / registry / remote need a platform channel this adapter does not
    // own. Throwing beats returning an empty doc, which would read as "your org
    // has no policy" when the truth is "we didn't look".
    throw new UnsupportedStoreError(store.id, loc.kind)
  },

  plan(desired: DesiredState, observed: ConfigDoc[], host: HostEnv): Plan {
    const managed = observed.find((d) => d.storeId.startsWith('claude-code:managed:'))
    return buildPlan({
      deviceId: host.deviceId,
      toolId: 'claude-code',
      desired: documentOf(desired),
      // Managed docs are context for override detection, not write targets.
      observed: observed.filter((d) => !d.storeId.startsWith('claude-code:managed:')),
      rules: claudeCodeAdapter.rules(),
      ...(managed ? { managed: managed.data as Record<string, unknown> } : {}),
      now: '', // caller stamps; plan() must not read the clock
    })
  },

  async apply(plan: Plan, host: HostEnv): Promise<ApplyResult> {
    return applyPlan(plan, {
      adapter: claudeCodeAdapter,
      host,
      now: () => new Date().toISOString(),
    })
  },

  async rollback(rollbackId: string, host: HostEnv): Promise<void> {
    return rollbackApply(rollbackId, {
      adapter: claudeCodeAdapter,
      host,
      now: () => new Date().toISOString(),
    })
  },

  canonicalize(doc: ConfigDoc): string {
    return typeof doc.data === 'string' ? canonicalizeText(doc.data) : canonicalJson(doc.data)
  },
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

export class UnsupportedStoreError extends Error {
  constructor(storeId: string, kind: string) {
    super(
      `Store "${storeId}" has location kind "${kind}"; reading it needs a platform channel ` +
        `(MDM query / registry read / vendor API) this adapter does not own.`,
    )
    this.name = 'UnsupportedStoreError'
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * Entries in a config directory, excluding anything dot-prefixed.
 *
 * The filter is load-bearing, not hygiene. `withBackup` writes to
 * `<dirname>/.agent-backups`, so for a DIRECTORY store our own backups land
 * inside the very directory we then read back — and would be picked up as
 * sub-agents on the next pass, then synced to every other machine. Legitimate
 * entries here are authored `.md` files or package folders; a leading dot is
 * never one. This also drops `.DS_Store` and friends.
 */
async function listDirEntries(dir: string, entryFile?: string): Promise<string[]> {
  try {
    const names = (await readdir(dir)).filter((n) => !n.startsWith('.'))
    if (!entryFile) return names
    // A skill/agent directory only counts if it actually contains its manifest.
    const out: string[] = []
    for (const n of names) if (await pathExists(`${dir}/${n}/${entryFile}`)) out.push(n)
    return out
  } catch {
    return []
  }
}

/**
 * Claude Code accepts trailing commas and comments in its JSON settings, so a
 * strict parse would reject files the tool itself happily loads.
 *
 * Comments are stripped HERE only to produce a parsed value for diffing. They
 * are NOT lost on write: `apply()` routes existing JSON/JSONC files through the
 * format-preserving writer in `platform/jsonc.ts`, which splices only the span
 * of the value being changed. `ConfigDoc.raw` carries the original bytes across
 * for exactly that purpose.
 */
function parseJsonLenient(text: string, storeId: string): unknown {
  const stripped = text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1')
  if (!stripped.trim()) return {}
  try {
    return JSON.parse(stripped)
  } catch (e) {
    throw new Error(`"${storeId}" is not valid JSON/JSONC: ${(e as Error).message}`)
  }
}
