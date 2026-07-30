/**
 * Core types for the agent-config control plane.
 *
 * Two hard rules encoded here:
 *  1. A config store is NOT always a file. Windows managed policy is a registry
 *     read; macOS MDM policy is a plist domain; Anthropic's managed settings can
 *     arrive from a server at sign-in. `StoreLocation` is a union for that reason.
 *  2. `plan()` is pure and `apply()` is the only thing that touches disk. The web
 *     app renders plans; devices execute applies. Nothing else may write.
 */

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export type OS = 'macos' | 'linux' | 'windows'

/** WSL is neither "linux" nor "windows" for our purposes — it straddles both. */
export type Runtime = 'native' | 'wsl'

export interface HostEnv {
  os: OS
  runtime: Runtime
  arch: 'x64' | 'arm64'

  home: string
  /**
   * Windows-shaped directories. Present on native Windows AND on WSL, where
   * they point at the Windows host through interop (`/mnt/c/Users/...`) — a WSL
   * user frequently has the tool installed on both sides of the boundary and
   * adapters need to reach across it. Absent on macOS and native Linux.
   */
  appData?: string //  %APPDATA%
  localAppData?: string //  %LOCALAPPDATA%
  programFiles?: string //  %ProgramFiles%

  /** Windows needs Developer Mode or elevation. Junctions are the fallback. */
  supportsSymlinks: boolean
  /** False on headless Linux — no libsecret. Forces encrypted-file fallback. */
  hasKeyring: boolean
  /** Long path support (\\?\ prefix / registry opt-in). Gates MAX_PATH checks. */
  supportsLongPaths: boolean

  shell: 'bash' | 'zsh' | 'fish' | 'powershell'
  /** Stable per-install; never derived from hostname (users rename machines). */
  deviceId: string
}

// ---------------------------------------------------------------------------
// Where config lives
// ---------------------------------------------------------------------------

/**
 * `team` is a vendor-delivered layer the user can toggle (Cursor has one).
 * It sits between managed and user: not org-mandatory, but not personal either.
 */
export type Scope = 'managed' | 'team' | 'user' | 'project' | 'local'

/**
 * How confident we are that a path table entry is correct.
 *
 * This is a type, not a comment, because `apply()` must be structurally
 * incapable of writing to a location we only guessed at. A wrong write to an
 * inferred managed path could disable someone's org security policy.
 */
export type Provenance =
  | 'verified-doc' //  confirmed in official vendor documentation
  | 'verified-fs' //  confirmed against a real install
  | 'inferred' //  reasoned from convention — READ ONLY until confirmed

export type StoreLocation =
  | { kind: 'file'; path: string; format: 'json' | 'jsonc' | 'markdown' | 'toml' | 'yaml' }
  /**
   * A directory of entries — `agents/`, `commands/`, `skills/`.
   *
   * `entryFile` distinguishes two genuinely different things, and the
   * distinction decides whether the directory can be synced at all:
   *
   *   ABSENT  — entries are single authored files (`agents/reviewer.md`).
   *             This is CONTENT the user wrote. It has no source to re-resolve
   *             from, so the only way to sync it is to carry the bytes. The
   *             document is a map of entry name to file contents.
   *
   *   PRESENT — entries are installed packages, each a folder containing
   *             `entryFile` (`skills/gws-gmail/SKILL.md`). These come from a
   *             marketplace and are re-resolved per device from a lockfile, so
   *             copying the tree would fight the installer. The document is a
   *             list of entry names, and the store is not itself writable.
   */
  | { kind: 'dir'; path: string; entryFile?: string }
  /** Drop-in fragment directory, e.g. managed-settings.d/. Read-only, merged. */
  | { kind: 'dropin'; path: string; format: 'json' }
  /** macOS managed preferences domain (MDM configuration profile). */
  | { kind: 'plist'; domain: string }
  /** Windows Group Policy / Intune. */
  | { kind: 'registry'; hive: 'HKLM' | 'HKCU'; key: string; value: string }
  /** Delivered by the vendor at sign-in. Observable, never writable. */
  | { kind: 'remote'; provider: string }

/**
 * Vendor-neutral concept name, so the UI can group the same idea across tools
 * that file it differently — Claude Code's `.mcp.json`, Cursor's `mcp.json` and
 * Zed's `context_servers` key are all `'mcp'`.
 */
export type Concept = 'agent' | 'mcp' | 'permissions' | 'rules' | 'skills' | 'editor' | 'other'

export interface StoreDescriptor {
  id: string // stable key, e.g. "claude-code:user:settings"
  scope: Scope
  location: StoreLocation

