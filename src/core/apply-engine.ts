/**
 * The only code in the product that writes to a user's config.
 *
 * Everything else — layering, planning, diffing — is pure and reversible by
 * construction. This is where that stops being true, so the rules are strict:
 *
 *   1. VALIDATE EVERYTHING BEFORE WRITING ANYTHING. A plan that is going to be
 *      partially refused should be refused before the first byte is written,
 *      not discovered halfway through.
 *   2. ABORT ON STALE STATE. If any target file changed since the plan was
 *      computed, the whole apply aborts. A plan the user approved is a plan
 *      against a specific disk state; applying it to a different one is
 *      applying something nobody reviewed.
 *   3. ALL-OR-NOTHING PER APPLY. Any failure mid-write restores every backup.
 *      A half-applied config is worse than an unapplied one — it is a state the
 *      user never chose and cannot reason about.
 *   4. NEVER WRITE TO A PATH WE ONLY GUESSED. `provenance: 'inferred'` is
 *      refused. Being useless on an unverified platform beats corrupting it.
 *   5. UNKNOWN KEYS SURVIVE. We read, mutate only the planned paths, and write
 *      back. These are versioned vendor formats that will grow keys we have
 *      never seen; rewriting a file from our own model would delete them.
 *
 * Rule 5 extends to bytes, not just keys: for a JSON/JSONC file that already
 * exists we edit the value spans that changed and leave the rest of the file
 * alone, so comments, key order, indentation and trailing commas survive. See
 * `platform/jsonc.ts`. Silently stripping a developer's annotations the first
 * time we write is the kind of thing that gets a tool uninstalled.
 */

import { mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  ApplyResult,
  Change,
  AdapterCapabilities,
  ConfigDoc,
  Detection,
  HostEnv,
  Plan,
  ProjectContext,
  StoreDescriptor,
  ToolAdapter,
} from './types.js'
import { ROOT_PATH, setPath } from './reconcile.js'
import { extractSecretRefs, resolveSecretRefs } from './vault.js'
import {
  atomicWriteFile,
  withBackup,
  restore,
  withFileLock,
  type BackupToken,
} from '../platform/atomic.js'
import { canonicalJson, sha256Hex } from '../platform/canonical.js'
import { resolveStorePath } from './concepts.js'
import { writeVerdict } from './write-verdict.js'
import { resolveStateDir } from '../platform/host.js'
import { editMany, parseTree, type JsoncEdit } from '../platform/jsonc.js'

export class StalePlanError extends Error {
  constructor(
    readonly storeId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `"${storeId}" changed on disk since this plan was computed ` +
        `(expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}). ` +
        `Re-plan and review again — applying would write changes nobody approved.`,
    )
    this.name = 'StalePlanError'
  }
}

export interface ApplyDeps {
  adapter: ToolAdapter
  host: HostEnv
  project?: ProjectContext
  /** Resolved secret values, unsealed from the vault on this device. */
  secrets?: ReadonlyMap<string, string>
  /** Injected so this stays testable and the engine never reads the clock. */
  now: () => string
  /** Override for tests. */
  stateDirOverride?: string
}

export interface RollbackManifest {
  v: 1
  rollbackId: string
  planId: string
  createdAt: string
  tokens: BackupToken[]
}

// ---------------------------------------------------------------------------

/**
 * Everything `apply()` will refuse, decided WITHOUT touching the disk.
 *
 * Exported because callers need to tell a user "this will be refused, here's
 * why" BEFORE prompting them — and the alternative was every caller
 * reimplementing these checks. Safety logic that exists in two places drifts,
 * and the copy that drifts is the one that stops refusing something.
 *
 * `applyPlan` calls this; there is exactly one implementation.
 */
