/**
 * Fixture data — and a careful line about what is fixture and what is not.
 *
 * REAL, read from `src/adapters/*.ts` at runtime and never copied here:
 *   which stores exist on a given OS, where each one lives, its `Concept`, its
 *   `Scope`, its `provenance`, whether it is `writable` and `syncable`, its
 *   `subtree`/`fileId`, and its `activeWhen` chain. That is 73 stores on macOS,
 *   46 of which `writeVerdict` clears for writing.
 *
 * FIXTURE, unavoidably: the CONTENTS of those stores. Which skills are
 * installed, which permission rules are written, which sub-agent files exist,
 * which machines have what. Reading any of that needs a filesystem, and this
 * tier never touches one — `apply()` is the only thing in the product that
 * writes, and it runs on the device.
 *
 * Every seed below names a store id the adapters actually declare. If an adapter
 * drops a store, items anchored to it stop existing rather than quietly pointing
 * at nothing.
 *
 * What is NOT here: a table of refusal reasons per item per machine. Those are
 * computed by `writeVerdict()`, because a hand-written copy of the engine's
 * answer is a copy that can disagree with it.
 */

import type { HostEnv, ProjectContext, ToolId } from '@core/types'
import { DEFAULT_ENUMERATION } from '@core/control-plane'
import type { AccountSettings, DeviceStatus, Snapshot } from './types'

// ---------------------------------------------------------------------------
// Where project-scope stores resolve
// ---------------------------------------------------------------------------

/**
 * Project-scope descriptors are repo-relative and meaningless without a root, so
 * one is supplied. Without it `.cursor/rules` and `.zed/settings.json` resolve
 * against nothing.
 */