  /**
   * Dot-path root this descriptor owns INSIDE `location`. Omitted means the
   * whole document, which is the original behavior — so this is additive.
   *
   * This exists because a file is the wrong unit of sync. Zed puts
   * `context_servers` and `buffer_font_size` in one settings.json as peer keys,
   * so a per-file `syncable` has no correct value: true drags your font size
   * along with your MCP servers, false means you can't sync agent config at all.
   *
   * Two descriptors may share a `location` only if their subtrees are disjoint.
   */
  subtree?: string

  /**
   * Physical write target. Descriptors sharing a `fileId` MUST be coalesced by
   * apply() into ONE atomic read-modify-write — otherwise two subtree changes
   * to the same file are two writes and the second clobbers the first.
   */
  fileId?: string

  concept?: Concept

  /**
   * Conditional liveness: this store is only read by the tool when NONE of the
   * listed store ids exist. Models first-match-wins instruction chains — Zed
   * reads nine rules files but honors only the first present one, so writing
   * `.rules` silently turns `CLAUDE.md` OFF. Without this the UI would present
   * a destructive act as an additive one.
   */
  activeWhen?: { absent: string[] }

  readable: boolean
  writable: boolean
  /** Scoped to `subtree` when present — which is what makes it answerable. */
  syncable: boolean
  /**
   * This path is a binary or app bundle: its presence PROVES the tool is
   * installed, because we could never have authored it. Ranks above config
   * files, which we can write and which therefore vouch for themselves.
   */
  installProof?: boolean

  /**
   * Narrows the adapter-wide capability to THIS store.
   *
   * Granularity people actually ask about is the store, not the tool: Zed can
   * read `context_servers` perfectly well and still not be writable, and an
   * adapter-level flag forces "all or nothing" on a tool where the honest
   * answer is "these three, not those two". Can only ever REMOVE support — an
   * adapter that declares `apply: false` is not overridden by a store.
   */
  capabilities?: AdapterCapabilities

  /** See `Provenance`. `apply()` MUST refuse to write when this is 'inferred'. */
  provenance: Provenance
  /** Surfaced in the UI when provenance is 'inferred', so users know why. */
  provenanceNote?: string
}

// ---------------------------------------------------------------------------
// Portability + merge semantics
// ---------------------------------------------------------------------------

/**
 * Which layer a key is allowed to live in. This is the answer to "hooks are
 * shell commands and don't survive a mac -> windows sync".
 */
export type PortabilityClass =
  | 'portable' //  same value everywhere
  | 'os-scoped' //  hooks, defaultShell, anything shelling out
  | 'machine-scoped' //  absolute paths: installPath, installLocation
  | 'never-sync' //  secrets, oauthAccount, machineID, userID, session state

/**
 * Per-key merge behavior. Claude Code merges permission rules across scopes
 * rather than overriding them, so a single blanket strategy is wrong.
 */
export type MergeStrategy =
  | 'replace'
  | 'deep-merge'
  | 'union-list' //  dedupe, order-insensitive  (permissions.allow/deny)
  | 'concat' //  order-sensitive            (hook chains)
  /**
   * Take the STRICTER of the two values, never the newer one. Required for
   * sandbox and permission-ceiling settings, where a merge must never be able
   * to weaken an existing security posture. `replace` on these keys is a
   * privilege-escalation bug: a lower-precedence layer could loosen a sandbox.
   */
  | 'most-restrictive'
  | 'never' //  refuse to write

/**
 * Which direction is "stricter" for a `most-restrictive` merge.
 *
 * This CANNOT be inferred from the value: `true` is stricter for
 * `disableAllHooks` but looser for `allowUnsignedExtensions`. Leaving it
 * implicit would let two clients rank the same pair differently and produce
 * divergent plans — which breaks the guarantee that a previewed plan is the
 * plan that runs. So it is declared per key, and merging without it throws.
 */
export type Strictness =
  | 'true-is-stricter' //  disableAllHooks, sandbox enabled
  | 'false-is-stricter' //  allowUnsignedExtensions
  | 'lower-is-stricter' //  ceilings: timeouts, max file size
  | 'higher-is-stricter' //  floors: minimum key length
  | 'intersection' //  allowlists — keep only what BOTH permit
  | 'union' //  denylists — keep everything EITHER forbids
  /**
   * Ordered enum, strictest LAST. For keys like Zed's
   * `agent.tool_permissions.default: "allow" | "confirm" | "deny"` — ordered by
   * strictness but neither boolean, numeric, nor a list. Without this the only
   * safe option was refusing to sync the key at all, because `replace` would
   * let a lower-precedence layer downgrade `deny` to `allow`.
   */
  | { kind: 'ordinal'; order: string[] }

