# Does `ToolAdapter` actually fit Cursor?

**Short answer: yes, better than expected — but for a reason that should worry us.**

Cursor fits because Cursor has spent the last year converging on Claude Code's
design. It now has skills (the *same* Agent Skills / `SKILL.md` open standard),
subagents, lifecycle hooks, `Shell()`/`Read()`/`Write()`/`Mcp()` permission
tokens, `mcpServers` as the MCP key, `AGENTS.md`, and an MDM policy layer. It
literally reads `.claude/skills/`, `.claude/agents/` and `.claude/settings.json`
hooks for cross-tool compatibility.

So the fit is not evidence that our abstraction is good. It is evidence that we
picked two tools that already agree. The interface has not been stress-tested
yet, and several places where it is already wrong are catalogued below.

Everything here is sourced from official Cursor docs (`cursor.com/docs/*.md`).
**No Cursor install existed on the authoring machine**, so nothing is
filesystem-verified — see the provenance tags in `src/adapters/cursor.ts`.

---

## 1. What Claude Code has that Cursor has no analogue for

| Claude Code | Cursor | Consequence |
|---|---|---|
| **`settings.local.json` (the `local` scope)** | **Nothing.** Cursor's scopes are managed / user / project only. | This is the biggest gap. Our `local` scope is the gitignored escape hatch that makes the shared layers safe. Cursor users have nowhere to put "this machine only" config, so machine-scoped keys must be pushed *up* into the user scope and re-resolved per device. |
| `permissions.ask` (a real three-way allow/ask/deny) | CLI has `allow`/`deny` only. | The IDE's `autoRun` classifier is a fuzzy third state, but it is *prose*, not a rule list. Not a faithful target. |
| `.claude.json` braiding identity + config + history | Split cleanly across files. | Cursor is *better* here. |
| Plugin/marketplace manifests, `.skill-lock.json` | Marketplace exists but no documented on-disk lockfile. | Skills can be enumerated but not pinned by content hash. |
| Output styles | None. | Drop on compile. |

## 2. What Cursor has that Claude Code has no analogue for

| Cursor | Claude Code | Consequence |
|---|---|---|
| **`sandbox.json`** — declarative fs + network sandbox (`networkPolicy.allow/deny`, CIDR, `additionalReadwritePaths`, `workspace_readonly`/`insecure_none`) | No declarative equivalent. | A whole config domain with no source-of-truth representation. Its merge semantics are also *most-restrictive-wins*, which `MergeStrategy` cannot express (see §5i). |
| **`autoRun.allow_instructions` / `block_instructions`** — natural-language steering of an LLM classifier | Nothing. | Config that is **English prose**, not data. It cannot be diffed meaningfully, cannot be validated, and "merging" two prose lists can produce contradictions. Our whole model assumes config is data. |
| **`.mdc` activation modes** — `alwaysApply`, `globs`, description-driven auto-selection, `@`-mention-only | `CLAUDE.md` is always-on, full stop. | See §3. This is where one-source-to-many actually breaks. |
| **Tab hooks** (`beforeTabFileRead`, `afterTabFileEdit`) — lifecycle for inline completions | No inline-completion surface at all. | Unmappable in both directions. |
| **Team scope** — dashboard-delivered rules/hooks/MCP, *user-toggleable unless "enforced"* | Managed settings are absolute. | Our `Scope` enum has no `team`. I collapsed it into `managed`, which is **wrong**: a non-enforced Team Rule can be switched off by the user, so calling it `managed` overstates it. |
| `.cursorignore` / `.cursorindexingignore` | Closest is `permissions.deny: Read(...)`. | Different mechanism (indexing vs tool access), gitignore syntax, untypeable (§5c). |
| Per-store merge semantics | Uniform. | `permissions.json` **concatenates** user+repo arrays; `cli-config.json` permissions **replace**. Same dot-path, different files, different rules (§5g). |

---

## 3. Is a shared "rules/instructions" concept real?

**Partly — and the part that is real is much smaller than the pitch implies.**

The genuinely shared substrate is **`AGENTS.md`: plain always-on markdown prose,
discovered by walking the directory tree.** Cursor, Codex, Windsurf/Devin and Zed
all support it. Compiling one source to that target is safe.

Everything above that layer diverges enough to produce bad output:

**a. The silent no-op.** Compiling a Claude Code `CLAUDE.md` into
`.cursor/rules/my-rule.md` produces a file Cursor **ignores entirely** — plain
`.md` there has no frontmatter, so it is skipped. The user sees a file, sees it
in git, and gets zero behavior change. This is the single most dangerous compile
bug available to this product, because it fails *silently and permanently*.
`src/adapters/cursor.ts` emits an explicit `skip` Change for exactly this case
rather than writing the file.