export const PROJECT: ProjectContext = {
  projectRoot: '/Users/saed/code/atlas',
  remoteUrl: 'github.com/elements/atlas',
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

const macbook: HostEnv = {
  os: 'macos',
  runtime: 'native',
  arch: 'arm64',
  home: '/Users/saed',
  supportsSymlinks: true,
  hasKeyring: true,
  supportsLongPaths: true,
  shell: 'zsh',
  deviceId: 'mbp16',
}

const studio: HostEnv = { ...macbook, deviceId: 'studio' }
const air: HostEnv = { ...macbook, deviceId: 'air' }

const workLaptop: HostEnv = {
  os: 'windows',
  runtime: 'native',
  arch: 'x64',
  home: 'C:\\Users\\saed.elements',
  appData: 'C:\\Users\\saed.elements\\AppData\\Roaming',
  localAppData: 'C:\\Users\\saed.elements\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  // Corporate image: Developer Mode off, the user is not a local admin.
  supportsSymlinks: false,
  hasKeyring: true,
  supportsLongPaths: false,
  shell: 'powershell',
  deviceId: 'x1carbon',
}

const container: HostEnv = {
  os: 'linux',
  runtime: 'native',
  arch: 'arm64',
  home: '/home/dev',
  supportsSymlinks: true,
  hasKeyring: false, // headless: no libsecret, no D-Bus session
  supportsLongPaths: true,
  shell: 'bash',
  deviceId: 'devbox',
}

const runner: HostEnv = {
  os: 'linux',
  runtime: 'native',
  arch: 'x64',
  home: '/home/runner',
  supportsSymlinks: true,
  hasKeyring: false,
  supportsLongPaths: true,
  shell: 'bash',
  deviceId: 'ci',
}

// ---------------------------------------------------------------------------
// The machines
// ---------------------------------------------------------------------------

export interface ToolSeed {
  toolId: ToolId
  /** `Detection.confidence`. 'weak' means the only proof was a file we can write. */
  confidence: 'definitive' | 'strong' | 'weak'
}

export interface DeviceSeed {
  id: string
  name: string
  host: HostEnv
  status: DeviceStatus
  lastSeen?: string
  agentVersion?: string
  /** Which adapters found something. An absent tool contributes no stores. */
  tools: ToolSeed[]
  secretBackend: 'keychain' | 'dpapi' | 'libsecret' | 'encrypted-file' | 'none'
  busy?: { reason: string; retryAfter?: string }
  /**
   * Stores that exist on disk right now. Feeds `Detection.present`, which is
   * what `detectShadowing()` consults to decide whether creating one file
   * silently switches another one off.
   *
   * A store id not listed here is absent, so writing it is a create.
   */
  present: string[]
}

// Relative to when the app was opened, so "seen 12 minutes ago" stays true no
// matter when this fixture is read. A fixed clock here drifts into nonsense the
// day after it is written.
const NOW = Date.now()
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString()
const inMins = (mins: number) => new Date(NOW + mins * 60_000).toISOString()

const COMMON_PRESENT = [
  'claude-code:user:settings',
  'claude-code:user:memory',
  'claude-code:user:agents',
  'claude-code:user:commands',
  'claude-code:user:skills',
  'claude-code:user:skill-lock',
  'claude-code:user:plugins',
  'claude-code:user:marketplaces',
  'claude-code:user:mcp',
  'claude-code:user:global-config',
  'cursor:user:mcp',
  'cursor:user:permissions',
  'cursor:user:sandbox',
  'cursor:user:hooks',
  'cursor:user:subagents',
  'cursor:user:commands',
  'cursor:user:ide-settings',
  'cursor:project:agents-md',
  // The instruction file that Zed would stop reading the moment `.rules` is
  // created next to it. See `detectShadowing()`.
  'zed:project:instructions:claude-md',
]

const ZED_PRESENT = [
  'zed:user:settings',
  'zed:user:settings#agent',
  'zed:user:settings#context_servers',
  'zed:user:settings#lsp',
  'zed:user:settings#theme',
  'zed:user:settings#buffer_font_size',
  'zed:user:settings#vim_mode',
  'zed:user:settings#terminal',
  'zed:user:settings#telemetry',
  'zed:user:keymap',
  'zed:user:tasks',
  'zed:user:instructions',
]

export const deviceSeeds: DeviceSeed[] = [
  {
    id: 'mbp16',
    name: 'MacBook Pro',
    host: macbook,
    status: 'online',
    lastSeen: ago(1),
    agentVersion: '0.4.2',
    tools: [
      { toolId: 'claude-code', confidence: 'definitive' },
      { toolId: 'cursor', confidence: 'strong' },
      { toolId: 'zed', confidence: 'strong' },
    ],
    secretBackend: 'keychain',
    present: [
      ...COMMON_PRESENT,
      ...ZED_PRESENT,
      'zed:project:instructions:rules',
      'claude-code:user:keybindings',
      'claude-code:local:settings',
      'claude-code:managed:settings',
    ],
  },
  {
    id: 'studio',
    name: 'Mac Studio',
    host: studio,
    status: 'online',
    lastSeen: ago(12),
    agentVersion: '0.4.2',
    tools: [
      { toolId: 'claude-code', confidence: 'definitive' },
      { toolId: 'cursor', confidence: 'strong' },
      // Only a config file we could have authored ourselves vouches for Zed
      // here. `decideInstalled` still counts it — refusing would make the
      // product useless for exactly the tools it targets — but it says so.
      { toolId: 'zed', confidence: 'weak' },
    ],
    secretBackend: 'keychain',
    present: [
      ...COMMON_PRESENT,
      ...ZED_PRESENT,
      'claude-code:user:keybindings',
      'claude-code:local:settings',
    ],
  },
  {
    id: 'x1carbon',
    name: 'Work laptop',
    host: workLaptop,
    status: 'online',
    lastSeen: ago(4),
    agentVersion: '0.4.2',
    tools: [
      { toolId: 'claude-code', confidence: 'definitive' },
      { toolId: 'cursor', confidence: 'strong' },
    ],
    secretBackend: 'dpapi',
    // A live session. The device will take the write, but later — which is
    // neither a success nor a failure. See `ApplyResult.deferred`.
    busy: {
      reason: 'Someone is in a Claude Code session on this machine right now.',
      retryAfter: inMins(45),
    },
    present: [...COMMON_PRESENT, 'claude-code:managed:settings', 'cursor:user:cli-config'],
  },
  {
    id: 'devbox',
    name: 'Dev container',
    host: container,
    status: 'new',
    // Both are here, and they behave completely differently on Linux: every
    // Cursor path is `verified-doc`, so those stores are writable, while every
    // Claude Code user path is `inferred` and `writeVerdict` refuses it with
    // `path-unverified`. One machine, two answers, neither of them invented.
    tools: [
      { toolId: 'claude-code', confidence: 'definitive' },
      { toolId: 'cursor', confidence: 'definitive' },
    ],
    secretBackend: 'encrypted-file',
    present: [],
  },
  {
    id: 'air',
    name: 'Old MacBook Air',
    host: air,
    status: 'idle',
    lastSeen: ago(60 * 24 * 6),
    agentVersion: '0.4.1',
    tools: [
      { toolId: 'claude-code', confidence: 'definitive' },
      { toolId: 'cursor', confidence: 'strong' },
      { toolId: 'zed', confidence: 'strong' },
    ],
    secretBackend: 'keychain',
    present: [
      ...COMMON_PRESENT,
      ...ZED_PRESENT,
      'zed:project:instructions:rules',
      'claude-code:user:keybindings',
      'claude-code:local:settings',
    ],
  },
  {
    id: 'ci',
    name: 'CI runner',
    host: runner,
    status: 'online',
    lastSeen: ago(30),
    agentVersion: '0.4.2',
    // Claude Code only — and on Linux every one of its user-scope paths is
    // `inferred`, so `writeVerdict` answers `path-unverified` for all of them.
    // Nothing is written there; reading and comparing still work.
    tools: [{ toolId: 'claude-code', confidence: 'definitive' }],
    secretBackend: 'none',
    present: ['claude-code:user:settings', 'claude-code:user:memory', 'claude-code:user:mcp'],
  },
]

export const sourceDeviceId = 'mbp16'

// ---------------------------------------------------------------------------
// What is inside the stores — fixture, and the only part of this file that is
// ---------------------------------------------------------------------------

/**
 * One thing a person recognises, anchored to real stores.
 *
 * `kind: 'value'` sets a value at `path`. `kind: 'member'` contributes one entry
 * to the LIST at `path` — which is how permission rules actually work: the
 * adapter declares `merge: 'union-list'` for `permissions.allow`, so rules
 * accumulate across scopes instead of replacing each other.
 */
export type ItemSeed = {
  id: string
  label: string
  blurb: string
  technicalKey: string
  /** Real store ids. An anchor whose store is absent on a host is dropped. */
  anchors: Array<{ storeId: string; path: string }>
} & ({ kind: 'value'; value: unknown } | { kind: 'member'; member: string })

/** Marketplace skills. The sync unit is the lockfile, not the folder. */
const SKILL_NAMES = [
  'gws-gmail',
  'gws-calendar',
  'gws-drive',
  'gws-docs',
  'gws-forms',
  'gws-keep',
  'gws-meet',
  'gws-tasks',
  'gws-admin-reports',
  'gws-calendar-agenda',
  'gws-gmail-triage',
  'gws-gmail-send',
  'gws-gmail-reply',
  'gws-drive-upload',
  'gws-docs-write',
  'persona-hr-coordinator',
  'persona-it-admin',
  'persona-project-manager',
  'persona-sales-ops',
  'persona-team-lead',
  'recipe-backup-sheet-as-csv',
  'recipe-bulk-download-folder',
  'recipe-collect-form-responses',
  'recipe-compare-sheet-tabs',
  'recipe-draft-email-from-doc',
  'recipe-review-overdue-tasks',
  'recipe-save-email-attachments',
  'recipe-send-team-announcement',
  'recipe-share-folder-with-team',
  'recipe-sync-contacts-to-sheet',
  'recipe-watch-drive-changes',
  'dataviz',
  'artifact-design',
  'claude-api',
  'find-skills',
  'security-review',
  'simplify',
]

/** Plain names for the ones a person recognises by product, not by slug. */
const SKILL_LABEL: Record<string, [string, string]> = {
  'gws-gmail': ['Gmail', 'Read, send and file mail on your behalf.'],
  'gws-calendar': ['Calendar', 'Read your schedule and put things on it.'],
  'gws-drive': ['Google Drive', 'Find and open files in your Drive.'],
  'gws-docs': ['Google Docs', 'Read and write documents.'],
  dataviz: ['Charts', 'House style for every chart it draws.'],
  'artifact-design': ['Page design', 'How shared pages should look.'],
  'claude-api': ['Claude API reference', 'Model names, pricing and limits, kept current.'],
  'security-review': ['Security review', 'Checks a branch before you open a pull request.'],
  simplify: ['Cleanup pass', 'Reviews your own diff for things worth simplifying.'],
  'find-skills': ['Skill finder', 'Looks for skills you have not installed yet.'],
}

function skillSeeds(): ItemSeed[] {
  return SKILL_NAMES.map((name) => {
    const pretty = SKILL_LABEL[name]
    const label = pretty ? pretty[0] : name.replace(/^(gws|persona|recipe)-/, '').replace(/-/g, ' ')
    const blurb = pretty ? pretty[1] : 'Installed from the Anthropic skills marketplace.'
    return {
      id: `skill:${name}`,
      kind: 'value' as const,
      label: label.charAt(0).toUpperCase() + label.slice(1),
      blurb,
      technicalKey: `skills.${name}`,
      anchors: [{ storeId: 'claude-code:user:skill-lock', path: `skills.${name}` }],
      value: { source: 'github:anthropics/skills', version: '3.1.0' },
    }
  })
}

function ruleSeeds(
  effect: 'allow' | 'deny' | 'ask',
  rows: ReadonlyArray<readonly [string, string]>,
): ItemSeed[] {
  return rows.map(([raw, blurb], i) => ({
    id: `perm:${effect}:${i}`,
    kind: 'member' as const,
    label: raw,
    blurb,
    technicalKey: `permissions.${effect}[] ${raw}`,
    member: raw,
    anchors: [{ storeId: 'claude-code:user:settings', path: `permissions.${effect}` }],
  }))
}

export const itemSeeds: ItemSeed[] = [
  // ------------------------------------------------------------- connections
  {
    id: 'mcp:github',
    kind: 'value',
    label: 'GitHub connection',
    blurb: 'Lets Claude read your repos, issues and pull requests.',
    technicalKey: 'mcpServers.github',
    anchors: [
      { storeId: 'claude-code:user:mcp', path: 'mcpServers.github' },
      { storeId: 'cursor:user:mcp', path: 'mcpServers.github' },
      { storeId: 'zed:user:settings#context_servers', path: 'context_servers.github' },
    ],
    value: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  },
  {
    id: 'mcp:sentry',
    kind: 'value',
    label: 'Sentry connection',
    blurb: 'Lets Claude look up the errors your app is throwing.',
    technicalKey: 'mcpServers.sentry',
    anchors: [
      { storeId: 'claude-code:user:mcp', path: 'mcpServers.sentry' },
      { storeId: 'cursor:user:mcp', path: 'mcpServers.sentry' },
    ],
    value: { type: 'http', url: 'https://mcp.sentry.dev/sse' },
  },
  {
    id: 'mcp:proxy',
    kind: 'value',
    label: 'Internal proxy',
    blurb: 'Your company gateway. It carries a password, so the password stays here.',
    technicalKey: 'mcpServers.internal-proxy',
    anchors: [{ storeId: 'claude-code:user:mcp', path: 'mcpServers.internal-proxy' }],
    value: {
      type: 'http',
      url: 'https://mcp.elements.internal/sse',
      // Secret-shaped on purpose. `buildPlan` runs `scanForSecrets` over every
      // leaf it is about to carry and replaces this one at source, so the real
      // value never enters a Plan. The change is still REPORTED — see
      // `Change.blocked` — because silently dropping it would let a diff claim
      // "already in the desired state" about something it refused to carry.
      headers: { Authorization: 'ghp_S4dK2wQ1mVn8pLxT7bZrY9cE0aJhU3' },
    },
  },

  // ------------------------------------------------- sub-agents and commands
  {
    id: 'agent:code-reviewer',
    kind: 'value',
    label: 'code-reviewer',
    blurb: 'A sub-agent you wrote that reads a diff and argues with it.',
    technicalKey: 'agents/code-reviewer.md',
    anchors: [
      { storeId: 'claude-code:user:agents', path: 'code-reviewer' },
      { storeId: 'cursor:user:subagents', path: 'code-reviewer' },
    ],
    value: '---\nname: code-reviewer\n---\nRead the diff. Say what is wrong with it.',
  },
  {
    id: 'agent:db-migrations',
    kind: 'value',
    label: 'db-migrations',
    blurb: 'A sub-agent that writes and checks schema migrations.',
    technicalKey: 'agents/db-migrations.md',
    anchors: [{ storeId: 'claude-code:user:agents', path: 'db-migrations' }],
    value: '---\nname: db-migrations\n---\nWrite reversible migrations. Never drop a column.',
  },
  {
    id: 'cmd:release-notes',
    kind: 'value',
    label: '/release-notes',
    blurb: 'Turns the commits since the last tag into something readable.',
    technicalKey: 'commands/release-notes.md',
    anchors: [
      { storeId: 'claude-code:user:commands', path: 'release-notes' },
      { storeId: 'cursor:user:commands', path: 'release-notes' },
    ],
    value: 'Summarise commits since the last tag, grouped by area.',
  },
  {
    id: 'cmd:triage',
    kind: 'value',
    label: '/triage',
    blurb: 'Sorts open issues into things to fix now and things to fix later.',
    technicalKey: 'commands/triage.md',
    anchors: [
      { storeId: 'claude-code:user:commands', path: 'triage' },
      { storeId: 'cursor:user:commands', path: 'triage' },
    ],
    value: 'Group open issues by severity. Name the three worth doing first.',
  },
  {
    id: 'cmd:standup',
    kind: 'value',
    label: '/standup',
    blurb: 'What you did yesterday, from your own commits.',
    technicalKey: 'commands/standup.md',
    anchors: [{ storeId: 'claude-code:user:commands', path: 'standup' }],
    value: 'List yesterday’s commits as three bullets a human would say out loud.',
  },
  {
    id: 'hook:pre-commit',
    kind: 'value',
    label: 'Format before commit',
    blurb: 'Runs your formatter whenever Claude is about to commit.',
    technicalKey: 'hooks.beforeShellExecution',
    anchors: [{ storeId: 'cursor:user:hooks', path: 'hooks.beforeShellExecution' }],
    value: [{ command: 'npm run format' }],
  },
  {
    id: 'plugin:elements',
    kind: 'value',
    label: 'Elements plugin',
    blurb: 'Your team’s in-house plugin, pulled from your own marketplace.',
    technicalKey: 'plugins.elements',
    anchors: [{ storeId: 'claude-code:user:plugins', path: 'plugins.elements' }],
    value: { repo: 'github:elements/claude-plugin', version: '1.4.0' },
  },
  {
    id: 'marketplace:elements',
    kind: 'value',
    label: 'Elements marketplace',
    blurb: 'Where that plugin comes from.',
    technicalKey: 'extraKnownMarketplaces.elements',
    anchors: [
      { storeId: 'claude-code:user:marketplaces', path: 'extraKnownMarketplaces.elements' },
    ],
    value: { url: 'https://plugins.elements.dev' },
  },

  // ------------------------------------------------------------------ skills
  ...skillSeeds(),

  // ------------------------------------------------------------- permissions
  ...ruleSeeds('allow', [
    ['Bash(npm run test:*)', 'Run your test suite without asking.'],
    ['Bash(npm run lint)', 'Run the linter without asking.'],
    ['Bash(git diff:*)', 'Look at what changed.'],
    ['Read(./src/**)', 'Read anything under src.'],
    ['Edit(./src/**)', 'Edit anything under src.'],
    ['WebFetch(domain:docs.anthropic.com)', 'Read the Anthropic docs.'],
  ]),
  ...ruleSeeds('deny', [
    ['Bash(rm -rf:*)', 'Never delete recursively.'],
    ['Bash(curl:*)', 'Never fetch a URL from a shell.'],
    ['Read(./.env)', 'Never read your environment file.'],
  ]),
  ...ruleSeeds('ask', [
    ['Bash(git push:*)', 'Ask first before pushing.'],
    ['WebFetch', 'Ask first before fetching anything else.'],
  ]),
  {
    id: 'perm:mode',
    kind: 'value',
    label: 'Approval mode',
    blurb: 'Accept edits without asking; still ask before running commands.',
    technicalKey: 'permissions.defaultMode',
    anchors: [{ storeId: 'claude-code:user:settings', path: 'permissions.defaultMode' }],
    value: 'acceptEdits',
  },
  {
    id: 'perm:extra-dirs',
    kind: 'value',
    label: 'Extra folders',
    blurb: 'Folders outside the repo Claude is allowed to open.',
    technicalKey: 'permissions.additionalDirectories',
    anchors: [{ storeId: 'claude-code:user:settings', path: 'permissions.additionalDirectories' }],
    value: ['~/notes'],
  },
  {
    id: 'perm:sandbox',
    kind: 'value',
    label: 'Sandbox',
    blurb: 'Cursor runs commands in a box with no network by default.',
    technicalKey: 'sandbox.enabled',
    anchors: [{ storeId: 'cursor:user:sandbox', path: 'sandbox.enabled' }],
    value: true,
  },
  {
    id: 'perm:cursor-allow',
    kind: 'member',
    label: 'Bash(pnpm:*)',
    blurb: 'Cursor may run pnpm without asking.',
    technicalKey: 'permissions.allow[] Bash(pnpm:*)',
    member: 'Bash(pnpm:*)',
    anchors: [{ storeId: 'cursor:user:permissions', path: 'permissions.allow' }],
  },

  // ------------------------------------------------------------- preferences
  {
    id: 'pref:keymap',
    kind: 'value',
    label: 'Keyboard shortcuts',
    blurb: 'The keys you rebound.',
    technicalKey: 'bindings',
    anchors: [
      { storeId: 'zed:user:keymap', path: 'bindings' },
      { storeId: 'claude-code:user:keybindings', path: 'bindings' },
    ],
    value: { 'cmd-shift-r': 'task::Spawn' },
  },
  {
    id: 'pref:tasks',
    kind: 'value',
    label: 'Saved tasks',
    blurb: 'The commands you run often, saved by name.',
    technicalKey: 'tasks',
    anchors: [{ storeId: 'zed:user:tasks', path: 'tasks' }],
    value: [{ label: 'test', command: 'npm test' }],
  },
  {
    id: 'pref:lsp',
    kind: 'value',
    label: 'Language servers',
    blurb: 'How each language’s helper is set up.',
    technicalKey: 'lsp.typescript-language-server',
    anchors: [{ storeId: 'zed:user:settings#lsp', path: 'lsp.typescript-language-server' }],
    value: { initialization_options: { preferences: { includeInlayParameterNameHints: 'all' } } },
  },
  {
    id: 'pref:theme',
    kind: 'value',
    label: 'Editor theme',
    blurb: 'Dark.',
    technicalKey: 'workbench.colorTheme',
    anchors: [{ storeId: 'cursor:user:ide-settings', path: 'workbench.colorTheme' }],
    value: 'Default Dark Modern',
  },
  {
    id: 'pref:tabsize',
    kind: 'value',
    label: 'Indent size',
    blurb: 'Two spaces.',
    technicalKey: 'editor.tabSize',
    anchors: [{ storeId: 'cursor:user:ide-settings', path: 'editor.tabSize' }],
    value: 2,
  },
  {
    id: 'pref:format',
    kind: 'value',
    label: 'Format on save',
    blurb: 'On.',
    technicalKey: 'editor.formatOnSave',
    anchors: [{ storeId: 'cursor:user:ide-settings', path: 'editor.formatOnSave' }],
    value: true,
  },
  {
    id: 'pref:wrap',
    kind: 'value',
    label: 'Word wrap',
    blurb: 'Wrap long lines instead of scrolling sideways.',
    technicalKey: 'editor.wordWrap',
    anchors: [{ storeId: 'cursor:user:ide-settings', path: 'editor.wordWrap' }],
    value: 'on',
  },
  {
    id: 'pref:minimap',
    kind: 'value',
    label: 'Minimap',
    blurb: 'Off.',
    technicalKey: 'editor.minimap.enabled',
    anchors: [{ storeId: 'cursor:user:ide-settings', path: 'editor.minimap.enabled' }],
    value: false,
  },
  {
    id: 'pref:autosave',
    kind: 'value',
    label: 'Auto save',
    blurb: 'Save a file as soon as you stop typing in it.',
    technicalKey: 'files.autoSave',
    anchors: [{ storeId: 'cursor:user:ide-settings', path: 'files.autoSave' }],
    value: 'afterDelay',
  },

  // ------------------------------------------------------------ instructions
  {
    id: 'rules:claude-md',
    kind: 'value',
    label: 'Your standing instructions',
    blurb: 'The CLAUDE.md you keep in your home folder.',
    technicalKey: 'CLAUDE.md',
    anchors: [{ storeId: 'claude-code:user:memory', path: 'body' }],
    value: '# How I work\n\nPrefer small diffs. Never add a dependency without saying why.\n',
  },
  {
    id: 'rules:agents-md',
    kind: 'value',
    label: 'Repo instructions',
    blurb: 'The AGENTS.md checked into this project.',
    technicalKey: 'AGENTS.md',
    anchors: [
      { storeId: 'cursor:project:agents-md', path: 'body' },
      { storeId: 'zed:user:instructions', path: 'body' },
    ],
    value: '# Atlas\n\nRun `npm test` before you claim anything works.\n',
  },
  {
    id: 'rules:dot-rules',
    kind: 'value',
    label: 'A .rules file for Zed',
    blurb: 'Zed reads the first instruction file it finds in a repo and ignores every one after it.',
    technicalKey: '.rules',
    anchors: [{ storeId: 'zed:project:instructions:rules', path: 'body' }],
    value: '# Atlas\n\nRun `npm test` before you claim anything works.\n',
  },

  // --------------------------------------------------------------- stays put
  // Every anchor below sits in a store the adapters declare `syncable: false`,
  // or one that is not writable at all. None of that is this app's judgement —
  // it is read off the descriptors.
  {
    id: 'stay:zed-theme',
    kind: 'value',
    label: 'Zed theme',
    blurb: 'One Dark.',
    technicalKey: 'theme',
    anchors: [{ storeId: 'zed:user:settings#theme', path: 'theme' }],
    value: 'One Dark',
  },
  {
    id: 'stay:zed-font',
    kind: 'value',
    label: 'Zed font size',
    blurb: 'Depends on the monitor in front of you.',
    technicalKey: 'buffer_font_size',
    anchors: [{ storeId: 'zed:user:settings#buffer_font_size', path: 'buffer_font_size' }],
    value: 14,
  },
  {
    id: 'stay:zed-vim',
    kind: 'value',
    label: 'Vim mode',
    blurb: 'On.',
    technicalKey: 'vim_mode',
    anchors: [{ storeId: 'zed:user:settings#vim_mode', path: 'vim_mode' }],
    value: true,
  },
  {
    id: 'stay:zed-terminal',
    kind: 'value',
    label: 'Terminal shell',
    blurb: 'zsh here, PowerShell on the work laptop — it cannot be the same everywhere.',
    technicalKey: 'terminal.shell',
    anchors: [{ storeId: 'zed:user:settings#terminal', path: 'terminal.shell' }],
    value: { program: '/bin/zsh' },
  },
  {
    id: 'stay:zed-telemetry',
    kind: 'value',
    label: 'Zed telemetry',
    blurb: 'A choice you make per machine.',
    technicalKey: 'telemetry.metrics',
    anchors: [{ storeId: 'zed:user:settings#telemetry', path: 'telemetry.metrics' }],
    value: false,
  },
  {
    id: 'stay:account',
    kind: 'value',
    label: 'Your account',
    blurb: 'Who you are signed in as.',
    technicalKey: 'oauthAccount',
    anchors: [{ storeId: 'claude-code:user:global-config', path: 'oauthAccount' }],
    value: { emailAddress: 'saed@elementsgroup.me' },
  },
  {
    id: 'stay:machine-id',
    kind: 'value',
    label: 'Machine identity',
    blurb: 'Issued per install. Copying it would make two machines claim to be one.',
    technicalKey: 'machineID',
    anchors: [{ storeId: 'claude-code:user:global-config', path: 'machineID' }],
    value: '5f3a-9c21',
  },
  {
    id: 'stay:projects',
    kind: 'value',
    label: 'Project history',
    blurb: 'Which folders you have opened, and what happened in them.',
    technicalKey: 'projects',
    anchors: [{ storeId: 'claude-code:user:global-config', path: 'projects' }],
    value: { '/Users/saed/code/atlas': { lastOpened: '2026-07-29' } },
  },
  {
    id: 'stay:startups',
    kind: 'value',
    label: 'Startup count',
    blurb: 'How many times you have opened it.',
    technicalKey: 'numStartups',
    anchors: [{ storeId: 'claude-code:user:global-config', path: 'numStartups' }],
    value: 412,
  },
  {
    id: 'stay:tips',
    kind: 'value',
    label: 'Tips you have seen',
    blurb: 'So you are not shown them twice.',
    technicalKey: 'tipsHistory',
    anchors: [{ storeId: 'claude-code:user:global-config', path: 'tipsHistory' }],
    value: { 'shift-tab': 3 },
  },
  {
    id: 'stay:local-settings',
    kind: 'value',
    label: 'This checkout only',
    blurb: 'Settings you meant for this working copy and nowhere else.',
    technicalKey: 'permissions.allow',
    anchors: [{ storeId: 'claude-code:local:settings', path: 'permissions.allow' }],
    value: ['Bash(./scripts/seed.sh)'],
  },
  {
    id: 'stay:skills-folder',
    kind: 'value',
    label: 'The skills folder itself',
    blurb: 'The installed copies. The list travels; these files do not.',
    technicalKey: 'entries',
    anchors: [{ storeId: 'claude-code:user:skills', path: 'entries' }],
    value: SKILL_NAMES.slice(),
  },
  {
    id: 'stay:org-policy',
    kind: 'value',
    label: 'Your organisation’s policy',
    blurb: 'Set by whoever manages this machine. Read here, never written.',
    technicalKey: 'permissions.defaultMode',
    anchors: [{ storeId: 'claude-code:managed:settings', path: 'permissions.defaultMode' }],
    value: 'default',
  },
  {
    id: 'stay:team-rules',
    kind: 'value',
    label: 'Team rules from Cursor',
    blurb: 'Delivered by Cursor when you sign in. There is nothing on disk to copy.',
    technicalKey: 'rules',
    anchors: [{ storeId: 'cursor:managed:team-rules', path: 'rules' }],
    value: ['Never commit directly to main.'],
  },
]

// ---------------------------------------------------------------------------
// What each machine actually has
// ---------------------------------------------------------------------------

export interface DeviceDelta {
  /** Item ids this machine does not have at all. */
  absent: string[]
  /** Item ids whose value differs here, with the value this machine holds. */
  differing: Record<string, unknown>
  /**
   * Managed documents this machine reports, keyed by the store the policy
   * governs. `buildPlan` compares against these and marks anything a policy
   * already sets as `Change.overriddenBy: 'managed'`.
   */
  managed?: Record<string, Record<string, unknown>>
}

const IDENTICAL: DeviceDelta = { absent: [], differing: {} }

export const deviceDeltas: Record<string, DeviceDelta> = {
  mbp16: IDENTICAL,

  studio: {
    absent: [
      'skill:gws-gmail',
      'skill:gws-calendar',
      'mcp:github',
      'mcp:proxy',
      'agent:code-reviewer',
      'cmd:release-notes',
      'cmd:triage',
      'rules:dot-rules',
      'perm:allow:0',
      'perm:allow:3',
    ],
    differing: { 'perm:mode': 'default' },
    // An MDM profile on this machine. Anything here wins whatever we write, and
    // `buildPlan` marks the change `overriddenBy: 'managed'` rather than
    // previewing a write that provably cannot take effect.
    managed: {
      'claude-code:user:settings': { permissions: { defaultMode: 'default' } },
    },
  },

  x1carbon: {
    absent: ['skill:gws-gmail', 'skill:gws-calendar', 'mcp:github', 'perm:allow:0', 'perm:allow:3'],
    differing: {
      'perm:mode': 'default',
      'pref:theme': 'Default Light Modern',
      'pref:tabsize': 4,
    },
  },

  // Never reported. Everything that travels would be new.
  devbox: { absent: itemSeeds.map((s) => s.id), differing: {} },

  air: IDENTICAL,

  ci: {
    absent: itemSeeds
      .filter((s) => s.anchors.some((a) => a.storeId.startsWith('claude-code:')))
      .map((s) => s.id),
    differing: {},
  },
}

// ---------------------------------------------------------------------------
// Behind the ··· button
// ---------------------------------------------------------------------------

export const snapshots: Snapshot[] = [
  {
    snapshotId: 'snap-4f21',
    deviceId: 'studio',
    label: 'Before the last send',
    createdAt: ago(60 * 26),
    storeHashes: {
      'claude-code:user:settings': 'a71f…',
      'claude-code:user:skill-lock': '0c92…',
    },
    secretRefs: ['internal-proxy.authorization'],
    automatic: true,
    sizeBytes: 18_442,
  },
  {
    snapshotId: 'snap-9b03',
    deviceId: 'mbp16',
    label: 'Weekly',
    createdAt: ago(60 * 72),
    storeHashes: { 'claude-code:user:settings': 'a71f…' },
    secretRefs: [],
    automatic: false,
    sizeBytes: 22_119,
  },
  {
    snapshotId: 'snap-1d77',
    deviceId: 'x1carbon',
    label: 'Before the last send',
    createdAt: ago(60 * 96),
    storeHashes: { 'cursor:user:ide-settings': 'ee40…' },
    secretRefs: [],
    automatic: true,
    sizeBytes: 9_004,
  },
]

export const settings: AccountSettings = {
  secrets: { enabled: true, phraseSavedAt: ago(60 * 24 * 40) },
  enumeration: DEFAULT_ENUMERATION,
  autoSync: {
    masterDeviceId: 'mbp16',
    enabled: false,
    template: {
      source: { kind: 'device', deviceId: 'mbp16' },
      targets: { kind: 'all' },
      stores: { kind: 'all' },
      includeSecrets: false,
      deferWhileSessionActive: true,
    },
    autoApplyRisk: ['none'],
  },
}