export function validatePlan(
  plan: Plan,
  stores: Map<string, StoreDescriptor>,
  host: HostEnv,
  secrets?: ReadonlyMap<string, string>,
  detection?: Detection,
  capabilities?: AdapterCapabilities,
): {
  writable: Change[]
  skipped: Array<Change & { skipReason: string }>
  failed: Array<Change & { error: string }>
} {
  const writable: Change[] = []
  const skipped: Array<Change & { skipReason: string }> = []
  const failed: Array<Change & { error: string }> = []

  for (const change of plan.changes) {
    // `op: 'skip'` is a REPORT, not an instruction. Adapters emit them so a
    // user can see what was deliberately withheld.
    //
    // They must never reach the writer. A skip carries no `after`, and
    // `undefined` maps to a delete edit — so telling someone "we did not sync
    // your GITHUB_TOKEN" deleted their GITHUB_TOKEN. A store-level skip
    // (path '') was worse: it became a whole-document replacement that
    // serialized to the four characters `null`.
    //
    // Handled here rather than in each adapter, because safety logic in two
    // places drifts and the copy that drifts is the one that stops refusing.
    if (change.op === 'skip') {
      skipped.push({
        ...change,
        skipReason: change.reason || 'Reported by the adapter as deliberately not synced.',
      })
      continue
    }

    const store = stores.get(change.storeId)

    if (!store) {
      failed.push({
        ...change,
        error: `unknown store "${change.storeId}" for ${plan.toolId}`,
      })
      continue
    }
    if (change.blocked) {
      // buildPlan already stripped the value; writing the placeholder would put
      // the literal "[redacted]" into the user's config.
      skipped.push({
        ...change,
        skipReason: `Contains a secret (${change.blocked.reason}). Move it to the keychain and reference it as \${secret:<name>}.`,
      })
      continue
    }
    // Every static reason a write is refused, decided in ONE place. The engine
    // and the UIs necessarily agree — including about which reason wins when
    // more than one applies.
    if (capabilities) {
      const verdict = writeVerdict(store, {
        host,
        capabilities,
        ...(detection ? { detection } : {}),
      })
      if (!verdict.canWrite) {
        skipped.push({
          ...change,
          skipReason: verdict.remedy
            ? `${verdict.message} ${verdict.remedy}`
            : (verdict.message ?? 'Refused.'),
        })
        continue
      }
    }

    // `writeVerdict` already refuses non-file stores, but it is optional (a
    // caller may omit `capabilities`) and the compiler cannot see through it.
    // Keeping the guard here makes the narrowing explicit AND means omitting
    // capabilities degrades to fewer refusal reasons, never to an unsafe write.
    const loc = store.location

    // A directory of authored entries is writable: each change is one entry
    // file. `entryFile` means installed packages instead, which are re-resolved
    // from a lockfile per device, so writing the tree would fight the installer.
    if (loc.kind === 'dir') {
      if (loc.entryFile) {
        skipped.push({
          ...change,
          skipReason:
            'These are installed from a marketplace, not written by you. They travel as a list ' +
            'of what to install so each machine fetches its own copy.',
        })
        continue
      }
      const bad = unsafeEntryName(change.path)
      if (bad) {
        failed.push({ ...change, error: bad })
        continue
      }
      writable.push(change)
      continue
    }

    if (loc.kind !== 'file') {
      skipped.push({
        ...change,
        skipReason: `Writing to a "${loc.kind}" store is not supported — it needs a platform channel (MDM/registry/vendor API), not a file write.`,
      })
      continue
    }

    // Text formats (markdown, toml, yaml) have no dot-path structure — the
    // file IS the value. A keyed change against one is a modelling error, and
    // writing it would replace a user's prose with a serialized object.
    if (!isJsonFormat(loc.format)) {
      if (change.path !== ROOT_PATH) {
        failed.push({
          ...change,
          error:
            `"${store.id}" is a ${loc.format} file and has no key "${change.path}". ` +
            `Text stores can only be replaced whole.`,
        })
        continue
      }
      if (typeof change.after !== 'string') {
        failed.push({
          ...change,
          error: `"${store.id}" is a ${loc.format} file; its replacement must be text, not ${typeof change.after}.`,
        })
        continue
      }
    }

    // Secret references must resolve before we touch the disk. Writing a
    // literal "${secret:foo}" into a config file breaks the tool silently.
    const refs = collectSecretRefs(change.after)
    const missing = refs.filter((r) => !secrets?.has(r))
    if (missing.length) {
      failed.push({
        ...change,
        error: `unresolved secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} — this device may not be enrolled in the vault`,
      })
      continue
    }

    writable.push(change)
  }

  // A whole-document replacement and keyed edits to the same store are
  // contradictory: `applyChangesToDoc` resolved it by letting the root win and
  // dropping the rest — silently, so a plan could claim four changes, apply
  // "successfully", and land one. Ambiguity in a write path is not something to
  // resolve by precedence; refuse it and say why.
  // Group by the PHYSICAL FILE, not the store. Grouping by store id missed the
  // case this check exists for: a root replacement on Zed's remainder store and
  // keyed edits on `#agent` are different stores over the SAME settings.json.
  // Phase 3 coalesces them into one `editMany`, where the root replacement wins
  // and the keyed edits vanish — silently, which is the whole thing we refuse.
  const byWriteTarget = groupBy(writable, (c) => {
    const store = stores.get(c.storeId)
    return store?.fileId ?? c.storeId
  })
  const contradictoryFiles = new Set<string>()
  for (const [fileKey, group] of byWriteTarget) {
    if (group.some((c) => c.path === ROOT_PATH) && group.some((c) => c.path !== ROOT_PATH))
      contradictoryFiles.add(fileKey)
  }
  const writeTargetOf = (c: Change): string => stores.get(c.storeId)?.fileId ?? c.storeId
  const contradictory = contradictoryFiles

  if (contradictory.size) {
    const kept: Change[] = []
    for (const change of writable) {
      const target = writeTargetOf(change)
      if (!contradictory.has(target)) {
        kept.push(change)
        continue
      }
      failed.push({
        ...change,
        error:
          `"${target}" has both a whole-document replacement and keyed edits in the same plan` +
          (target === change.storeId ? '' : ` (via store "${change.storeId}", which shares that file)`) +
          `. Applying both is ambiguous — the replacement would discard the edits. Split them into separate applies.`,
      })
    }
    return { writable: kept, skipped, failed }
  }

  return { writable, skipped, failed }
}

