/**
 * Zed adapter — ADVERSARIAL SPIKE.
 *
 * Tag convention matches claude-code.ts / cursor.ts:
 *   [V-doc] verified against official Zed docs. The exact page is cited ON the
 *           line. Docs live at zed.dev/docs/<page> and are generated from
 *           github.com/zed-industries/zed/blob/main/docs/src/<page>.md — where a
 *           line cites `docs/src/x.md` it was read from the raw markdown source,
 *           which is the authoritative text.
 *   [V-fs]  verified by inspecting a real install
 *   [I]     inferred — needs CI / real-device confirmation
 *
 * NOTHING here is [V-fs]. The machine this adapter was authored on has no Zed
 * install: `/Applications/Zed.app`, `~/Applications/Zed.app`, `~/.config/zed`,
 * `~/Library/Application Support/Zed`, `~/.zed` are all absent and `zed` is not
 * on PATH (checked 2026-07-29). Docs are therefore the ceiling, and `detect()`
 * is what closes the gap on a real device.
 *
 * WHY THIS ADAPTER EXISTS: to find out whether `ToolAdapter` survives a tool
 * that does NOT use file-per-concept. It did not. Zed collapses agent config,
 * MCP servers, model providers, editor preferences and language-server config
 * into ONE JSONC file. The interface assumed store ≈ concept, so the sync unit
 * came out wrong. That break was recorded as data in `SHARED_FILE_CONCEPTS`,
 * `UNREPRESENTABLE_STORES` and `INTERFACE_GAPS` below — deliberately NOT papered
 * over by inventing descriptors the type could not honestly support — and argued
 * in docs/zed-spike.md.
 *
 * SINCE THEN the two gaps that mattered have been closed and this is no longer
 * only a spike: `StoreDescriptor.subtree`/`fileId` let each concept be its own
 * store over the shared file, `ConfigDoc.raw` plus `platform/jsonc.ts` make a
 * write preserve the comments Zed users keep in settings.json, and `apply()`
 * delegates to the one shared engine, which coalesces the subtree stores into a
 * single atomic read-modify-write. The entries below are kept as a record and
 * marked where they have been resolved; the ones still open are still open.
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
  ROOT_PATH,
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
// Path helpers (same shape as cursor.ts — locations() must be able to produce a
// Windows table while running on the macOS control plane, so node:path is not
// usable here).
// ---------------------------------------------------------------------------

const posix = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
const win = (...parts: string[]) => parts.join('\\').replace(/\\+/g, '\\')

/** WSL is a Linux userland: posix separators, posix config root. */
const joiner = (host: HostEnv) => (host.os === 'windows' && host.runtime === 'native' ? win : posix)

// ---------------------------------------------------------------------------
// Store ids
// ---------------------------------------------------------------------------

export const STORE = {
  userSettings: 'zed:user:settings',
  userKeymap: 'zed:user:keymap',
  userTasks: 'zed:user:tasks',
  userInstructions: 'zed:user:instructions',
  userSkills: 'zed:user:skills',
  projectSettings: 'zed:project:settings',
  projectTasks: 'zed:project:tasks',
  projectSkills: 'zed:project:skills',
  /** Prefix; the concrete ids are `${projectInstructions}:${slug}`. */
  projectInstructions: 'zed:project:instructions',
  remoteAdminControls: 'zed:managed:admin-controls',
} as const

// ---------------------------------------------------------------------------
// THE HEADLINE FINDING — one file, many concepts.
//
// Claude Code and Cursor give every concept its own file, so `StoreDescriptor`
// (one id, one location, one `syncable` flag) doubles as the unit of sync. Zed
// does not. Every entry below is a PEER TOP-LEVEL KEY in the SAME
// `~/.config/zed/settings.json`.
//
// `StoreDescriptor.syncable: boolean` (src/core/types.ts:91) therefore has no
// correct value for `zed:user:settings`:
//   - `true`  => syncing your MCP servers also syncs `buffer_font_size` and
//               `theme` to every device. Wrong.
//   - `false` => you cannot sync MCP servers at all. Also wrong.
//
// We emit ONE descriptor per physical file, because that is what the type can
// truthfully describe, and record the concept split here as data. The proposed
// type change (a `subtree` field on StoreDescriptor) is in docs/zed-spike.md.
// ---------------------------------------------------------------------------

export interface SettingsConcept {
  /** Vendor-neutral concept name — the thing a user actually wants to sync. */
  concept: string
  /** Top-level dot-path root inside settings.json that carries it. */
  subtree: string
  /** Would the user want this to travel between devices? */
  wantsSync: boolean
  provenance: string
}

export const SHARED_FILE_CONCEPTS: readonly SettingsConcept[] = [
  {
    concept: 'agent-config',
    subtree: 'agent',
    wantsSync: true,
    provenance: '[V-doc] ai/agent-settings — "agent" is a top-level settings.json key',
  },
  {
    concept: 'mcp-servers',
    subtree: 'context_servers',
    wantsSync: true,
    provenance: '[V-doc] ai/mcp — MCP servers are `context_servers`, inside settings.json',
  },
  {
    concept: 'external-agents',
    subtree: 'agent_servers',
    wantsSync: true,
    provenance: '[V-doc] ai/external-agents — ACP agent servers, inside settings.json',
  },
  {
    concept: 'model-providers',
    subtree: 'language_models',
    wantsSync: true,
    provenance: '[V-doc] ai/use-api-access — non-secret provider config only; keys are in the keychain',
  },
  {
    concept: 'language-servers',
    subtree: 'lsp',
    wantsSync: true,
    provenance: '[V-doc] reference/all-settings — "Configuration for language servers"',
  },
  {
    concept: 'editor-appearance',
    subtree: 'theme',
    wantsSync: false,
    provenance: '[V-doc] configuring-zed — user-scope-only setting, peer of `agent`',
  },
  {
    concept: 'editor-appearance',
    subtree: 'buffer_font_size',
    wantsSync: false,
    provenance: '[V-doc] reference/all-settings — "The default font size for text in the editor"',
  },
  {
    concept: 'editor-behavior',
    subtree: 'vim_mode',
    wantsSync: false,
    provenance: '[V-doc] configuring-zed — user-scope-only, peer of `agent`',
  },
  {
    concept: 'terminal',
    subtree: 'terminal',
    wantsSync: false,
    provenance: '[V-doc] reference/all-settings — "Configuration for the terminal"',
  },
  {
    concept: 'telemetry',
    subtree: 'telemetry',
    wantsSync: false,
    provenance: '[V-doc] reference/all-settings — "Control what info is collected by Zed"',
  },
] as const

/**
 * Project-level instruction files, in the order Zed consults them.
 *
 * [V-doc] docs/src/ai/instructions.md: "Zed uses the first matching file in this
 * list". FIRST MATCH WINS — this is NOT additive, which makes it a different
 * hazard from Cursor (Cursor reads AGENTS.md *and* .cursor/rules, so the risk
 * there is double-application; here the risk is silent SHADOWING).
 *
 * `StoreDescriptor` has no way to express "live only if every higher-precedence
 * file is absent", so liveness is computed in plan() instead. See INTERFACE_GAPS.
 */
