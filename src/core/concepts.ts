/**
 * Vendor-neutral concept derivation.
 *
 * Three tools file the same ideas completely differently — Claude Code's
 * `.mcp.json`, Cursor's `~/.cursor/mcp.json`, and Zed's `context_servers` key
 * inside settings.json are all "MCP servers". `Concept` is what lets the UI
 * group them into one row, and this is the single place the mapping lives so
 * three adapters cannot drift into three different taxonomies.
 *
 * Derived from the store id rather than declared per descriptor: adapters have
 * 20-40 stores each, and a per-call-site `concept:` is a field people forget.
 * An adapter can still override by setting `concept` explicitly.
 */

import type { Concept } from './types.js'

/** Order matters — the first match wins, so narrower patterns come first. */
const PATTERNS: Array<[RegExp, Concept]> = [
  [/mcp|context[-_]?server/i, 'mcp'],
  // Tried before `permissions`: its `settings` alternative is generic enough
  // to swallow `ide-settings` and `#theme`, which are editor config.
  [/keymap|keybinding|ide-settings|theme|editor|task/i, 'editor'],
  // `settings` belongs here: a tool's settings file is where its permission and
  // approval model lives. Without it `claude-code:user:settings` — the single
  // most common store in the product — fell through to the `other` catch-all,
  // which only went unnoticed because that adapter sets `concept` by hand.
  [
    /permission|sandbox|policy|settings|managed:dropin|managed:registry|managed:plist/i,
    'permissions',
  ],
  [/rules|instruction|memory|agents?-md|cursorrules|claude-md/i, 'rules'],
  [/skill/i, 'skills'],
  [/agent|command|hook|plugin|marketplace|profile/i, 'agent'],
]

export function conceptFor(storeId: string): Concept {
  // A subtree suffix is the SUBJECT of the id. `zed:user:settings#context_servers`
  // is about MCP servers, not about "settings" — classifying on the whole id
  // would let the file's name outvote the branch that actually matters.
  const hash = storeId.indexOf('#')
  const subject = hash >= 0 ? storeId.slice(hash + 1) : storeId

  for (const [rx, concept] of PATTERNS) if (rx.test(subject)) return concept
  // Unrecognised subtree: fall back to the full id rather than giving up.
  if (hash >= 0) for (const [rx, concept] of PATTERNS) if (rx.test(storeId)) return concept
  return 'other'
}

/**
 * Directories that several tools read but none exclusively owns.
 *
 * `~/.agents/skills` is the cross-tool Agent Skills location — Claude Code,
 * Cursor and Codex all load from it, and Zed loads `SKILL.md` from it too. Its
 * presence therefore proves nothing about which tools are installed.
 */
const SHARED_ROOTS = [/[/\\]\.agents[/\\]/, /[/\\]\.agents$/]

/**
 * Is this store evidence that the tool is actually installed?
 *
 * Without this, `detect()` reported Cursor and Zed as installed on a machine
 * with neither — their only "present" store was `~/.agents/skills`, a directory
 * Claude Code's installer created. A summary line that confidently names
 * software the user does not have destroys trust in everything below it.
 */
export function isInstallEvidence(location: { kind: string; path?: string }): boolean {
  if (location.kind !== 'file' && location.kind !== 'dir') return false
  const path = location.path
  if (!path) return false
  return !SHARED_ROOTS.some((rx) => rx.test(path))
}

/**
 * How strongly a store's presence proves the tool is installed.
 *
 * Two problems this exists to solve, both found in review:
 *
 * SELF-CONFIRMATION. A store we can WRITE is not independent evidence. Zed
 * counted `~/.config/zed/settings.json`, which we are able to author — so once
 * anything created it, the gate was satisfied forever and we had manufactured
 * our own permission. It holds today only because we cannot write before being
 * allowed to, which is a property of the current call order rather than of the
 * design. Uninstall the tool and our file keeps vouching for it.
 *
 * WORKING-DIRECTORY DEPENDENCE. `detect()` has no project context, so
 * project-scope descriptors resolved against `process.cwd()`. Running from a
 * repo containing `.rules` made Zed "installed"; running from `~` did not —
 * same machine, same config, different answer, and that answer gates writes.
 * A file in someone's repo says nothing about what is installed on the machine,
 * so project scope is simply never evidence. That removes the dependence
 * without threading a context through a probe that should not need one.
 */