export async function applyPlan(plan: Plan, deps: ApplyDeps): Promise<ApplyResult> {
  const { adapter, host, project, secrets, now } = deps

  const stores = new Map<string, StoreDescriptor>(
    adapter.locations(host, project).map((s) => [s.id, s]),
  )

  const applied: Change[] = []

  // ---- phase 1: validate, write nothing --------------------------------
  // Ask the adapter whether its tool is actually present before writing any of
  // its config. Cheap (a few stat calls) next to the cost of getting it wrong.
  const detection = await adapter.detect(host)
  const { writable, skipped, failed } = validatePlan(
    plan,
    stores,
    host,
    secrets,
    detection,
    adapter.capabilities,
  )

  if (!writable.length) {
    return { planId: plan.id, applied, skipped, failed, rollbackId: '' }
  }

  // ---- phase 2: staleness check, still writing nothing -------------------
  const byStore = groupBy(writable, (c) => c.storeId)
  const docs = new Map<string, ConfigDoc>()
  /** Raw bytes for format-preserving writes, captured with the staleness read. */
  const raw = new Map<string, string | null>()
  /** Raw-byte fingerprint per resolved path, re-checked just before the write. */
  const rawGuard = new Map<string, string>()
  /** The exact bytes those fingerprints describe, reused as the edit source. */
  const rawByPath = new Map<string, string | null>()

  for (const storeId of byStore.keys()) {
    const store = stores.get(storeId) as StoreDescriptor

    // Read the raw bytes FIRST, and fingerprint exactly those bytes.
    //
    // Order matters. Capturing the guard after `adapter.read()` meant a write
    // landing during the read got baked into the guard itself, so phase 3 then
    // "verified" against the intruder's content and overwrote it. The guard has
    // to describe precisely the bytes the edit is computed from — which is also
    // why the same read feeds both, rather than reading the file twice.
    if (store.location.kind === 'file') {
      const p = resolvePath(store.location.path, project)
      if (!rawGuard.has(p)) {
        const text = await readFileOrNull(p)
        rawGuard.set(p, text === null ? 'absent' : sha256Hex(text))
        rawByPath.set(p, text)
      }
      if (isJsonFormat(store.location.format)) raw.set(storeId, rawByPath.get(p) ?? null)
    }

    // Forward the project context. Without it `read()` resolved project-scope
    // paths against process.cwd() while the write below resolved them against
    // projectRoot — so we could diff one file and write another. Adapters that
    // bake the root into `locations()` are unaffected; ones that rely on `ctx`
    // were silently reading the wrong file.
    const doc = await adapter.read(store, host, project)
    docs.set(storeId, doc)

    const expected = plan.baseHashes[storeId]
    if (expected !== undefined && doc.hash !== expected) {
      // Abort everything. Do not apply the stores that did not move — the user
      // approved a coherent set, not a subset chosen by a race.
      throw new StalePlanError(storeId, expected, doc.hash)
    }
  }

  // ---- phase 3: write, with a restore path for every file ---------------
  const tokens: BackupToken[] = []
  const rollbackId = `rb-${plan.id.slice(0, 12)}-${sha256Hex(now()).slice(0, 8)}`

  // COALESCE BY PHYSICAL FILE. Several descriptors can address disjoint
  // subtrees of one document — Zed files `agent`, `context_servers`, `theme`
  // and `buffer_font_size` as peer keys of a single settings.json. Writing per
  // STORE would open that file once per subtree and each write would clobber
  // the last, so only the final subtree would survive.
  const byFile = groupBy(writable, (c) => {
    const store = stores.get(c.storeId) as StoreDescriptor
    return store.fileId ?? c.storeId
  })

  try {
    for (const [fileKey, fileChanges] of byFile) {
      // Every descriptor in the group points at the same path by definition.
      const first = stores.get(fileChanges[0]!.storeId) as StoreDescriptor

      // Directory stores: each change is one entry file. Written individually
      // and backed up individually, so a rollback restores every entry — and a
      // failure partway through still unwinds the ones already written.
      if (first.location.kind === 'dir') {
        const dir = resolvePath(first.location.path, project)
        await mkdir(dir, { recursive: true })
        for (const change of fileChanges) {
          const entry = join(dir, change.path)
          await withFileLock(entry, async () => {
            tokens.push(await withBackup(entry))
            if (change.op === 'delete') {
              // Deleting is never implicit: an entry vanishing from desired
              // state does not remove it, only an explicit delete does.
              await rm(entry, { force: true })
            } else {
              await atomicWriteFile(entry, String(materializeSecrets(change.after, secrets)))
            }
          })
        }
        applied.push(...fileChanges)
        continue
      }

      if (first.location.kind !== 'file') continue
      const path = resolvePath(first.location.path, project)

      // Rebase each change onto the whole document. A store with
      // `subtree: 'context_servers'` reads and plans relative to that branch,
      // so `github.command` here means `context_servers.github.command` there.
      const rebased = fileChanges.map((c) => {
        const store = stores.get(c.storeId) as StoreDescriptor
        if (!store.subtree) return c
        return {
          ...c,
          path: c.path === ROOT_PATH ? store.subtree : `${store.subtree}.${c.path}`,
        }
      })

      // Read the document once, from whichever descriptor carries the file.
      const wholeDoc = docs.get(fileKey) ?? docs.get(fileChanges[0]!.storeId)
      const contents = renderStore(
        first.location.format,
        raw.get(fileKey) ?? raw.get(fileChanges[0]!.storeId) ?? null,
        // Subtree docs hold only their branch; rebased paths address the whole
        // file, so the canonical fallback must start from the whole file too.
        first.subtree ? { ...(wholeDoc as ConfigDoc), data: {} } : (wholeDoc as ConfigDoc),
        rebased,
        secrets,
      )

      await mkdir(dirname(path), { recursive: true })

      // Hold an advisory lock across verify → backup → write.
      //
      // Against another agentsync process this closes the race outright: the
      // second one waits and then fails its own verify rather than clobbering.
      //
      // Against a FOREIGN writer (your editor, or Claude Code writing its own
      // settings) a lock is powerless — it has never heard of ours. For that we
      // re-fingerprint the raw bytes at the last possible moment, which shrinks
      // the window from "the whole apply" to "between this check and rename".
      // It cannot reach zero on POSIX, because rename() swaps the inode and no
      // fd we hold can prevent that. Narrowing plus detecting is the honest
      // ceiling, and losing the race now aborts instead of silently winning it.
      await withFileLock(path, async () => {
        const before = rawGuard.get(path)
        const nowFp = await fileFingerprint(path)
        if (before !== undefined && before !== nowFp) {
          throw new StalePlanError(fileKey, before, nowFp)
        }

        tokens.push(await withBackup(path))
        await atomicWriteFile(path, contents)
      })

      applied.push(...fileChanges)
    }
  } catch (err) {
    // Roll back everything already written. Restore failures are appended
    // rather than swallowed — a failed rollback is the worst state we can be
    // in and the user must be told which file is now inconsistent.
    const restoreErrors: string[] = []
    for (const t of tokens.reverse()) {
      try {
        await restore(t)
      } catch (e) {
        restoreErrors.push(`${t.path}: ${(e as Error).message}`)
      }
    }
    const note = restoreErrors.length
      ? `\n\nROLLBACK ALSO FAILED for:\n  ${restoreErrors.join('\n  ')}\nThese files may be inconsistent and need manual review.`
      : `\n\nAll changes were rolled back; nothing was left modified.`

    // Augment in place rather than re-wrapping. Wrapping in a plain Error threw
    // away the error's class, and callers switch on it — the CLI turns a
    // StalePlanError into "re-run diff", which is the single most useful thing
    // it can say here. A rollback note is not worth losing that.
    if (err instanceof Error) {
      err.message += note
      throw err
    }
    throw new Error(String(err) + note)
  }

  await persistRollback(deps, {
    v: 1,
    rollbackId,
    planId: plan.id,
    createdAt: now(),
    tokens,
  })

  return { planId: plan.id, applied, skipped, failed, rollbackId }
}