**b. Losing activation semantics is a correctness bug, not a formatting one.**
A Cursor rule scoped `globs: src/components/**/*.tsx` compiled down to
always-on `CLAUDE.md` prose does not merely bloat context — it applies React
component conventions to backend files. Compiling the other direction has to
*invent* an activation mode that the source never specified. Activation is
semantic content, and only one of the two formats can carry it.

**c. Silent truncation.** Windsurf caps global rules at 6,000 characters and
workspace rule files at 12,000. Codex caps project docs at 32 KiB
(`project_doc_max_bytes`). A source that is fine for Claude Code silently loses
its tail on other targets.

**d. Tools already read each other's files.** Zed's project-instruction fallback
chain is `.rules` → `.cursorrules` → `.windsurfrules` → `.clinerules` →
`copilot-instructions.md` → `AGENT.md` → `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`.
Cursor reads `.claude/skills/` and `.claude/agents/`. So "compiling" can be a
no-op (the tool already read the source file) or a *double-apply* (it reads both
our output and the original). **We must model what a target already reads, or we
will duplicate instructions into context and charge the user tokens for it.**

**Conclusion:** treat "always-on prose" as the portable core and model activation
mode, glob scoping, priority and size limits as first-class *capabilities* that
a target either supports or does not. A compile to a target lacking a capability
must be a visible, reviewable downgrade — never a silent flatten.

---

## 4. Which of Codex / Windsurf / Zed should be tool #3?

**Recommendation: Codex — with a caveat I want on the record.**

**Codex (best fit, easiest).** Near 1:1 with Claude Code. Layered precedence is
explicitly documented (CLI flags → project `.codex/config.toml` → profile → user
`~/.codex/config.toml` → `/etc/codex/config.toml` → defaults). `AGENTS.md` with
directory-walking and `AGENTS.override.md`. MCP at user *and* project scope.
Subagents and skills are already files (`~/.codex/agents/`, `.agents/skills/`).
Hook event names are Claude Code's vocabulary almost verbatim — `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `SessionStart`, `SubagentStop`, `PreCompact`.
And it has the most complete managed layer of any tool surveyed:
`/etc/codex/requirements.toml`, `%ProgramData%\OpenAI\Codex\requirements.toml`,
and a macOS MDM domain `com.openai.codex` — which independently re-validates the
`StoreLocation` union. The only impedance is TOML vs JSON: a serializer, not a
model change. Gotcha: project `.codex/config.toml` and project MCP load **only
for trusted projects**, so the adapter must handle the trust state.

**Windsurf/Devin (second).** Every concept exists as a file, and it explicitly
reads `.claude/skills/`. But it is mid-rebrand — the app reads legacy
`Windsurf`/`Codeium` paths and writes new `Devin` ones, so the adapter carries
two path eras at once. MCP has **no documented project scope**. Hook levels
**merge rather than override**, inverting our precedence intuition. The
authoritative org policy lives in a server-side Admin Portal we cannot write to.
Roughly double the surface area for less validation value than Codex.

