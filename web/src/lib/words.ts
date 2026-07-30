/**
 * The words.
 *
 * One rule: a sentence in this product never names a type, a key path, or a
 * file format. "GitHub connection — lets Claude read your repos", never
 * `mcpServers.github.command`. The technical name still exists and is still
 * reachable; it is just never the first thing anyone reads.
 *
 * Where core already has a sentence for something — a `writeVerdict` message, a
 * `ShadowWarning`, an adapter's `capabilities.reason` — that sentence is used
 * verbatim rather than paraphrased. Core's words are the ones the CLI prints, and
 * two surfaces telling the same person two different things about the same
 * refusal is how trust in both goes.
 */

import type { Concept, HostEnv, MergeStrategy, Scope, StoreLocation } from '@core/types'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Concepts — the only grouping in the product
// ---------------------------------------------------------------------------

/**
 * `Concept` is vendor-neutral by design: Claude Code's `.mcp.json`, Cursor's
 * `mcp.json` and Zed's `context_servers` key are all `'mcp'`. These are the
 * names a person would use for the same seven ideas.
 */
export const CONCEPT_TITLE: Record<Concept, string> = {
  skills: 'Skills',
  mcp: 'Connections',
  agent: 'Sub-agents & commands',
  permissions: 'Permissions',
  editor: 'Preferences',
  rules: 'Instructions',
  other: 'Other',
}

/** Differences first, then everything else, then the things that never move. */
export const CONCEPT_ORDER: Concept[] = [
  'skills',
  'mcp',
  'agent',
  'permissions',
  'editor',
  'rules',
  'other',
]

/** The terminal group. Not a `Concept` — it is "syncable: false", read off the stores. */
export const STAYS_PUT = 'stays-put'

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

export function osLabel(host: HostEnv): string {
  const base = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }[host.os]
  return host.runtime === 'wsl' ? `${base} on Windows` : base
}

export const SECRET_BACKEND_SENTENCE: Record<string, string> = {
  keychain: 'Passwords go in the macOS keychain.',
  dpapi: 'Passwords are sealed by Windows to this account.',
  libsecret: 'Passwords go in the system keyring.',
  'encrypted-file':
    'No keyring here, so passwords would go in an encrypted file next to the config.',
  none: 'Nowhere safe to keep a password here, so none are sent.',
}

/**
 * Facts about the machine that change what to expect, in plain words.
 *
 * Read off `HostEnv`, which is why they are honest: `hasKeyring` is false on a
 * headless container because there is no D-Bus session, not because someone
 * wrote a fixture saying so.
 */
export function hostNotes(host: HostEnv, backend: string): string[] {
  const out: string[] = []
  const sentence = SECRET_BACKEND_SENTENCE[backend]
  if (sentence) out.push(sentence)
  if (!host.supportsSymlinks) {
    out.push(
      'Shortcuts between folders are not allowed on this machine, so shared files are copied instead of linked.',
    )
  }
  if (!host.supportsLongPaths) {
    out.push('Long file paths are switched off here, so deeply nested folders may be skipped.')
  }
  return out
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const diff = Math.max(0, now - Date.parse(iso))
  const mins = Math.round(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function untilTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'shortly'
  const diff = Date.parse(iso) - now
  const mins = Math.max(1, Math.round(diff / 60_000))
  if (mins < 60) return `in about ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.round(mins / 60)
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** Where a store lives, said the way a person would point at it. */
export function whereIs(loc: StoreLocation): string {
  switch (loc.kind) {
    case 'file':
    case 'dir':
    case 'dropin':
      return loc.path
    case 'plist':
      return `managed preferences (${loc.domain})`
    case 'registry':
      return `${loc.hive}\\${loc.key}`
    case 'remote':
      return `delivered by ${loc.provider} when you sign in`
  }
}

export const SCOPE_WORD: Record<Scope, string> = {
  managed: 'set by your organisation',
  team: 'set by your team',
  user: 'yours, for every project',
  project: 'in this project',
  local: 'in this checkout only',
}

/**
 * The sentence a merge strategy deserves.
 *
 * Drawn from the adapter's own `KeyRule.merge`, not written by hand per group —
 * so if an adapter changes `permissions.allow` from `union-list` to `replace`,
 * the note under the Permissions group changes with it.
 */
export const MERGE_SENTENCE: Partial<Record<MergeStrategy, string>> = {
  'union-list': 'Rules add up across machines — they never replace each other.',
  concat: 'These run in order, and a second machine’s copy is added to the end.',
  'most-restrictive': 'Where two machines disagree, the stricter setting wins.',
  'deep-merge': 'Only the parts you changed are written; the rest is left alone.',
  replace: 'The value here replaces whatever the other machine had.',
  never: 'This one is never written anywhere.',
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function joinNames(names: string[], max = 3): string {
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? ''
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}