// ---------------------------------------------------------------------------

export async function rollbackApply(rollbackId: string, deps: ApplyDeps): Promise<void> {
  const file = join(rollbackDir(deps), `${rollbackId}.json`)
  const manifest = JSON.parse(await readFile(file, 'utf8')) as RollbackManifest
  if (manifest.v !== 1)
    throw new Error(`unsupported rollback manifest version ${String(manifest.v)}`)

  // Reverse order: restore the last write first, so interdependent files come
  // back in the state they were written from.
  for (const token of [...manifest.tokens].reverse()) await restore(token)
}

export async function listRollbacks(deps: ApplyDeps): Promise<RollbackManifest[]> {
  const dir = rollbackDir(deps)
  try {
    const names = await readdir(dir)
    const out: RollbackManifest[] = []
    for (const n of names.filter((n) => n.endsWith('.json'))) {
      const s = await stat(join(dir, n))
      if (!s.isFile()) continue
      out.push(JSON.parse(await readFile(join(dir, n), 'utf8')) as RollbackManifest)
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Mutate a parsed document by planned path only.
 *
 * Everything not named in a change is copied through untouched, which is what
 * preserves keys from newer versions of a format than we model.
 */
export function applyChangesToDoc(
  current: unknown,
  changes: Change[],
  secrets?: ReadonlyMap<string, string>,
): unknown {
  // Root-level change (array-rooted files like keymap.json / tasks.json):
  // there are no sub-paths, the document IS the value.
  const rootChange = changes.find((c) => c.path === ROOT_PATH)
  if (rootChange) return materializeSecrets(rootChange.after, secrets)

  // A scalar- or array-rooted document has no keys to address. Say so, rather
  // than letting setPath throw a bare TypeError from three frames down.
  if (current !== undefined && current !== null && typeof current !== 'object')
    throw new Error(
      `cannot apply keyed changes to a document whose root is a ${typeof current}; ` +
        `only a whole-document replacement is meaningful here`,
    )
  if (Array.isArray(current))
    throw new Error(
      'cannot apply keyed changes to an array-rooted document; ' +
        'only a whole-document replacement is meaningful here',
    )

  const next: Record<string, unknown> = structuredClone((current ?? {}) as Record<string, unknown>)

  for (const change of changes) {
    if (change.op === 'delete') {
      deletePath(next, change.path)
      continue
    }
    setPath(next, change.path, materializeSecrets(change.after, secrets))
  }
  return next
}

/**
 * Produce the exact bytes to write for one store.
 *
 * For a JSON/JSONC file that already exists this is a surgical edit of the
 * changed value spans; everything else in the file — comments, key order,
 * indentation, trailing commas, CRLF, a BOM — is carried through untouched
 * because it is never rewritten.
 *
 * New files are written canonically: there is no existing formatting to
 * preserve, and canonical bytes are what the rest of the product hashes.
 *
 * The canonical path is also the fallback when the file on disk cannot be
 * parsed. That case is already broken for the tool that owns it, and failing
 * the apply would abort every other store in the plan (rule 3) over a file we
 * were asked to fix. Note that the fallback is chosen by whether the file
 * PARSES, not by whether the edit succeeds: if the edit itself fails we let it
 * throw, because rolling the whole apply back is better than quietly falling
 * back to a write that strips the user's comments.
 */
function renderStore(
  format: 'json' | 'jsonc' | 'markdown' | 'toml' | 'yaml',
  existing: string | null,
  doc: ConfigDoc,
  changes: Change[],
  secrets?: ReadonlyMap<string, string>,
): string {
  // Text formats are NOT documents we can address by dot path. Their content
  // is the whole file, so the only meaningful change is a root replacement.
  // Falling through to canonicalJson() here would serialize a JSON object over
  // a user's CLAUDE.md — silent destruction of a file we were trusted with.
  // Phase 1 rejects anything else, so by here a root change is all there is.
  if (!isJsonFormat(format)) {
    const root = changes.find((c) => c.path === ROOT_PATH)
    if (!root || typeof root.after !== 'string')
      throw new Error(
        `refusing to write ${format} store: expected a whole-document string replacement`,
      )
    return materializeSecrets(root.after, secrets) as string
  }

  if (existing !== null && existing.trim() !== '' && isParseableJsonc(existing)) {
    return editMany(existing, toJsoncEdits(changes, secrets))
  }

  // The file EXISTS but does not parse. The canonical fallback would rebuild it
  // from our model, and our model of a file we could not read is wrong by
  // definition — for a subtree store it is `{}`, so we would write one branch
  // over a file that still held every other key the user had.
  //
  // The fallback's rationale is "this file is already broken for the tool that
  // owns it", which justifies not failing the whole apply. It does not justify
  // overwriting. Refuse this one file and let rule 3 roll the rest back.
  if (existing !== null && existing.trim() !== '') {
    throw new UnparseableFileError(doc.storeId)
  }

  return canonicalJson(applyChangesToDoc(doc.data, changes, secrets))
}

export class UnparseableFileError extends Error {
  constructor(readonly storeId: string) {
    super(
      `"${storeId}" exists on disk but is not valid JSON/JSONC, so it cannot be edited safely. ` +
        `Rewriting it from our own model would discard whatever is currently in it. ` +
        `Fix the syntax, or move the file aside, then re-run.`,
    )
    this.name = 'UnparseableFileError'
  }
}

function isJsonFormat(format: string): boolean {
  return format === 'json' || format === 'jsonc'
}

function isParseableJsonc(text: string): boolean {
  try {
    parseTree(text)
    return true
  } catch {
    return false
  }
}

/**
 * Mirror `applyChangesToDoc`'s semantics exactly, so which write path we take
 * can never change WHAT ends up in the file — only how the surrounding bytes
 * are treated.
 */
function toJsoncEdits(changes: Change[], secrets?: ReadonlyMap<string, string>): JsoncEdit[] {
  // A root-level change replaces the whole document; sub-path edits against the
  // document it replaces are meaningless, so they are dropped here just as they
  // are in applyChangesToDoc.
  const rootChange = changes.find((c) => c.path === ROOT_PATH)
  if (rootChange) {
    return [{ path: ROOT_PATH, value: materializeSecrets(rootChange.after, secrets) }]
  }
  return changes.map((c) => {
    const value = materializeSecrets(c.after, secrets)
    // `canonicalJson` drops undefined-valued keys entirely, so a change that
    // sets undefined has always meant "remove". Write it the same way here
    // rather than leaving a `null` behind.
    if (c.op === 'delete' || value === undefined) return { path: c.path, op: 'delete' as const }
    return { path: c.path, value }
  })
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function collectSecretRefs(value: unknown): string[] {
  if (typeof value === 'string') return extractSecretRefs(value)
  if (Array.isArray(value)) return value.flatMap(collectSecretRefs)
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).flatMap(collectSecretRefs)
  return []
}

function materializeSecrets(value: unknown, secrets?: ReadonlyMap<string, string>): unknown {
  if (!secrets) return value
  if (typeof value === 'string') return resolveSecretRefs(value, secrets).resolved
  if (Array.isArray(value)) return value.map((v) => materializeSecrets(v, secrets))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = materializeSecrets(v, secrets)
    return out
  }
  return value
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  const segs = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const nxt = cur[segs[i] as string]
    if (typeof nxt !== 'object' || nxt === null) return
    cur = nxt as Record<string, unknown>
  }
  delete cur[segs[segs.length - 1] as string]
}

/** Project-scope stores are repo-relative; user/managed stores are absolute. */
function resolvePath(path: string, project?: ProjectContext): string {
  // Delegates to the shared resolver so `read()` and `apply()` cannot disagree
  // about which file a project-relative path means.
  return resolveStorePath(path, project)
}

function rollbackDir(deps: ApplyDeps): string {
  return join(resolveStateDir(deps.host, deps.stateDirOverride), 'rollbacks')
}

async function persistRollback(deps: ApplyDeps, manifest: RollbackManifest): Promise<void> {
  const dir = rollbackDir(deps)
  await mkdir(dir, { recursive: true })
  // Plain write, not atomic: losing a rollback manifest costs undo history,
  // never user config, and an atomic write here would need its own backup.
  await writeFile(join(dir, `${manifest.rollbackId}.json`), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  })
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

/**
 * Fingerprint a file's raw bytes, or a sentinel when it does not exist.
 *
 * Deliberately NOT the parsed-document hash: that is computed from canonical
 * content and, for a subtree descriptor, from one branch only — so it cannot
 * see a concurrent edit to a different part of the same file.
 */
async function fileFingerprint(path: string): Promise<string> {
  const text = await readFileOrNull(path)
  return text === null ? 'absent' : sha256Hex(text)
}

/**
 * Reject an entry name that could escape its directory.
 *
 * A directory store's change path IS a filename, and it arrives from synced
 * desired state — i.e. from another machine. `../../.ssh/authorized_keys` is
 * the obvious attack, and a store whose entries are attacker-influenced is
 * exactly where path traversal belongs in the threat model.
 */
export function unsafeEntryName(name: string): string | null {
  if (!name) return 'entry name is empty'
  if (name.includes('/') || name.includes('\\'))
    return `entry name "${name}" contains a path separator; entries are flat files`
  if (name === '.' || name === '..' || name.startsWith('..'))
    return `entry name "${name}" would escape the directory`
  if (/^[a-zA-Z]:/.test(name)) return `entry name "${name}" is an absolute path`
  if (name.startsWith('.') && name.length > 1) return null
  return null
}