export const INSTRUCTION_CHAIN = [
  { slug: 'rules', file: '.rules', owner: 'zed' },
  { slug: 'cursorrules', file: '.cursorrules', owner: 'cursor' },
  { slug: 'windsurfrules', file: '.windsurfrules', owner: 'windsurf' },
  { slug: 'clinerules', file: '.clinerules', owner: 'cline' },
  { slug: 'copilot-instructions', file: '.github/copilot-instructions.md', owner: 'copilot' },
  { slug: 'agent-md', file: 'AGENT.md', owner: 'shared' },
  { slug: 'agents-md', file: 'AGENTS.md', owner: 'shared' },
  { slug: 'claude-md', file: 'CLAUDE.md', owner: 'claude-code' },
  { slug: 'gemini-md', file: 'GEMINI.md', owner: 'gemini' },
] as const

/**
 * Real Zed state that `StoreLocation` cannot express. Surfaced as data so the UI
 * can say "we know, and we deliberately do not touch this" rather than implying
 * Zed has no such state. Same precedent as cursor.ts.
 */
export const UNREPRESENTABLE_STORES = [
  {
    what: 'LLM provider API keys',
    path: 'OS keychain (macOS Keychain / libsecret / Windows Credential Manager)',
    why:
      'StoreLocation has no `keychain` kind. Zed stores keys entered through the UI in the system ' +
      'keychain, NOT settings.json, so the most security-relevant agent config is invisible to us. ' +
      'Correct outcome — but it is a gap in the model, not an absence of state.',
    provenance:
      '[V-doc] docs/src/ai/use-api-access.md — "Keys saved through Zed are stored in the system keychain, not in `settings.json`."',
  },
  {
    what: 'Worktree trust decisions',
    path: 'Zed-internal local database (not documented as a file)',
    why:
      "StoreLocation has no `sqlite`/opaque-state kind. Until a worktree is trusted, everything in " +
      '`.zed/settings.json` is INERT — so a plan can apply cleanly and still change nothing. ' +
      'Whether a write takes effect depends on state we cannot read.',
    provenance:
      '[V-doc] docs/src/worktree-trust.md — Restricted Mode prevents "Project settings (`.zed/settings.json`) from being parsed and applied"; trust "persists between restarts"; cleared via `workspace::ClearTrustedWorktrees`.',
  },
  {
    what: 'JSONC comments in settings.json / keymap.json — RESOLVED, kept as a record',
    path: '<user settings>/settings.json',
    why:
      'Was: `ConfigDoc` holds parsed `data` only and `canonicalize()` round-trips through JSON, so a ' +
      'write would silently delete every comment — the worst outcome for the most comment-dense config ' +
      'in the survey, since Zed\'s docs teach users to keep commented-out examples inline. NOW FIXED: ' +
      '`ConfigDoc.raw` carries the original bytes and `platform/jsonc.ts` edits only the value spans ' +
      'that changed, so comments, blank lines, key order and trailing commas are never rewritten. ' +
      'Still lossy in one place: `canonicalize()` is a HASHING function and remains comment-blind, ' +
      'which is correct — a comment change is not a config change.',
    provenance: '[V-doc] docs/src/configuring-zed.md — "The syntax is JSON with support for `//` comments."',
  },
  {
    what: 'Enterprise / managed policy layer',
    path: 'n/a — DOES NOT EXIST',
    why:
      'Zed has NO MDM profile, NO Group Policy, NO /etc drop-in, NO managed-settings file. The Zed ' +
      'Business admin dashboard is server-side only. Recorded explicitly because "we found nothing" ' +
      'and "we did not look" are indistinguishable in a path table that simply omits the scope.',
    provenance:
      '[V-doc] docs/src/business/admin-controls.md — "Most controls apply server-side to anything that routes through Zed\'s infrastructure."; docs/src/SUMMARY.md lists no MDM/policy/managed-settings page.',
  },
] as const

/**
 * Defects in `ToolAdapter` / `core/reconcile.ts` that this spike hit, recorded as
 * data rather than prose so they can be tracked and asserted against. Each names
 * the failing case. Argued in full in docs/zed-spike.md.
 */
export const INTERFACE_GAPS = [
  {
    id: 'no-subfile-addressing',
    surface: 'src/core/types.ts StoreDescriptor.subtree / .fileId — CLOSED',
    failingCase:
      '`~/.config/zed/settings.json` holds `context_servers` (MCP) and `buffer_font_size` as peer ' +
      'top-level keys. A user syncing MCP servers does not want their font size synced, but `syncable` ' +
      'was a per-FILE boolean. There was no honest value for it.',
    proposal:
      'DONE: `subtree` + `fileId` exist and this adapter emits one descriptor per concept over the one ' +
      'file. read() returns and hashes only its branch; apply() coalesces by fileId into a single ' +
      'atomic read-modify-write and rebases each change back onto the whole document. Residual sharp ' +
      'edge: `validatePlan`\'s whole-document-vs-keyed contradiction check groups by storeId, not ' +
      'fileId, so a root replacement on one descriptor plus keyed edits on a sibling subtree of the ' +
      'SAME file are not caught — the root edit wins in editMany and the rest are dropped silently.',
  },
  {
    id: 'array-rooted-documents-invisible',
    surface: 'src/core/reconcile.ts:381 flatten()',
    failingCase:
      '`flatten(value)` returns `[]` when the root is an array (isPlainObject rejects arrays, and the ' +
      'prefix is empty). Zed `keymap.json` and `tasks.json` are BOTH top-level JSON arrays, so the ' +
      'reconcile engine produces ZERO changes for them — a silent no-op, not an error. Claude Code and ' +
      'Cursor are object-rooted everywhere, so this never surfaced.',
    proposal:
      'flatten() must index arrays (or plan() must fall back to whole-document ops). This adapter uses ' +
      'the whole-document fallback and warns; see planArrayRooted().',
  },
  {
    id: 'strictness-cannot-rank-ordered-enums',
    surface: 'src/core/types.ts:139 Strictness',
    failingCase:
      '`agent.tool_permissions.default` is one of "allow" | "confirm" | "deny" — an ORDERED 3-valued ' +
      'enum where deny > confirm > allow in strictness. None of the six Strictness members can express ' +
      'that: it is not boolean, not numeric, not a list. We set merge:"never" (refuse to write) because ' +
      'a wrong guess here silently widens agent tool permissions.',
    proposal: "Add `{ kind: 'ordinal'; order: string[] }` to Strictness; see docs/zed-spike.md §5.",
  },
  {
    id: 'no-conditional-liveness',
    surface: 'src/core/types.ts:84 StoreDescriptor',
    failingCase:
      'Zed reads exactly ONE project instruction file — the first of nine that exists. Whether ' +
      '`CLAUDE.md` is live depends on whether `.rules` exists. `StoreDescriptor` has no way to say ' +
      '"live only if these other stores are absent", so liveness must be recomputed in plan().',
    proposal: 'Add `activeWhen?: { absent: string[] }` to StoreDescriptor, or a first-match store group.',
  },
  {
    id: 'no-effect-gate',
    surface: 'src/core/types.ts:202 Plan / ApplyResult',
    failingCase:
      'An untrusted Zed worktree parses no project settings at all, so `apply()` can report full ' +
      'success while changing nothing observable. `Change.overriddenBy?: Scope` cannot express ' +
      '"written but inert pending an out-of-band user action".',
    proposal: "Widen to `inertBecause?: 'untrusted-worktree' | ...` or add a Change.effective flag.",
  },
] as const

