# Zed spike: does `ToolAdapter` survive a tool that isn't Claude Code?

**Short answer: no. The file-per-concept assumption breaks, and it breaks at the
one place that matters most — the unit of sync.**

`docs/adapter-fit.md` predicted this and asked for the spike before we freeze the
interface. The prediction was right, but the reason is narrower and more fixable
than "the abstraction is wrong". `StoreLocation` (the union) held up perfectly.
`StoreDescriptor` (the sync unit) did not. Four defects are new — they were not
in the Cursor list, and two of them are silent-wrong-answer bugs that exist in
`core/reconcile.ts` **today**.

Everything below is sourced from Zed's official docs, cited per line in
`src/adapters/zed.ts`. **Zed is not installed on the authoring machine** —
`/Applications/Zed.app`, `~/Applications/Zed.app`, `~/.config/zed`,
`~/Library/Application Support/Zed`, `~/.zed` are all absent and `zed` is not on
`PATH` (checked 2026-07-29). Nothing is `[V-fs]`; docs are the ceiling.

---

## 0. What Zed actually does (the research)

| Thing | Where it lives | Source |
|---|---|---|
| User settings | `~/.config/zed/settings.json` (macOS **and** Linux, `$XDG_CONFIG_HOME` honored); `%APPDATA%\Zed\settings.json` (Windows) | [configuring-zed](https://zed.dev/docs/configuring-zed) |
| Keymap | `~/.config/zed/keymap.json` / `%APPDATA%\Zed\keymap.json` — **a top-level JSON array** | [key-bindings](https://zed.dev/docs/key-bindings) |
| Project settings | `.zed/settings.json` in the worktree root (subdirs too) | [configuring-zed](https://zed.dev/docs/configuring-zed) |
| Tasks | `~/.config/zed/tasks.json`, `.zed/tasks.json` — **array-rooted, every entry a shell command** | [tasks](https://zed.dev/docs/tasks) |
| Agent config | **`agent` — a key inside settings.json.** Not a file. | [ai/agent-settings](https://zed.dev/docs/ai/agent-settings) |
| MCP servers | **`context_servers` — a key inside settings.json.** Confirmed; not `mcpServers`. | [ai/mcp](https://zed.dev/docs/ai/mcp) |
| External (ACP) agents | `agent_servers` — key inside settings.json, carries `command`/`args`/`env` | [ai/external-agents](https://zed.dev/docs/ai/external-agents) |
| Tool permissions | `agent.tool_permissions` — **Rust regex** patterns | [ai/tool-permissions](https://zed.dev/docs/ai/tool-permissions) |
| Sandbox | `agent.sandbox_permissions` (macOS Seatbelt / Linux Bubblewrap / Windows **only under WSL**) | [ai/sandboxing](https://zed.dev/docs/ai/sandboxing) |
| Skills | `~/.agents/skills/` and `<worktree>/.agents/skills/` — the same `SKILL.md` tree Claude Code and Cursor use | [ai/skills](https://zed.dev/docs/ai/skills) |
| Rules / instructions | `.rules` → `.cursorrules` → `.windsurfrules` → `.clinerules` → `.github/copilot-instructions.md` → `AGENT.md` → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`. **"Zed uses the first matching file in this list."** Global: `~/.config/zed/AGENTS.md`. | [ai/instructions](https://zed.dev/docs/ai/instructions) |
| API keys | **System keychain, not settings.json.** "Keys saved through Zed are stored in the system keychain, not in `settings.json`." | [ai/use-api-access](https://zed.dev/docs/ai/use-api-access) |
| Format | **JSONC.** "The syntax is JSON with support for `//` comments." | [configuring-zed](https://zed.dev/docs/configuring-zed) |
| Managed/enterprise layer | **NONE.** No MDM, no Group Policy, no `/etc` drop-in. Zed Business admin controls are server-side dashboard toggles: "Most controls apply server-side to anything that routes through Zed's infrastructure." | [business/admin-controls](https://zed.dev/docs/business/admin-controls) |
| Trust gate | Every worktree opens in **Restricted Mode**, which prevents "Project settings (`.zed/settings.json`) from being parsed and applied" and blocks language-server and MCP-server spawning | [worktree-trust](https://zed.dev/docs/worktree-trust) |

Two corrections to `adapter-fit.md` §4, which called Zed "worst as #3": it said
Zed has "no file-based subagent definitions" and implied no skills story. Zed
**does** support `SKILL.md` Agent Skills at `~/.agents/skills/`, i.e. the same
open standard and the same directory as Claude Code and Cursor. That is the one
concept that ports cleanly across all three tools.

---

## 1. Did the file-per-concept assumption break? Yes.

**The failing line is `src/core/types.ts:91`:**

```ts
/** False for managed scopes: we surface them as overrides, never sync them. */
syncable: boolean
```

`syncable` is a property of a `StoreDescriptor`, and a `StoreDescriptor` has
exactly one `location`. For Claude Code and Cursor that is fine, because a
location is a file and a file is a concept. For Zed, the exact config that breaks
it is an ordinary `~/.config/zed/settings.json`:

```jsonc
{
  // agent config — user wants this synced
  "agent": { "default_model": { "provider": "zed.dev", "model": "claude-sonnet-4-5" } },

  // MCP servers — user wants this synced
  "context_servers": { "gh": { "command": "npx", "args": ["-y", "server-github"] } },

  // editor preferences — user does NOT want these synced
  "buffer_font_size": 15,
  "theme": "One Dark"
}
```

Verified against the built adapter — `flatten()` on that document yields these
leaf paths, all in one store:

```
buffer_font_size, theme,
agent.default_model.provider, agent.default_model.model,
context_servers.gh.command, context_servers.gh.args
```

and `locations()` emits exactly one descriptor for it:

```
{"kind":"file","path":"/Users/x/.config/zed/settings.json","format":"jsonc"} | syncable = true
```

There is **no correct value for that boolean**:

- `syncable: true` → syncing MCP servers also pushes `buffer_font_size` and
  `theme` to every device. That is the "a user syncing MCP servers does not want
  their font size synced" failure, verbatim.
- `syncable: false` → the user cannot sync MCP servers or agent config at all,
  which is the entire product.

The adapter emits `true` and raises a warning on **every** plan, because the
alternative — inventing several descriptors that each claim to own the same path
— would be a lie the type system happily accepts and `apply()` would turn into
concurrent writers clobbering one file. The concept split is recorded as data in
`SHARED_FILE_CONCEPTS` instead, following the `UNREPRESENTABLE_STORES` precedent.

**Corollary that bites harder than the boolean.** `Plan.baseHashes` is
`Record<storeId, string>` — one hash per store, i.e. per file. Optimistic
concurrency is therefore file-granular: a plan that touches only
`context_servers` is invalidated by the user changing their font size in the UI,
and two devices editing disjoint concepts conflict every time. With file-per-
concept that is a rare true conflict; with Zed it is the normal case.

---

## 2. What is the unit of sync? Concrete type change.

A whole file is too coarse and a single key is too fine (you would lose the
ability to say "this concept is os-scoped"). The right unit is a **named subtree
of a file**. Two changes:

```ts
export interface StoreDescriptor {
  id: string
  scope: Scope
  location: StoreLocation

  /**
   * Dot-path root this descriptor owns INSIDE `location`. Omitted = whole
   * document (today's behavior, so this is backward compatible).
   * Two descriptors may share a `location` only if their subtrees are disjoint.
   */
  subtree?: string

  /**
   * Physical write target. Descriptors sharing a `fileId` MUST be coalesced by
   * apply() into ONE atomic read-modify-write. Without this, applying two
   * subtree changes to one file is two writes and the second clobbers the first.
   */
  fileId?: string

  /** Vendor-neutral concept name, so the UI can group across tools. */
  concept?: 'agent' | 'mcp' | 'permissions' | 'rules' | 'skills' | 'editor' | 'other'

  readable: boolean
  writable: boolean
  syncable: boolean          // now scoped to the subtree — becomes answerable
  provenance: Provenance
  provenanceNote?: string
}
```

With that, Zed's user settings become four honest descriptors —
`zed:user:settings#agent`, `#context_servers`, `#agent_servers`,
`#language_models` (all `syncable: true`, `fileId: "zed:user:settings"`) — plus
an unsynced remainder. `read()` returns the subtree; `plan()` diffs within it;
`apply()` groups by `fileId` and does one merge-write. It also cleanly expresses
things the current type cannot, like Claude Code's `~/.claude.json` (where
`mcpServers` is syncable but `oauthAccount` and `history` are not) — which we
currently paper over with `never-sync` key rules and a comment reading
"DANGER: this file braids config together with identity and history."

**This is the change I would make before tool #4.** It is additive and
backward-compatible: every existing descriptor omits `subtree` and behaves
identically.

`baseHashes` needs a matching fix — either hash per subtree, or keep the file
hash but let `apply()` accept a conflict when the changed regions are disjoint.

---

## 3. JSONC: we destroy comments. Not acceptable for `apply()`.

Zed's format is JSONC (["The syntax is JSON with support for `//`
comments."](https://zed.dev/docs/configuring-zed)), and this is not a rare edge:
Zed's own documented workflow encourages keeping commented-out examples inline,
so `settings.json` is the most comment-dense config in the survey.

The pipeline destroys them, verified:

```
input:  { // my font
          "buffer_font_size": 15,
          /* block */ "theme": "One Dark", }
parseJsonc -> commentCount: 2, trailingCommas: 1
doc.data   -> {"buffer_font_size":15,"theme":"One Dark"}     <- comments gone
```

`read()` does `JSON.parse(strip(text))`; `ConfigDoc` holds only parsed `data`;
`canonicalize()` re-emits from `data`. By the time any writer sees the document
the comments no longer exist. A naive `apply()` would delete a user's annotated
settings file and call it success.

**Is that acceptable?** For **hashing**, yes — arguably correct: we want "did the
semantic config change?", and a comment edit should not trigger a sync. For
**writing**, absolutely not. Silently deleting user authorship is exactly the
class of bug this product cannot survive, and it is worse than the Cursor case
because Zed users comment far more.

This is why `zedAdapter.apply()` throws `NotImplemented` rather than being
stubbed out for later — and the adapter counts comments during `read()` so
`plan()` warns per store rather than discovering the problem at write time.

**What preserving them takes** (roughly in order of cost):

1. `ConfigDoc` must carry the original bytes: `raw?: Uint8Array`. This is
   `adapter-fit.md` §5h again, now blocking a second tool.
2. A **format-preserving JSONC edit** path — apply a small set of
   `(dot-path, newValue)` edits to the original text via a CST, touching only the
   spans that changed. `jsonc-parser`'s `modify`/`applyEdits` does exactly this
   and is the standard VS Code solution; writing our own CST is the alternative.
3. `apply()` must switch from "serialize `data`" to "apply edits to `raw`". That
   is a real change to the write contract, not an implementation detail — and it
   is the same machinery §2's `subtree` coalescing needs, since both are
   "surgically modify part of a file and leave the rest byte-identical".

Note (2) and (3) are also what make `subtree` writes safe. The two fixes share
one implementation, which is a good argument for doing them together.

---

## 4. Zed reads `CLAUDE.md`. Redundant, or double-applied?

**Neither. It is worse than both: it's silent shadowing, and it makes writing a
file a destructive act.**

`adapter-fit.md` §3d worried about *double-apply* — a target reading both our
output and the original, charging the user tokens twice. That is the Cursor
failure mode (Cursor reads `AGENTS.md` **and** `.cursor/rules/`, additively). It
is **not** Zed's. Zed's chain is
[first-match-wins](https://zed.dev/docs/ai/instructions): "Zed uses the first
matching file in this list."

So for a repo containing both `CLAUDE.md` and `.rules`, Zed reads **only**
`.rules`. Three consequences:

1. **No double-apply.** Good.
2. **Compiling is often a no-op.** A repo with only `CLAUDE.md` already works in
   Zed — position 8 in the chain. "Compiling" `CLAUDE.md` → `AGENTS.md` gains
   nothing for Zed and adds a second file to keep in sync.
3. **Compiling can silently DISABLE the source.** Writing `.rules` — the obvious
   "native Zed target" — moves Zed's instructions to the new file and makes
   `CLAUDE.md` **inert for Zed**. If our generated `.rules` is stale, truncated,
   or a lossy flatten, the user's real instructions stop reaching the agent, with
   no error and no diff to notice. The file we wrote *looks* additive. It isn't.

That is a mirror of `adapter-fit.md` §3a's "silent no-op" bug, running the other
direction: there, writing a file did nothing; here, writing a file **turns
something off**. Both are invisible, both are permanent, and the interface models
neither, because `StoreDescriptor` cannot express "this store is live only when
those nine other stores are absent."

The adapter handles it the only way currently possible: it emits all nine chain
files as descriptors (eight of them **read-only**, since `.cursorrules` belongs
to the Cursor adapter and `CLAUDE.md` to the Claude Code adapter), computes
liveness in `plan()`, and warns. Verified:

```
Zed reads only ".rules" — the first match in its nine-file chain. CLAUDE.md
exists but is INERT for Zed (still live for their own tools). Writing a
higher-precedence file silently disables the others for Zed.
```

Emitting foreign paths read-only is a deliberate departure from `cursor.ts`'s
"never emit another adapter's path" rule, and it needs the justification: Zed's
*behavior* is a function of which of those files **exist**, so `plan()` cannot
compute the truth without observing all nine. Reading is required. Writing stays
with the owning adapter.

**Product consequence.** The "compile one source to many tools" pitch needs a
fourth mode besides write/skip/downgrade: **"target already reads your source —
do nothing."** For Zed + `CLAUDE.md`, the correct plan is an empty plan, and we
should be able to say so with confidence rather than helpfully generating a file
that hijacks precedence.

---

## 5. Bottom line: does `ToolAdapter` need to change before tool #4?

**Yes — but less than the headline suggests. The union types held; the sync unit
and the reconcile engine did not.**

What genuinely survived contact with an adversarial tool, and should be
considered validated: `StoreLocation` as a union (Zed needed `file`, `dir`,
`remote` and no new kinds); managed scopes as read-only; `Provenance` gating
writes; `PortabilityClass`; `plan()` purity (byte-identical ids across repeated
calls, verified); and `never-sync` (an MCP `env` secret was confirmed absent from
the serialized plan). `rules(storeId?)` — the §5b fix — was **needed on the first
tool after it landed**, for a reason Cursor didn't have: Zed rejects `theme` and
`vim_mode` in project settings, so the same key is legal in one store and inert
in another. And `most-restrictive` + `Strictness` — the §5e fix — earned its
place immediately on `always_allow` (intersection) vs `always_deny` (union).

### Changes required, in severity order

**a. `StoreDescriptor` needs sub-file addressing. (Blocking.)**
Failing case: `~/.config/zed/settings.json` holds `context_servers` and
`buffer_font_size` as peer keys and `syncable` is one boolean for the file.
Fix: `subtree` + `fileId` + `concept` (§2). Also fixes Claude Code's
`~/.claude.json` identity/config braid, which we currently work around.

**b. `flatten()` cannot see array-rooted documents. (Silent-wrong-answer bug, exists today.)**
`src/core/reconcile.ts:381`:
```ts
if (!isPlainObject(value)) return prefix ? [[prefix, value]] : []
```
`isPlainObject` rejects arrays, so at the root (`prefix === ''`) it returns `[]`.
Verified: `flatten([{context:'Editor',bindings:{...}}])` → `[]`, and
`getPath(arr, '0.context')` → `undefined`. Zed's `keymap.json` **and**
`tasks.json` are both top-level arrays, so the reconcile engine produces **zero
changes** for them and reports success. `tasks.json` is a list of shell commands
— a config-sync product that silently syncs nothing there is worse than one that
refuses. Claude Code and Cursor are object-rooted everywhere, which is the only
reason this never surfaced. Fix: index array elements in `flatten`/`getPath`/
`setPath`, or make `plan()` fall back to a whole-document op. The adapter uses
the fallback and warns, but the engine bug should be fixed centrally.

**c. `Strictness` cannot rank an ordered enum. (Security-relevant.)**
`agent.tool_permissions.default` is `"allow" | "confirm" | "deny"` — ordered by
strictness, but not boolean, not numeric, not a list. None of the six `Strictness`
members apply. `replace` would let a lower-precedence layer downgrade `deny` to
`allow`: precisely the privilege escalation the `most-restrictive` design exists
to prevent. The adapter sets `merge: 'never'` and refuses to sync the key at all
— safe, but a real functional loss. Fix:
```ts
export type Strictness =
  | 'true-is-stricter' | 'false-is-stricter'
  | 'lower-is-stricter' | 'higher-is-stricter'
  | 'intersection' | 'union'
  | { kind: 'ordinal'; order: string[] }   // e.g. ['allow','confirm','deny'], last = strictest
```

**d. `ConfigDoc` still drops raw bytes.** `adapter-fit.md` §5h, now blocking a
second tool and, for Zed, blocking `apply()` entirely (§3). Add
`raw?: Uint8Array`. `cursor.ts` already smuggles text through
`ParsedMarkdown.raw`; `zed.ts` had to do the same, plus hang a comment count off
a non-enumerable symbol because there is nowhere structured to put it.

**e. `StoreDescriptor` cannot express conditional liveness.** Nine instruction
files, only the first present one is live (§4). Fix: `activeWhen?: { absent: string[] }`,
or a first-match store group.

**f. Nothing can express "written but inert."** An untrusted Zed worktree parses
no project settings, so `apply()` can report complete success having changed
nothing observable — and trust state is not readable by us.
`Change.overriddenBy?: Scope` is the closest field and it means something else.
Fix: `Change.inertBecause?: 'untrusted-worktree' | 'unsupported-on-os' | ...`.
(`agent.sandbox_permissions` on native Windows is a second instance: it only
takes effect under WSL, so syncing it writes a key that does nothing.)

**g. `Scope` has no honest slot for "no managed layer exists."** Zed is the first
tool with genuinely nothing to put in `managed`, and an empty list is
indistinguishable from "we didn't look." Minor, but for a product whose whole
value is trust in a path table, "we checked and there is none" should be
expressible. The adapter records it in `UNREPRESENTABLE_STORES` and warns on
every plan.

### Recommendation

Do **(a)**, **(b)** and **(c)** before tool #4. (b) is a live bug in shared code
and is cheap. (a) is the real architectural change, and every additional adapter
written against the current shape is one more thing to migrate. (c) is a
five-line type change that removes a security footgun.

(d) can wait until someone implements `apply()` — but note that (a) and (d)
require the same format-preserving-write machinery, so they are better done
together than six months apart.

The abstraction is not wrong. It is a *file*-oriented model that needs to become
a *concept*-oriented one, and the change is additive. But it should be made now:
the cost of `subtree` is a day today and a migration of every adapter later.