export interface KeyRule {
  /** Dot path, `*` matches one segment, `**` matches the rest. */
  match: string
  portability: PortabilityClass
  merge: MergeStrategy
  /** Required when `merge === 'most-restrictive'`. See `Strictness`. */
  strictness?: Strictness
  /** Redact before the value ever leaves the device. */
  secret?: boolean
}

// ---------------------------------------------------------------------------
// Documents, plans, changes
// ---------------------------------------------------------------------------

export interface ConfigDoc {
  storeId: string
  /** Parsed content. Unknown keys are preserved verbatim — never rewritten. */
  data: unknown
  /** Content hash of the raw bytes as read. Used for optimistic concurrency. */
  hash: string
  /** Format version we recognized, if the file self-describes one. */
  schemaVersion?: number
  exists: boolean
  /**
   * The bytes exactly as read. Required for format-preserving writes: you
   * cannot keep a user's comments and indentation if the only thing you kept
   * was the parse tree. Adapters were previously smuggling this through
   * ad-hoc side channels, which is the tell that it belongs here.
   */
  raw?: Uint8Array
}

export type ChangeOp = 'create' | 'update' | 'delete' | 'skip'

export interface Change {
  storeId: string
  op: ChangeOp
  path: string // dot path within the doc, or "" for whole-file ops
  before?: unknown
  after?: unknown
  reason: string
  /** Set when a managed policy will win regardless of what we write. */
  overriddenBy?: Scope
  /**
   * The write will succeed but have no observable effect, for a reason that is
   * NOT a policy override — e.g. Zed does not parse project settings in an
   * untrusted worktree. Distinct from `overriddenBy` because the cause and the
   * remedy are different, and reporting plain success here would be a lie.
   */
  /**
   * NOT CURRENTLY PRODUCED BY ANY ADAPTER, and the reason is worth recording:
   * the one real case we know of is Zed refusing to read project settings in an
   * untrusted worktree, and that trust state is not readable by us. So the
   * condition is real, the consumer is ready, and nothing can yet detect it.
   * Kept rather than deleted because the alternative — reporting a write as
   * plain success when it had no effect — is a lie we would rather be able to
   * stop telling the moment detection becomes possible.
   */
  inert?: { reason: string }
  /**
   * The engine refused to carry this change's value — it was secret-shaped.
   * `after` has been replaced with a redaction marker at source, so the real
   * value never enters a Plan and can never be shipped or written.
   *
   * The change is still REPORTED rather than dropped: silently omitting it made
   * `diff` say "already in the desired state", which is safe but untrue — the
   * user's desired state contained something we would not sync, and they had no
   * way to find out.
   */
  blocked?: { reason: string }
  /**
   * Vendor-neutral grouping, populated by `buildPlan` from the store id. Lets a
   * plan be grouped without a side table.
   *
   * There is deliberately no `label` beside this. A human name — "the GitHub
   * connection" rather than `mcpServers.github.command` — needs domain
   * knowledge core does not have, so a `label` field here would be permanently
   * undefined. A field that always reads `undefined` is worse than an absent
   * one: it advertises data that does not exist and callers build around it.
   * Naming belongs to whoever is rendering.
   */
  concept?: Concept

  /** Hooks, MCP commands, and env are code execution. Gate them. */
  risk: 'none' | 'elevated' | 'code-execution'
}

/**
 * The AUTHORING axis — how a value was written.
 *
 * Orthogonal to `Scope`, which is the DISCOVERY axis: where a value was found
 * on disk. Both happen to contain 'local' and that has proven confusing, so:
 *
 *   Layer  (base | os | machine | local)  — how the user authored it
 *   Scope  (managed | team | user | ...)  — which file it landed in
 *
 * A value authored in the `base` layer may land in the `user` scope on one
 * device and the `project` scope on another.
 */
export type Layer = 'base' | `os:${string}` | `machine:${string}` | 'local'

export interface Plan {
  /**
   * Deterministic content fingerprint. Two clients computing a plan from the
   * same inputs MUST produce the same id — approvals are bound to it, and a
   * preview that doesn't match what runs is worthless.
   */
  id: string
  /**
   * Optional because `plan()` is pure and must never read the clock. Stamped by
   * whichever caller has one — the CLI on apply, or the control plane on store.
   */
  createdAt?: string
  deviceId: string
  toolId: ToolId
  changes: Change[]
  /** Hashes we planned against. apply() aborts if disk has moved on. */
  baseHashes: Record<string, string>
  warnings: string[]
}