// ---------------------------------------------------------------------------
// Path table
// ---------------------------------------------------------------------------

/**
 * Zed's user config directory.
 * [V-doc] docs/src/configuring-zed.md prints, verbatim:
 *   macOS:   `~/.config/zed/settings.json`
 *   Linux:   `~/.config/zed/settings.json` (or `$XDG_CONFIG_HOME/zed/settings.json`)
 *   Windows: `%APPDATA%\Zed\settings.json`
 * Note macOS uses ~/.config, NOT ~/Library/Application Support — unusual for a
 * macOS app and the kind of thing a "reasoned from convention" guess gets wrong.
 */
function userConfigDir(host: HostEnv): string {
  const j = joiner(host)
  switch (host.os) {
    case 'macos':
      return j(host.home, '.config', 'zed') // [V-doc] configuring-zed
    case 'linux':
      // $XDG_CONFIG_HOME would relocate this; HostEnv carries no environment,
      // so plan() raises a warning instead. [V-doc] configuring-zed
      return j(host.home, '.config', 'zed')
    case 'windows':
      // WSL is a Linux userland and uses the posix root.
      return host.runtime === 'wsl'
        ? posix(host.home, '.config', 'zed')
        : win(host.appData ?? win(host.home, 'AppData', 'Roaming'), 'Zed') // [V-doc] configuring-zed
  }
}

/** Zed's local concept slugs -> the shared vendor-neutral `Concept` union. */
function conceptForZed(slug: string): Concept {
  switch (slug) {
    case 'agent-config':
    case 'external-agents':
    case 'model-providers':
      return 'agent'
    case 'mcp-servers':
      return 'mcp'
    case 'editor-appearance':
    case 'editor-behavior':
    case 'terminal':
    case 'language-servers':
      return 'editor'
    default:
      return 'other'
  }
}