**Zed (worst as #3, best as a stress test).** Zed inverts the file-per-concept
assumption: nearly everything collapses into one JSONC `settings.json`, so every
write is a surgical merge that must preserve user comments and unrelated keys.
MCP is `context_servers`, not `mcpServers`. Permissions are **Rust regex**, so
translating our glob/prefix rules is lossy in both directions — a category of bug
that silently *widens* a permission grant. There are no agent lifecycle hooks and
no file-based subagent definitions, so two concepts have nowhere to go. Anything
written to `.zed/settings.json` is inert until the user trusts the worktree. And
there is no enterprise managed layer at all.

**The caveat.** Picking Codex means three of our first three tools share one
shape, and we will have encoded Claude Code's model as *the* model without ever
testing it. Cursor did not stress the abstraction because Cursor copied Claude
Code. Codex will not stress it either. **Ship Codex third for velocity, but run a
one-week Zed spike before we freeze `ToolAdapter`** — Zed is the tool that proves
whether we built an abstraction or just a Claude Code path table with a plural
name.

---

## 5. Where `ToolAdapter` is wrong and should change

Ordered by how much damage each will do if left alone.

**a. `StoreDescriptor` has no confidence field. (Highest severity.)**
A wrong path is stated to be the worst bug this product can ship, yet the
VERIFIED/ASSUMED distinction lives only in code comments. It should be typed:

```ts
confidence: 'verified-doc' | 'verified-fs' | 'inferred'
```

and `apply()` should **refuse to write** to an `inferred` path in `managed`
scope. Concretely: Cursor's Windows Group Policy key is inferred — the docs
confirm ADMX-based policy and both HKLM/HKCU levels but never print the key.
Today nothing in the type system stops a future writer from trusting it.

**b. `rules()` cannot vary by store. (Real bug, hit while building.)**
Cursor's `permissions.json` **concatenates** per-user and per-repo arrays, while
`cli-config.json`'s `permissions` **replace**. Identical dot-path
`permissions.allow`, different semantics per file. `rules(): KeyRule[]` is global
per adapter and cannot express it. Fix: `rules(storeId?: string): KeyRule[]`, or
add `storeId?: string` to `KeyRule`.

**c. No project root anywhere in the interface.**
`locations(host)` cannot express `<project>/.cursor/mcp.json`, and `read(store,
host)` has no cwd either — so relative paths silently resolve against
`process.cwd()`. For a product whose job is writing files, "which directory" is
not a detail. Fix: `locations(host, ctx?: { projectRoot?: string })` and thread
the same context through `read`/`plan`/`apply`.

**d. `Scope` is a 4-value enum modeling one tool's layering.**
Cursor has no `local`, and has a `team` layer that is server-delivered but
*user-toggleable unless enforced* — neither `managed` nor `user`. Worse, the
precedence *order differs per concept within one tool*: hooks resolve
Enterprise > Team > Project > User, while rules resolve Team > Project > User.
A single global enum cannot encode that; I had to hardcode a `MANAGED_OVERRIDES`
table in the adapter. Fix: give `StoreDescriptor` an explicit numeric precedence
plus a `kind`, and let adapters declare per-concept ordering.

**e. `MergeStrategy` is missing `most-restrictive`.**
`sandbox.json` documents: deny lists always union; `networkPolicy.default` —
`"deny"` beats `"allow"`; restrictive booleans — `true` wins. This is a real,
documented strategy and there is no way to say it. Expressing it as `replace`
would let a user layer *weaken* a security policy on merge. That is a security
bug the type system currently invites.

**f. `StoreLocation` cannot express two real Cursor stores.**
`file.format` has no `text` member, so `.cursorignore` (gitignore syntax) is
untypeable. There is no `sqlite` kind, so `User/globalStorage/state.vscdb` — where
much of the Cursor Settings pane actually lives — cannot be represented at all.
Both are listed in `UNREPRESENTABLE_STORES` in the adapter so they surface as
known-and-excluded rather than as silent gaps.

**g. `registry` and `plist` are asymmetric.**
`plist` addresses a whole domain; `registry` addresses a single value. Cursor has
six policies across two hives, so macOS produces **1** descriptor and Windows
produces **12** for identical config. Fix: make `value` optional — omitting it
means the whole key.

**h. `ConfigDoc` drops the raw bytes.**
`canonicalize(doc: ConfigDoc)` receives only parsed `data`, so canonicalizing
markdown faithfully is impossible unless the adapter smuggles the original text
into `data` — which `cursor.ts` does (`ParsedMarkdown.raw`). That is a workaround,
not a design. Fix: add `raw?: Uint8Array` to `ConfigDoc`. Related: `apply()` will
need round-trip fidelity to preserve **JSONC comments** in `permissions.json`;
nothing in the types supports that today.

**i. `plan(desired: unknown, ...)` gives the "single source of truth" no type.**
Every adapter invents its own desired shape (`cursor.ts` defines
`CursorDesiredState`), which is precisely the thing the product claims to
provide. Relatedly, `buildPlan()` in `core/reconcile.ts` assumes `observed[0]` is
*the* settings document — true for Claude Code, false for Cursor's eight
independent config files. I reused reconcile's pure helpers (`flatten`,
`ruleFor`, `mergeValue`, `deepEqual`) but had to write a multi-store `plan()`.
`buildPlan` should become multi-store or be documented as single-file-only.

**j. `HostEnv` carries no environment.**
`CURSOR_CONFIG_DIR` and `XDG_CONFIG_HOME` both relocate Cursor's user config
directory, and `%ProgramData%` is needed for the Windows enterprise hooks path.
None are reachable, so `locations()` emits documented defaults and `plan()` has
to raise a warning instead of computing the right answer.

---

## Verdict

The abstraction holds for Cursor, and the parts that hold — `StoreLocation` as a
union (plist/registry/remote all earned their place), managed scopes as
read-only, per-key portability classes, `plan()` purity — are genuinely right.
The `never-sync` classification demonstrably works: a scratch harness run during
development confirmed MCP `env` secrets never reach a plan, and that `plan()` is
byte-identical across repeated calls. Neither check is committed yet — both
should become real tests before tool #3.

But the fit is inflated by tool similarity, and there are two defects worth
fixing **before** tool #3, not after: **per-store merge rules (b)** and
**path confidence (a)**. The first is already producing incorrect merge behavior
for `permissions.json`; the second is the guardrail for the exact failure mode
this product cannot survive.