export interface ApplyResult {
  planId: string
  applied: Change[]
  skipped: Array<Change & { skipReason: string }>
  failed: Array<Change & { error: string }>
  /** Snapshot id for rollback. */
  rollbackId: string
  /**
   * Set when nothing ran because the device chose to wait — a live session, a
   * quiet-hours window. `applied`, `skipped` and `failed` are all empty.
   *
   * `PushResult` already had a `'deferred'` status per device with nothing on
   * this side to map it to, so an outcome view had to invent one. Deferred is
   * not a failure and not a no-op, and flattening it into either loses the one
   * fact that matters: it will happen later.
   */
  deferred?: { reason: string; retryAfter?: string }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type ToolId = 'claude-code' | 'cursor' | 'codex' | 'windsurf' | 'zed' | 'aider'

/**
 * Project-scope stores are repo-relative and meaningless without a root.
 * Optional because user/managed scopes resolve fine without one.
 */
export interface ProjectContext {
  projectRoot: string
  /** Repo identity, so the web app can group project config across devices. */
  remoteUrl?: string
}

/**
 * Desired state, with its shape made explicit.
 *
 * `plan(desired: unknown)` used to hide two incompatible shapes: Claude Code
 * expects a flat settings document, Cursor and Zed expect `{ stores: { … } }`.
 * Nothing typed the difference, so callers guessed — and the guess had teeth:
 * `KeyRule` paths are written for the flat shape, so a nested document matched
 * only the `**` catch-all and every `never-sync` rule silently stopped firing.
 * (A shape-independent secret floor now backstops that, but the right fix is to
 * stop the ambiguity existing.)
 */
export type DesiredState =
  /** One document, diffed against the tool's primary store. */
  | { kind: 'document'; data: Record<string, unknown> }
  /** Per-store documents, each diffed against its own observed doc. */
  | { kind: 'by-store'; stores: Record<string, Record<string, unknown>> }

export interface Detection {
  installed: boolean
  version?: string
  /** Stores that actually exist on this host right now. */
  present: string[]
  /**
   * How strongly `installed` is evidenced. `weak` means the only proof was a
   * config file WE are able to write — suggestive, but not independent, since
   * a leftover file keeps vouching for a tool that has been uninstalled.
   * Surfaced so `doctor` can say so rather than presenting a guess as a fact.
   */
  confidence?: 'definitive' | 'strong' | 'weak' | 'none'
}

/**
 * What an adapter can actually do, declared rather than discovered.
 *
 * Without this the only way to learn that an adapter cannot write is to call
 * `apply()` and catch — so a UI can only report the limitation at the moment
 * the user tries, and every caller ends up maintaining its own allowlist of
 * which adapters are "real". Declaring it lets `status` say "Zed diffs but
 * cannot apply yet, because …" up front.
 */
export interface AdapterCapabilities {
  /** False when `apply()` throws NotImplemented. `reason` is shown to users. */
  apply: boolean
  /** Required when `apply` is false. Written for a user, not a maintainer. */
  reason?: string
}

export interface ToolAdapter {
  readonly id: ToolId
  readonly displayName: string
  readonly capabilities: AdapterCapabilities

  /** Is this tool on this host, and which of its stores exist? */
  detect(host: HostEnv): Promise<Detection>

  /** The path table for this (tool x OS) cell. Pure — no IO. */
  locations(host: HostEnv, ctx?: ProjectContext): StoreDescriptor[]

  /**
   * Per-key portability + merge rules. Pure.
   *
   * MUST be scoped by store: the same dot path can carry different merge
   * semantics in different files. (Real case: Cursor concatenates permission
   * arrays in one store and replaces them in another.) Calling without a
   * storeId returns the tool-wide defaults.
   */
  rules(storeId?: string): KeyRule[]

  /**
   * `ctx` is required to read a project-scope store: its `location.path` is
   * repo-relative and has no meaning without a root. Omitting it falls back to
   * the process working directory, which is only correct when the process was
   * started in the repo.
   */
  read(store: StoreDescriptor, host: HostEnv, ctx?: ProjectContext): Promise<ConfigDoc>

  /**
   * Pure. Given desired state and what's on disk, produce a diff.
   * This is what the web app renders as a preview and what gets signed.
   */
  /**
   * Pure. `desired` is a tagged union, so an adapter can never be handed the
   * wrong shape and quietly diff against nothing. Use `asDocument()` /
   * `byStore()` from `core/desired.ts` to build one.
   */
  plan(desired: DesiredState, observed: ConfigDoc[], host: HostEnv): Plan

  /** The only method that mutates the filesystem. Must be atomic + reversible. */
  apply(plan: Plan, host: HostEnv): Promise<ApplyResult>

  rollback(rollbackId: string, host: HostEnv): Promise<void>

  /** Canonical form for hashing: stable key order, LF endings, no BOM. */
  canonicalize(doc: ConfigDoc): string
}