function locations(host: HostEnv, ctx?: ProjectContext): StoreDescriptor[] {
  const j = joiner(host)
  const cfg = userConfigDir(host)
  const out: StoreDescriptor[] = []

  /**
   * Project paths are repo-relative by house convention (claude-code.ts,
   * cursor.ts) and read() resolves them against cwd. `ProjectContext` now exists
   * on the interface, so when a caller supplies a root we honor it — that is the
   * fix adapter-fit.md §5c asked for, exercised.
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
    opts: {
      writable?: boolean
      syncable?: boolean
      provenance?: Provenance
      note?: string
      concept?: Concept
      activeWhen?: { absent: string[] }
      subtree?: string
      fileId?: string
    } = {},
  ): void => {
    out.push({
      id,
      scope,
      location: { kind: 'file', path, format },
      readable: true,
      writable: opts.writable ?? true,
      syncable: opts.syncable ?? true,
      ...(opts.concept ? { concept: opts.concept } : {}),
      ...(opts.activeWhen ? { activeWhen: opts.activeWhen } : {}),
      ...(opts.subtree ? { subtree: opts.subtree } : {}),
      ...(opts.fileId ? { fileId: opts.fileId } : {}),
      // No Zed install existed on the authoring host, so nothing is
      // 'verified-fs' — docs are the ceiling until CI runs against a real one.
      provenance: opts.provenance ?? 'verified-doc',
      ...(opts.note ? { provenanceNote: opts.note } : {}),
    })
  }

  // ----------------------------------------------------------------- managed
  // Zed has NO local managed layer — no MDM domain, no registry policy, no
  // /etc drop-in, no managed-settings.json. This is the first tool in the
  // survey with nothing to put in `managed` scope, and it is worth stating
  // rather than silently omitting. [V-doc] docs/src/business/admin-controls.md
  //
  // The one thing that exists is the Zed Business dashboard. It is modeled as
  // `remote` (like claude-code:managed:server) so that behavior differences it
  // causes are attributable rather than mysterious — but note the crucial
  // difference from Claude Code's managed settings: it does NOT override
  // settings.json keys. It gates server-side model/data access, plus one
  // client-side enforcement (collaboration). It can never win a key fight,
  // so nothing in `plan()` treats it as an override.
  out.push({
    id: STORE.remoteAdminControls,
    scope: 'managed',
    location: { kind: 'remote', provider: 'zed-business-dashboard' }, // [V-doc] business/admin-controls
    readable: false,
    writable: false,
    syncable: false,
    provenance: 'verified-doc',
    provenanceNote:
      'Server-side only. Unlike Claude Code / Cursor managed settings this does NOT deliver ' +
      'key-level overrides to the local config, so it cannot override a settings.json value.',
  })

  // -------------------------------------------------------------------- user
  // ONE file, ~10 concepts. See SHARED_FILE_CONCEPTS.
  // settings.json holds `agent`, `context_servers`, `theme` and `buffer_font_size`
  // as PEER top-level keys. One descriptor per file could not answer "is this
  // syncable?" — the whole reason `subtree` was added to StoreDescriptor.
  //
  // Now each concept is its own descriptor over the same file, sharing a
  // `fileId` so apply() coalesces them into a single atomic read-modify-write.
  // SHARED_FILE_CONCEPTS stops being inert documentation and becomes the table.
  for (const c of SHARED_FILE_CONCEPTS) {
    file(
      `${STORE.userSettings}#${c.subtree}`,
      'user',
      j(cfg, 'settings.json'),
      'jsonc', // [V-doc] configuring-zed
      {
        subtree: c.subtree,
        fileId: STORE.userSettings,
        syncable: c.wantsSync,
        concept: conceptForZed(c.concept),
        note: c.provenance,
      },
    )
  }
  // The remainder of settings.json — every key not claimed above. Read so drift
  // is visible; never synced, because we cannot know what is in it.
  //
  // NOTE it deliberately reads the WHOLE document rather than subtracting the
  // claimed subtrees, matching `claude-code:user:global-config`. apply() relies
  // on that: phase 3 looks up `docs.get(fileId)` for the whole-document value it
  // rebases subtree changes onto, and `fileId` IS this descriptor's id.
  file(STORE.userSettings, 'user', j(cfg, 'settings.json'), 'jsonc', {
    syncable: false,
    fileId: STORE.userSettings,
    concept: 'other',
    note: 'Unclaimed remainder of settings.json. Readable for drift detection; not syncable.',
  })

  // keymap.json is a top-level JSON ARRAY — invisible to reconcile's flatten().
  // [V-doc] docs/src/key-bindings.md: "a JSON array of objects with `bindings`".
  file(STORE.userKeymap, 'user', j(cfg, 'keymap.json'), 'jsonc') // [V-doc] key-bindings

  // tasks.json is also array-rooted, and every entry is a shell command.
  // [V-doc] docs/src/tasks.md: "This file is usually located in `~/.config/zed/tasks.json`."
  // Windows leaf is [I] — tasks.md only prints the tilde form.
  file(STORE.userTasks, 'user', j(cfg, 'tasks.json'), 'jsonc', {
    ...(host.os === 'windows' && host.runtime === 'native'
      ? {
          provenance: 'inferred' as Provenance,
          note: 'tasks.md prints only `~/.config/zed/tasks.json`; the %APPDATA%\\Zed leaf is inferred from the settings.json/keymap.json pattern.',
        }
      : {}),
  })

  // [V-doc] docs/src/ai/instructions.md — global rules append to
  // `~/.config/zed/AGENTS.md` (macOS/Linux) or `%APPDATA%\Zed\AGENTS.md`.
  file(STORE.userInstructions, 'user', j(cfg, 'AGENTS.md'), 'markdown') // [V-doc] ai/instructions

  // [V-doc] docs/src/ai/skills.md — global skills at `~/.agents/skills/`.
  // Note this is the SAME `~/.agents` tree Claude Code and Cursor use, so it is
  // a genuine cross-tool shared store, not a Zed-specific one.
  out.push({
    id: STORE.userSkills,
    scope: 'user',
    location: { kind: 'dir', path: j(host.home, '.agents', 'skills'), entryFile: 'SKILL.md' }, // [V-doc] ai/skills
    readable: true,
    writable: true,
    // Installed packages: re-resolved per device from a lockfile, and
    // `writeVerdict` refuses them. Claiming they sync would be two answers to
    // one question — the same mistake `claude-code:user:skills` avoids.
    syncable: false,
    provenance: 'verified-doc',
  })

  // ----------------------------------------------------- project (relative)
  // [V-doc] configuring-zed — ".zed/settings.json file in your project root";
  // subdirectories may also carry one (not enumerated here — we would have to
  // walk the tree, which locations() cannot do because it is pure).
  file(STORE.projectSettings, 'project', proj('.zed', 'settings.json'), 'jsonc') // [V-doc] configuring-zed

  // [V-doc] docs/src/tasks.md — "worktree-specific (local) `.zed/tasks.json`".
  file(STORE.projectTasks, 'project', proj('.zed', 'tasks.json'), 'jsonc') // [V-doc] tasks

  // [V-doc] docs/src/ai/skills.md — project skills at `<worktree>/.agents/skills/`.
  out.push({
    id: STORE.projectSkills,
    scope: 'project',
    location: { kind: 'dir', path: proj('.agents', 'skills'), entryFile: 'SKILL.md' }, // [V-doc] ai/skills
    readable: true,
    writable: true,
    // Installed packages: re-resolved per device from a lockfile, and
    // `writeVerdict` refuses them. Claiming they sync would be two answers to
    // one question — the same mistake `claude-code:user:skills` avoids.
    syncable: false,
    provenance: 'verified-doc',
  })

  // The nine-file instruction chain. [V-doc] docs/src/ai/instructions.md
  //
  // We emit ALL nine even though eight are owned by other adapters, which looks
  // like it violates cursor.ts's "two adapters must not own one path" rule. It
  // does not: they are emitted READ-ONLY. Zed's behavior depends on which files
  // EXIST, so plan() cannot compute whether CLAUDE.md is live without observing
  // the whole chain. Reading is required; writing stays with the owning adapter.
  //
  // `.rules` is the only one we write: it is Zed-native, no other tool reads it,
  // and it is first in precedence.
  for (const [i, entry] of INSTRUCTION_CHAIN.entries()) {
    const zedOwned = entry.owner === 'zed'
    // First-match-wins: this file is live only when every HIGHER-precedence
    // file in the chain is absent. Encoding it as `activeWhen` is what lets the
    // UI warn that creating `.rules` turns `CLAUDE.md` OFF for Zed — a write
    // that looks purely additive but is destructive to the existing setup.
    const earlier = INSTRUCTION_CHAIN.slice(0, i).map(
      (e) => `${STORE.projectInstructions}:${e.slug}`,
    )
    file(
      `${STORE.projectInstructions}:${entry.slug}`,
      'project',
      proj(...entry.file.split('/')),
      'markdown',
      {
        concept: 'rules',
        ...(earlier.length ? { activeWhen: { absent: earlier } } : {}),
        ...(zedOwned
          ? {}
          : {
              writable: false,
              syncable: false,
              note: `Read-only here: Zed consumes this file but the "${entry.owner}" adapter owns writes to it. Observed only so plan() can compute first-match liveness.`,
            }),
      },
    )
  }

  return withConcepts(out)
}

// ---------------------------------------------------------------------------
// Portability + merge rules
//
// core/reconcile.ts `ruleFor` picks the MOST SPECIFIC match, so ordering here is
// for humans, not for semantics. The `**` fallback is mandatory.
// ---------------------------------------------------------------------------

function rules(storeId?: string): KeyRule[] {
  const base: KeyRule[] = [
    // ------------------------------------------------------------ never-sync
    // [V-doc] docs/src/ai/mcp.md prints `"headers": { "Authorization": "Bearer <token>" }`
    // and an `env` object for stdio servers. Both are credential carriers.
    { match: 'context_servers.*.env.**', portability: 'never-sync', merge: 'never', secret: true },
    { match: 'context_servers.*.headers.**', portability: 'never-sync', merge: 'never', secret: true },
    // [V-doc] docs/src/ai/external-agents.md — agent_servers entries carry `env`.
    { match: 'agent_servers.*.env.**', portability: 'never-sync', merge: 'never', secret: true },
    // [V-doc] docs/src/ai/use-api-access.md — the documented `language_models`
    // example is literally `"Fancy-Auth": "Bearer <your-fancy-key>"`. Zed tells
    // users NOT to put keys in settings.json, but this is the field where they
    // do it anyway, so we refuse it by shape.
    { match: 'language_models.*.custom_headers.**', portability: 'never-sync', merge: 'never', secret: true },
    // Defensive: not a documented key, but users paste keys here regardless.
    { match: 'language_models.*.api_key', portability: 'never-sync', merge: 'never', secret: true }, // [I]

    // -------------------------------------------------------- machine-scoped
    // [V-doc] docs/src/ai/sandboxing.md — the documented example is
    // `"write_paths": ["/Users/you/.cache/my-tool"]`: absolute and device-local.
    { match: 'agent.sandbox_permissions.write_paths', portability: 'machine-scoped', merge: 'union-list' },
    // Language server binary overrides are absolute paths into a toolchain.
    { match: 'lsp.*.binary.path', portability: 'machine-scoped', merge: 'replace' }, // [I] key shape

    // ------------------------------------------------------------- os-scoped
    // [V-doc] docs/src/ai/mcp.md — stdio servers name an executable and its argv.
    // Neither survives macOS -> Windows.
    { match: 'context_servers.*.command', portability: 'os-scoped', merge: 'replace' },
    { match: 'context_servers.*.args', portability: 'os-scoped', merge: 'replace' },
    // [V-doc] docs/src/ai/external-agents.md — same story: `"command": "node"`.
    { match: 'agent_servers.*.command', portability: 'os-scoped', merge: 'replace' },
    { match: 'agent_servers.*.args', portability: 'os-scoped', merge: 'replace' },

    // Tool-permission patterns are RUST REGEXES OVER SHELL COMMANDS.
    // [V-doc] docs/src/ai/tool-permissions.md: "Patterns use Rust regex syntax."
    // The documented example is `{ "pattern": "^cargo\\s+(build|test|check)" }`.
    // Two independent reasons these are os-scoped:
    //   1. they name real binaries (`rm` vs `del`, `sudo` has no Windows peer);
    //   2. our own KeyRule.match glob syntax and Rust regex are DIFFERENT
    //      languages, so any translation between our rules and Zed's is lossy —
    //      and lossy in the direction that silently WIDENS a grant.
    //
    // Strictness matters here and is not decoration:
    //   always_allow  WIDENS  permission -> intersect, so a merge can only narrow
    //   always_deny   NARROWS permission -> union,     so a merge can only widen the ban
    {
      match: 'agent.tool_permissions.tools.*.always_allow',
      portability: 'os-scoped',
      merge: 'most-restrictive',
      strictness: 'intersection',
    },
    {
      match: 'agent.tool_permissions.tools.*.always_deny',
      portability: 'os-scoped',
      merge: 'most-restrictive',
      strictness: 'union',
    },
    {
      match: 'agent.tool_permissions.tools.*.always_confirm',
      portability: 'os-scoped',
      merge: 'most-restrictive',
      strictness: 'union',
    },

    // REFUSED — see INTERFACE_GAPS "strictness-cannot-rank-ordered-enums".
    // These are "allow" | "confirm" | "deny": an ordered enum. `Strictness` has
    // no ordinal member, so there is no way to say deny > confirm > allow.
    // `replace` would let a lower-precedence layer downgrade "deny" to "allow" —
    // a privilege-escalation bug the type system currently invites. Refusing to
    // write is the only safe answer until Strictness grows an ordinal kind.
    { match: 'agent.tool_permissions.default', portability: 'portable', merge: 'never' },
    { match: 'agent.tool_permissions.tools.*.default', portability: 'portable', merge: 'never' },

    { match: 'terminal.shell.**', portability: 'os-scoped', merge: 'replace' },

    // -------------------------------------------------------------- portable
    // Sandbox network allowlist: adding a host WIDENS reach, so intersect.
    // [V-doc] docs/src/ai/sandboxing.md — `"network_hosts": ["github.com", "*.npmjs.org"]`
    {
      match: 'agent.sandbox_permissions.network_hosts',
      portability: 'portable',
      merge: 'most-restrictive',
      strictness: 'intersection',
    },
    // Remote MCP servers are just URLs. [V-doc] ai/mcp
    { match: 'context_servers.*.url', portability: 'portable', merge: 'replace' },
    // [V-doc] docs/src/ai/agent-settings.md — model selection keys.
    { match: 'agent.default_model.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.inline_assistant_model.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.commit_message_model.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.thread_summary_model.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.compaction_model.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.subagent_model.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.model_parameters', portability: 'portable', merge: 'replace' },
    { match: 'agent.commit_message_instructions', portability: 'portable', merge: 'replace' },
    { match: 'agent.auto_compact.**', portability: 'portable', merge: 'deep-merge' },
    // [V-doc] docs/src/ai/agent-profiles.md — profiles carry tool on/off maps.
    { match: 'agent.profiles.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'agent.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'language_models.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'lsp.**', portability: 'portable', merge: 'deep-merge' },
    { match: 'theme', portability: 'portable', merge: 'replace' },
    { match: 'vim_mode', portability: 'portable', merge: 'replace' },
    { match: 'buffer_font_size', portability: 'portable', merge: 'replace' },
    { match: 'buffer_font_family', portability: 'portable', merge: 'replace' },
    { match: 'telemetry.**', portability: 'portable', merge: 'deep-merge' },

    // Zed ships a fast-moving settings schema that WILL gain keys we have never
    // seen. Pass them through untouched rather than rewriting what we do not model.
    { match: '**', portability: 'portable', merge: 'deep-merge' },
  ]

  // ---- Per-store overrides -------------------------------------------------
  // This is exactly the capability adapter-fit.md §5b asked for, and Zed needs
  // it for a different reason than Cursor did: not different merge semantics for
  // the same key, but different LEGALITY.
  //
  // [V-doc] docs/src/configuring-zed.md — "Not all settings can be set at the
  // project level"; settings that affect the editor globally (theme, vim_mode)
  // only work in user settings. Writing them into .zed/settings.json produces a
  // file that looks correct and does nothing.
  if (storeId === STORE.projectSettings) {
    return [
      { match: 'theme', portability: 'portable', merge: 'never' }, // [V-doc] configuring-zed
      { match: 'vim_mode', portability: 'portable', merge: 'never' }, // [V-doc] configuring-zed
      ...base,
    ]
  }

  return base
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface JsoncParse {
  data: unknown
  /** Number of comments discarded. Non-zero means a write would destroy them. */
  commentCount: number
  /** Trailing commas found and removed. */
  trailingCommas: number
}