export type EvidenceStrength =
  /** A binary or app bundle. We could never have authored it. */
  | 'definitive'
  /** A config path we do not write. The tool made it; we could not have. */
  | 'strong'
  /** A config path we CAN write. Suggestive, but possibly our own doing. */
  | 'weak'
  /** Shared across tools, project-scoped, or not a filesystem path at all. */
  | 'none'

export function classifyInstallEvidence(store: {
  scope: string
  writable: boolean
  location: { kind: string; path?: string }
  installProof?: boolean
}): EvidenceStrength {
  if (store.installProof) return 'definitive'
  // A repo-local file describes a repo, not a machine.
  if (store.scope === 'project' || store.scope === 'local') return 'none'
  if (!isInstallEvidence(store.location)) return 'none'
  return store.writable ? 'weak' : 'strong'
}

/**
 * Decide installation from the evidence found, and say how sure we are.
 *
 * `weak` still counts — a tool whose only footprint is a config file we happen
 * to be able to write is still almost certainly installed, and refusing would
 * make the product useless for exactly the tools it targets. What changes is
 * that we now KNOW it is weak and can say so, rather than treating "a file
 * exists" as proof.
 */
export function decideInstalled(found: EvidenceStrength[]): {
  installed: boolean
  confidence: EvidenceStrength
} {
  for (const level of ['definitive', 'strong', 'weak'] as const) {
    if (found.includes(level)) return { installed: true, confidence: level }
  }
  return { installed: false, confidence: 'none' }
}

/**
 * Apply derived concepts to a descriptor list, preserving any the adapter set
 * explicitly — an adapter that knows better than the regex should win.
 */
export function withConcepts<T extends { id: string; concept?: Concept }>(stores: T[]): T[] {
  return stores.map((s) => (s.concept ? s : { ...s, concept: conceptFor(s.id) }))
}

/**
 * Resolve a store's path to an absolute location.
 *
 * ONE implementation, because there were two: `adapter.read()` resolved a
 * project-relative path against `process.cwd()` while `applyPlan()` resolved it
 * against `ProjectContext.projectRoot`. With a `--cwd` flag or a daemon whose
 * working directory is not the repo, those are different files — so the config
 * that was read and diffed was not the config that got written.
 */
export function resolveStorePath(path: string, ctx?: { projectRoot: string }): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path)
  if (isAbsolute) return path
  // Project-relative. Without a project context there is no correct base, so
  // fall back to cwd and let the caller decide whether that is acceptable.
  if (!ctx) return path

  const root = ctx.projectRoot.replace(/[/\\]+$/, '')
  const sep = looksLikeWindowsPath(root) ? '\\' : '/'
  // Rewrite separators on BOTH sides so the result comes out in one flavour
  // however the caller happened to spell the root. A leading UNC `\\` is a
  // prefix rather than a separator run, so it has to survive the rewrite.
  const unc = sep === '\\' && /^[/\\]{2}/.test(root)
  const body = (unc ? root.slice(2) : root).replace(/[/\\]+/g, sep)
  return `${unc ? '\\\\' : ''}${body}${sep}${path.replace(/[/\\]+/g, sep)}`
}

/**
 * Which separator does this base path speak?
 *
 * Deliberately NOT `node:path`. `locations()` must be able to build a *Windows*
 * path table while running on the macOS control plane — that is why the adapters
 * carry their own `posix`/`win` joiners — so `path.join` here would resolve to
 * the separator of the machine we happen to be running on, not the machine the
 * path describes.
 *
 * Hardcoding `/` (what this used to do) had the same defect from the other end:
 * on Windows it produced `C:\repo/.cursor/mcp.json`. Node opens that file
 * happily, which is exactly why it went unnoticed — but `path.resolve` rewrites
 * it to all-backslashes, so the rollback token `withBackup()` records stopped
 * being string-equal to the descriptor path it came from, and the two "routes to
 * the same file" that `read()` and `apply()` are supposed to agree on disagreed.
 *
 * The root is the only evidence available about which flavour of path this is,
 * and it is reliable: a drive letter or a UNC prefix is unambiguous, and a root
 * that uses backslashes and no forward slashes cannot be POSIX (a literal `\` is
 * a legal POSIX filename character, so we require the absence of `/` too).
 */
function looksLikeWindowsPath(root: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\')) return true
  return root.includes('\\') && !root.includes('/')
}