/**
 * Strip `//` and block comments plus trailing commas, and COUNT what was removed.
 *
 * The counting is the point. Zed's format is "JSON with support for `//`
 * comments" ([V-doc] docs/src/configuring-zed.md) and the docs teach users to
 * keep commented-out examples inline, so settings.json is the most comment-dense
 * config in the survey. `ConfigDoc` cannot carry comments, so the only honest
 * thing this adapter can do is notice they exist and refuse to clobber them.
 *
 * Deliberately a local implementation rather than an import from cursor.ts:
 * adapters must not depend on each other, and this variant returns counts the
 * Cursor one does not. It belongs in platform/ eventually.
 */
export function parseJsonc(input: string): JsoncParse {
  let out = ''
  let commentCount = 0
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
      commentCount++
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      commentCount++
      i++
      continue
    }
    out += c
  }

  const before = out
  const stripped = before.replace(/,(\s*[}\]])/g, '$1')
  const trailingCommas = countTrailingCommas(before)

  let data: unknown
  try {
    data = JSON.parse(stripped)
  } catch (e) {
    // Never explode a whole sync over one malformed user file. plan() turns this
    // into a refuse-to-write warning.
    data = { __parseError: String(e), raw: input }
  }
  return { data, commentCount, trailingCommas }
}

function countTrailingCommas(s: string): number {
  const m = s.match(/,(\s*[}\]])/g)
  return m ? m.length : 0
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>
  body: string
  /** Kept so canonicalize() hashes the real bytes, not a lossy re-render. */
  raw: string
}

/** Minimal YAML frontmatter reader — scalars and `- ` lists only. */
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
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
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

function installPaths(host: HostEnv): string[] {
  const j = joiner(host)
  switch (host.os) {
    case 'macos':
      // [I] Standard bundle location. Zed's docs describe drag-to-Applications
      // install but do not print this path, so it is inference from convention.
      return ['/Applications/Zed.app', j(host.home, 'Applications', 'Zed.app')]
    case 'linux':
      // [I] Zed's Linux install script places the app under ~/.local.
      return [j(host.home, '.local', 'zed.app'), '/usr/bin/zed', j(host.home, '.local', 'bin', 'zed')]
    case 'windows':
      // [I] Not documented; follows the Electron/Windows convention.
      return [j(host.localAppData ?? j(host.home, 'AppData', 'Local'), 'Programs', 'Zed')]
  }
}

async function detect(host: HostEnv): Promise<Detection> {
  const present: string[] = []

  for (const store of locations(host)) {
    const loc = store.location
    if (loc.kind !== 'file' && loc.kind !== 'dir' && loc.kind !== 'dropin') continue
    if (await pathExists(absolutize(loc.path))) present.push(store.id)
  }

  // Evidence is RANKED, not counted. `~/.agents/skills` is shared across tools
  // and proves nothing about THIS one. Project-scope files matter especially
  // here: Zed's instruction chain is repo-local, so counting `.rules` made
  // detection depend on the working directory — same machine, different answer,
  // and that answer gates writes. They now carry no weight at all.
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
 * macOS only, and deliberately fs-only — detect() must not shell out. The bundle
 * path itself is [I] (see installPaths), so a miss here is not evidence of
 * absence.
 */
async function readMacVersion(host: HostEnv): Promise<string | undefined> {
  if (host.os !== 'macos') return undefined
  for (const app of ['/Applications/Zed.app', posix(host.home, 'Applications', 'Zed.app')]) {
    try {
      const plist = await readFile(`${app}/Contents/Info.plist`, 'utf8')
      const v = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
      if (v) return v
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/** Project-scoped descriptors are repo-relative unless ProjectContext resolved them. */
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
  // (locations() already bakes in a ProjectContext when it is given one, so
  // this is usually a no-op on an already-absolute path — which is exactly
  // what makes it safe to call both places.)
  const abs = resolveStorePath(loc.path, ctx)
  if (loc.kind === 'dir') return readDirStore(store, abs, loc.entryFile)
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

  const text = bytes.toString('utf8')
  let data: unknown
  // Default: fingerprint the bytes. Overridden below for JSON/JSONC, where a
  // subtree descriptor has no bytes of its own to fingerprint.
  let hash = sha256Hex(bytes)

  if (format === 'markdown') {
    data = parseFrontmatter(text)
  } else if (format === 'json' || format === 'jsonc') {
    const parsed = parseJsonc(canonicalizeText(text))
    const whole = parsed.data
    // An unparseable file has no subtrees to speak of, and plan() detects the
    // failure by looking for `__parseError` in `data`. Hand the marker to EVERY
    // descriptor over the file, or the ten subtree descriptors would each
    // report a healthy empty branch of a file we could not read at all.
    const unparseable = getPath(whole, '__parseError') !== undefined

    // A descriptor with a `subtree` owns only that branch of the file, and must
    // read, hash and diff the branch ALONE. Eleven descriptors share this
    // settings.json; if each returned the whole document they would all report
    // identical data, every one of them would show drift whenever any other
    // one changed, and the plans built from that would be wrong.
    //
    // `?? {}` rather than `undefined`: the branch being absent from the file is
    // not the same as the file being absent, and `exists` already carries that
    // distinction. Note a subtree can address a SCALAR — `buffer_font_size` is
    // a number — so `data` here is not necessarily an object.
    data = store.subtree && !unparseable ? (getPath(whole, store.subtree) ?? {}) : whole

    if (!unparseable) {
      // Hash the CANONICAL form of exactly what we return. It cannot be the raw
      // bytes for a subtree — there are none — and canonical bytes are also
      // what makes a file that differs only by key order or line endings stop
      // reporting as drift on a mixed-OS fleet.
      hash = sha256Hex(canonicalJson(data))
    }

    // Smuggle the comment census onto the doc so plan() can see it without
    // re-reading the file. `ConfigDoc` has nowhere structured to put this —
    // see INTERFACE_GAPS / docs/zed-spike.md §3.
    if (parsed.commentCount > 0 && data !== null && typeof data === 'object') {
      Object.defineProperty(data, JSONC_COMMENTS, {
        value: parsed.commentCount,
        enumerable: false,
      })
    }
  } else {
    data = { raw: text }
  }

  const version = getPath(data, 'version')
  // The bytes exactly as read travel with the doc. `ConfigDoc.raw` is what a
  // format-preserving write is computed from; a doc without it is how an
  // adapter ends up rewriting a user's JSONC through `JSON.stringify` and
  // deleting every comment in it — the exact regression platform/jsonc.ts
  // exists to prevent. Always the WHOLE file's bytes, even for a subtree
  // descriptor: a branch of a document has no byte range of its own.
  const base: ConfigDoc = { storeId: store.id, data, hash, exists: true, raw: bytes }
  return typeof version === 'number' ? { ...base, schemaVersion: version } : base
}

/**
 * Non-enumerable marker holding the discarded-comment count. Non-enumerable so
 * it never reaches canonicalJson, a diff, or the wire.
 */
export const JSONC_COMMENTS = Symbol.for('zed.jsonc.commentCount')

function commentCountOf(doc: ConfigDoc | undefined): number {
  const d = doc?.data
  if (!d || typeof d !== 'object') return 0
  const v = (d as Record<symbol, unknown>)[JSONC_COMMENTS]
  return typeof v === 'number' ? v : 0
}

export interface DirEntry {
  /** Path relative to the store root, always posix-separated. */
  path: string
  frontmatter: Record<string, unknown>
  body: string
  hash: string
}

/** Recursive: skills nest under category folders. [V-doc] ai/skills */
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
      if (entryFile ? it.name !== entryFile : !/\.(md|markdown|txt)$/.test(it.name)) continue
      try {
        const bytes = await readFile(full)
        const parsed = parseFrontmatter(bytes.toString('utf8'))
        entries.push({
          path: full
            .slice(root.length + 1)
            .split(/[\\/]/)
            .join('/'),
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

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

/**
 * NOTE: for a JSONC store this is LOSSY BY CONSTRUCTION. `doc.data` is already
 * post-`JSON.parse`, so every `//` comment the user wrote is gone before this
 * function is reached. It is correct for hashing ("did the semantic config
 * change?") and unusable as a write path. See docs/zed-spike.md §3.
 */
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

export interface ZedDesiredState {
  /** storeId -> desired document. */
  stores?: Record<string, unknown>
}

/**
 * Zed-specific risk. core/reconcile.ts `classifyRisk` is shaped for Claude
 * Code's key names (`mcpServers`, `hooks`) and would report EVERYTHING in a Zed
 * settings.json as 'none' — including `context_servers.*.command`, which spawns
 * a process. Silent under-reporting of code-execution risk is the worst possible
 * failure for the approval gate, so this is a full override, not a delegation.
 */
export function classifyZedRisk(path: string): Change['risk'] {
  // MCP + ACP servers: `command`/`args`/`env` spawn a process. [V-doc] ai/mcp, ai/external-agents
  if (/^context_servers\.[^.]+\.(command|args|env)/.test(path)) return 'code-execution'
  if (/^agent_servers\.[^.]+\.(command|args|env)/.test(path)) return 'code-execution'
  // Language servers are downloaded and spawned — worktree-trust.md treats them
  // as exactly as dangerous as MCP servers. [V-doc] worktree-trust
  if (/^lsp\./.test(path)) return 'code-execution'
  if (/^terminal\.shell/.test(path)) return 'code-execution'
  // Remote MCP endpoints exfiltrate context but do not spawn locally.
  if (/^context_servers\./.test(path)) return 'elevated'
  if (/^agent_servers\./.test(path)) return 'elevated'
  // [V-doc] ai/tool-permissions, ai/sandboxing
  if (/^agent\.(tool_permissions|sandbox_permissions)/.test(path)) return 'elevated'
  if (/^agent\.profiles\./.test(path)) return 'elevated'
  if (/^language_models\./.test(path)) return 'elevated'
  return 'none'
}

/** Stores whose whole content is shell commands, regardless of key path. */
const SHELL_DOC_STORES = new Set<string>([STORE.userTasks, STORE.projectTasks])

function worst(a: Change['risk'], b: Change['risk']): Change['risk'] {
  const rank = { none: 0, elevated: 1, 'code-execution': 2 } as const
  return rank[b] > rank[a] ? b : a
}

function riskFor(storeId: string, path: string): Change['risk'] {
  // [V-doc] docs/src/tasks.md — every task entry is a shell command.
  if (SHELL_DOC_STORES.has(storeId)) return 'code-execution'
  return classifyZedRisk(path)
}

/**
 * Lift a subtree-relative path to the whole-document path it addresses.
 *
 * A subtree descriptor reads, diffs and reports RELATIVE to its branch — that
 * is what makes it a unit of sync, and `apply-engine.ts` rebases the same way
 * when it writes (`github.command` in `zed:user:settings#context_servers`
 * becomes `context_servers.github.command` in the file).
 *
 * But `rules()` and `classifyZedRisk()` are both written against WHOLE-DOCUMENT
 * paths, because that is what the vendor documents and what a human reading the
 * table expects. Consulting them with a relative path is not a cosmetic
 * mismatch: `context_servers.*.env.**` would stop matching, so the never-sync
 * rule guarding MCP credentials would silently stop firing, and
 * `classifyZedRisk` would report a change that spawns a process as risk
 * 'none' — under-reporting code execution to the approval gate.
 *
 * So paths are lifted HERE, at the two lookups, and nowhere else. `Change.path`
 * stays relative, because that is the contract the engine rebases from.
 */
function qualify(store: StoreDescriptor, path: string): string {
  if (!store.subtree) return path
  return path === ROOT_PATH ? store.subtree : `${store.subtree}.${path}`
}

function plan(
  desired: DesiredState, observed: ConfigDoc[], host: HostEnv): Plan {
  const stores = new Map(locations(host).map((s) => [s.id, s]))
  const obs = new Map(observed.map((d) => [d.storeId, d]))
  const changes: Change[] = []
  const warnings: string[] = []

  const baseHashes: Record<string, string> = {}
  for (const doc of observed) baseHashes[doc.storeId] = doc.hash

  const finish = (): Plan => ({
    id: fingerprint(JSON.stringify({ deviceId: host.deviceId, toolId: 'zed', changes, baseHashes })),
    deviceId: host.deviceId,
    toolId: 'zed',
    changes,
    baseHashes,
    warnings,
  })

  // ---- Structural facts worth surfacing regardless of `desired` -----------

  // THE headline. Stated on every plan because it is a property of the tool,
  // not of any particular change.
  warnings.push(
    'Zed stores agent config (`agent`), MCP servers (`context_servers`), model providers ' +
      '(`language_models`) and editor preferences (`theme`, `buffer_font_size`) as peer top-level keys ' +
      'in ONE settings.json. Each is now its own store (`zed:user:settings#<key>`) so they can be ' +
      'synced independently, and they share a fileId so a write to several of them is ONE atomic ' +
      'read-modify-write. Two devices editing different subtrees still contend for the same file.',
  )

  warnings.push(
    'Zed has NO enterprise/managed policy layer — no MDM profile, no Group Policy, no /etc drop-in. ' +
      'Org controls are server-side dashboard toggles only. Nothing can be surfaced as a managed override.',
  )

  if (host.os === 'linux' || host.runtime === 'wsl') {
    warnings.push(
      'HostEnv exposes no environment. $XDG_CONFIG_HOME relocates Zed\'s user config directory; this ' +
        'table assumes ~/.config/zed. Confirm on-device.',
    )
  }
  if (host.os === 'windows' && host.runtime === 'native') {
    warnings.push(
      'Zed agent sandboxing is unavailable on native Windows — `agent.sandbox_permissions` only takes ' +
        'effect when the action runs inside WSL. Syncing it here writes an inert key.',
    )
  }

  // Comment census, reported ONCE per physical file rather than once per
  // descriptor — eleven descriptors share settings.json and eleven identical
  // warnings about it is noise, not information.
  //
  // This used to say a write would delete the comments and that apply() was
  // unimplemented for that reason. Both are now false: existing JSON/JSONC
  // files are edited by value span (platform/jsonc.ts), so comments, blank
  // lines and trailing commas survive. What remains true is the ONE case where
  // they would not, so that is what is warned about.
  const censused = new Set<string>()
  for (const doc of observed) {
    const n = commentCountOf(doc)
    if (n === 0) continue
    const store = stores.get(doc.storeId)
    const key = store?.location.kind === 'file' ? store.location.path : doc.storeId
    if (censused.has(key)) continue
    censused.add(key)
    warnings.push(
      `${key} contains ${n} JSONC comment block(s). They are preserved on write — only the value ` +
        'spans that change are rewritten. The one exception is a file that no longer parses, which ' +
        'falls back to a canonical rewrite; plan() refuses to touch those, so it should not arise.',
    )
  }

  // First-match-wins instruction chain: compute what is actually LIVE.
  const liveInstruction = INSTRUCTION_CHAIN.find((e) =>
    obs.get(`${STORE.projectInstructions}:${e.slug}`)?.exists,
  )
  if (liveInstruction) {
    const shadowed = INSTRUCTION_CHAIN.filter(
      (e) => e.slug !== liveInstruction.slug && obs.get(`${STORE.projectInstructions}:${e.slug}`)?.exists,
    )
    if (shadowed.length > 0) {
      warnings.push(
        `Zed reads only "${liveInstruction.file}" — the first match in its nine-file chain. ` +
          `${shadowed.map((s) => s.file).join(', ')} ${shadowed.length === 1 ? 'exists but is' : 'exist but are'} ` +
          'INERT for Zed (still live for their own tools). Writing a higher-precedence file silently ' +
          'disables the others for Zed.',
      )
    }
  }

  // ---- Desired-state validation ------------------------------------------
  // Shape is decided once, at the boundary, by normalizeDesired(). An
  // adapter sniffing it again is how the two shapes diverged in the first
  // place.
  const desiredStores = storesOf(desired)

  if (Object.keys(desiredStores).length === 0) {
    warnings.push(
      'Desired state has no per-store map. Nothing to plan.',
    )
    return finish()
  }

  for (const [storeId, want] of Object.entries(desiredStores)) {
    const store = stores.get(storeId)
    if (!store) {
      warnings.push(`Unknown zed store id "${storeId}" — skipped.`)
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
            : 'Read-only store: Zed reads this file but another adapter owns writes to it.',
        risk: 'none',
        ...(store.scope === 'managed' ? { overriddenBy: 'managed' as Scope } : {}),
      })
      continue
    }

    // [V-doc] worktree-trust — anything under the project scope is inert until
    // the user trusts the worktree, and we cannot read trust state.
    if (store.scope === 'project') {
      warnings.push(
        `${storeId}: Zed opens every worktree in Restricted Mode, where .zed/settings.json is not ` +
          'parsed and MCP/language servers are not spawned. This write may apply cleanly and still ' +
          'have no effect until the user trusts the worktree. Trust state is not readable by us.',
      )
    }

    const current = obs.get(storeId)

    if (store.location.kind === 'dir') {
      changes.push(...planDir(store, want, current))
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

    // ---- Array-rooted documents (keymap.json, tasks.json) -----------------
    // core/reconcile.ts flatten() returns [] for an array root, so per-key
    // diffing silently produces nothing. Fall back to a whole-document op and
    // say so, rather than reporting a no-op that isn't one.
    if (Array.isArray(want) || Array.isArray(current?.data)) {
      changes.push(...planArrayRooted(storeId, want, current, warnings))
      continue
    }

    const table = rules(storeId)
    const leaves = flatten(want)

    // Whole-file create when nothing is on disk.
    if (!current?.exists) {
      const safe: Record<string, unknown> = {}
      let stripped = false
      let risk: Change['risk'] = 'none'
      for (const [path, value] of leaves) {
        const rule = ruleFor(table, qualify(store, path))
        if (rule.portability === 'never-sync' || rule.merge === 'never') {
          stripped = true
          changes.push({
            storeId,
            op: 'skip',
            path,
            reason: skipReason(rule),
            risk: riskFor(storeId, qualify(store, path)),
          })
          continue
        }
        setPath(safe, path, value)
        risk = worst(risk, riskFor(storeId, qualify(store, path)))
      }
      changes.push({
        storeId,
        op: 'create',
        path: '',
        after: safe,
        reason: stripped
          ? 'File absent; creating with never-sync/refused keys stripped.'
          : 'File absent; creating.',
        risk,
      })
      continue
    }

    // Per-key diff.
    for (const [path, value] of leaves) {
      const rule = ruleFor(table, qualify(store, path))
      if (rule.portability === 'never-sync' || rule.merge === 'never') {
        changes.push({
          storeId,
          op: 'skip',
          path,
          reason: skipReason(rule),
          risk: riskFor(storeId, qualify(store, path)),
        })
        continue
      }

      const before = getPath(current.data, path)
      const after = mergeValue(before, value, rule.merge, rule.strictness)
      if (deepEqual(before, after)) continue

      changes.push({
        storeId,
        op: before === undefined ? 'create' : 'update',
        path,
        before,
        after,
        reason: `${rule.portability} / ${rule.merge} (rule "${rule.match}")`,
        risk: riskFor(storeId, qualify(store, path)),
      })
    }
  }

  return finish()
}

function skipReason(rule: KeyRule): string {
  if (rule.portability === 'never-sync') {
    return `${rule.portability}${rule.secret ? ' (secret)' : ''}: never leaves the device.`
  }
  // merge: 'never' with a portable class means we deliberately refuse — the
  // ordered-enum permission keys.
  return (
    "merge 'never': refusing to write. Either the key is illegal in this scope, or MergeStrategy/" +
    'Strictness cannot rank its values safely (see INTERFACE_GAPS).'
  )
}

/**
 * Whole-document planning for array-rooted files. Zed's `keymap.json` and
 * `tasks.json` are top-level JSON arrays; `flatten()` cannot address them, so
 * there is no per-key diff to compute and the sync unit degrades to the file.
 */
function planArrayRooted(
  storeId: string,
  want: unknown,
  current: ConfigDoc | undefined,
  warnings: string[],
): Change[] {
  warnings.push(
    `${storeId} is a top-level JSON array. core/reconcile.ts flatten() yields no leaves for an array ` +
      'root, so per-key diffing is impossible and the whole document is the sync unit. Two devices ' +
      'editing different entries will conflict at file granularity.',
  )

  if (!Array.isArray(want)) {
    return [
      {
        storeId,
        op: 'skip',
        path: '',
        reason: 'Store is array-rooted but desired state is not an array; refusing to change its shape.',
        risk: 'none',
      },
    ]
  }

  if (deepEqual(current?.data, want)) return []

  const risk: Change['risk'] = SHELL_DOC_STORES.has(storeId) ? 'code-execution' : 'none'

  return [
    {
      storeId,
      op: current?.exists ? 'update' : 'create',
      path: '',
      ...(current?.exists ? { before: current.data } : {}),
      after: want,
      reason: 'Array-rooted document: whole-file replace (no per-key addressing available).',
      risk,
    },
  ]
}

/**
 * Directory stores diff per entry file, not per JSON key — a skill is an
 * indivisible unit.
 */
function planDir(store: StoreDescriptor, want: unknown, current: ConfigDoc | undefined): Change[] {
  const changes: Change[] = []
  const have = new Map(entriesOf(current?.data).map((e) => [e.path, e]))

  for (const entry of entriesOf(want)) {
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
      // Skills may ship scripts/ that the agent is instructed to run.
      reason: existing ? 'Entry content differs.' : 'Entry absent on device.',
      risk: 'code-execution',
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

export const zedAdapter: ToolAdapter = {
  id: 'zed',
  displayName: 'Zed',

  capabilities: {
    apply: true,
    // `reason` is normally the explanation for a refusal. It is set here
    // because "can apply" is not all-or-nothing for Zed and a bare `true` would
    // overclaim: two of its store KINDS still cannot be written, and one class
    // of write is genuinely inert.
    reason:
      'JSON/JSONC stores apply through the shared engine: validated first, atomic, backed up, rolled ' +
      'back as a unit, and format-preserving, so the comments Zed users keep in settings.json survive ' +
      'a write. The ten subtree stores over settings.json share a fileId, so changing `agent` and ' +
      '`context_servers` in one plan is ONE read-modify-write and neither clobbers the other. NOT ' +
      'written: directory stores (skills) — the engine writes files, not trees — and markdown stores ' +
      '(AGENTS.md, .rules), which are diffed per frontmatter key while the engine can only replace a ' +
      'text file whole, so those changes are reported as failures. Two further honesty notes: nothing ' +
      'in the path table is verified-fs (no Zed install has ever been inspected), so writes are also ' +
      'gated on detect() finding a real one; and a write to `.zed/settings.json` can succeed and still ' +
      'do nothing, because Zed does not parse project settings in an untrusted worktree and we cannot ' +
      'read trust state.',
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
   * backup / rollback rules to drift out of. In particular the subtree
   * coalescing this adapter depends on lives there, in ONE place, keyed on the
   * `fileId` these descriptors share.
   *
   * That includes the `op: 'skip'` reports `plan()` emits. `validatePlan`
   * filters them into `ApplyResult.skipped` before anything reaches the writer,
   * so an adapter does not — and must not — pre-filter them itself.
   */
  async apply(plan: Plan, host: HostEnv): Promise<ApplyResult> {
    return applyPlan(plan, {
      adapter: zedAdapter,
      host,
      now: () => new Date().toISOString(),
    })
  },

  async rollback(rollbackId: string, host: HostEnv): Promise<void> {
    return rollbackApply(rollbackId, {
      adapter: zedAdapter,
      host,
      now: () => new Date().toISOString(),
    })
  },
}

export default zedAdapter
