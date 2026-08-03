# Agent config control plane

Manage AI coding tool configuration — Claude Code, Cursor, Zed — across every
device you own, from one place.

**Status: pre-alpha.** The engine, the CLI and the format-preserving writer are
real and tested — 734 tests. Writes are deliberately gated: off on Windows and
Linux until CI verifies the path tables, and off for any tool that is not
actually installed. See [What refuses a write](#what-refuses-a-write).

---

## Install

```bash
npm install -g @5edmat/agent-sync      # or: npx @5edmat/agent-sync <command>
```

Requires Node 20.11+, and works on macOS, Linux, WSL and Windows — all four are
covered by the [conformance matrix](#cross-platform). A handful of paths whose
location was never documented stay read-only; `agentsync doctor` names them.

```bash
agentsync init --adopt    # capture this machine's config as your baseline
agentsync status          # what's installed, what has drifted
agentsync diff            # review the changes, with risk called out
agentsync apply           # atomic, reversible; prints a rollback id
agentsync rollback <id>   # put it back exactly
agentsync doctor          # run this first when anything is surprising
```

Every command takes `--json`. Exit codes mean something: `0` ok, `1` error,
`2` usage, `3` nothing to do, `4` blocked by an unverified path.

Nothing is written without a plan you can read first, `apply` refuses anything
that can execute code unless you confirm it, and every write is backed up before
it happens.

**This release is device-local.** It reads, diffs, applies and rolls back on the
machine it runs on. Syncing between machines is designed but not built — see
[What doesn't](#what-doesnt).

---

## Why this exists

The obvious version of this product is already dead. Worth knowing before
reading further:

- **Anthropic ships enterprise config management natively.** Managed settings
  arrive from the claude.ai admin console at sign-in, plus MDM (`com.anthropic.claudecode`)
  and Group Policy (`HKLM\SOFTWARE\Policies\ClaudeCode`). Policy knobs already
  exist for permissions, MCP allowlists, hooks and marketplaces. "Fleet
  governance for Claude Code" is occupied by the platform owner.
- **Skills are already cross-tool.** Cursor loads skills from `~/.agents/skills/`,
  `~/.claude/skills/` *and* `~/.codex/skills/`. So does Zed. A user's skills
  already work everywhere with no product involved — and there are open feature
  requests asking to load *fewer* skills, not more.

What is genuinely unserved:

| Surface | State | Value |
|---|---|---|
| Skills | already cross-tool via `~/.agents/skills/` | low — solved |
| Rules / instructions | converging on `AGENTS.md` | low-medium |
| **Settings, permissions, sandbox** | fragmented, no convergence | **high** |
| **MCP config** | fragmented, secret-bearing | **high** |
| **Hooks** | fragmented, OS-specific | **high** |
| **Cross-device sync** | unsolved everywhere | **high** |
| **Curation** — which skills load in which tool on which device | unserved | **high** |

---

## Architecture

```
  web app  ── writes ──▶  DESIRED state  ──┐
                                            ├──▶ device reconciles, reports back
  device   ── writes ──▶  OBSERVED state ──┘
```

The device is always the executor — it owns the filesystem. The web app only
edits intent. Drift is `desired != observed`, which is also exactly what the
device matrix renders.

### Layering

```
base ──▶ os:<os> ──▶ machine:<deviceId> ──▶ local
```

`local` never leaves the device. It's the escape hatch that makes the other
three safe to share. Layer placement is *enforced*, not advisory: a shell hook
cannot be authored into `base`, because it would silently fail on every Windows
device.

### The adapter model

Each tool implements `ToolAdapter` (`src/core/types.ts`). Two decisions carry
most of the weight:

**`StoreLocation` is a union, not a path.** Windows managed policy is a registry
read; macOS MDM is a plist domain; some settings arrive from a vendor server at
sign-in. A `{ path: string }` model is wrong on day one.

**`plan()` is pure; `apply()` is the only thing that writes.** The web app and
the device must compute byte-identical plans from identical inputs, or
"preview before apply" is theatre. Plan ids are content fingerprints, and
approvals bind to them.

### Sub-file addressing

A file is the wrong unit of sync. Zed puts `context_servers` (MCP) and
`buffer_font_size` in one `settings.json` as peer keys — a per-file `syncable`
flag has no correct value. So descriptors carry a `subtree`:

```
agent              concept=agent    syncable=true
context_servers    concept=mcp      syncable=true
theme              concept=editor   syncable=false
buffer_font_size   concept=editor   syncable=false
(remainder)        concept=other    syncable=false
```

Descriptors sharing a `fileId` **must** be coalesced by `apply()` into one
atomic read-modify-write. This also cleanly expresses Claude Code's
`~/.claude.json`, where `mcpServers` is syncable but `oauthAccount`, `machineID`
and `projects` are not.

---

## Security model

This product writes to developer machines, and those machines hold source, cloud
credentials, and production access. Seven controls, each with tests.

### 1. The backend cannot execute code on your devices

Hooks are shell commands. MCP servers are `command` + `args`. `env` feeds both.
A naive "web app pushes config to devices" design means whoever controls the
backend gets RCE on every customer's laptop.

So desired state is **signed by a key the user holds**. The backend stores and
relays; it cannot mint. Devices pin the key at pairing and reject anything else.
Code-execution-class changes need explicit per-item approval carried *inside*
the signature — the web app collecting approvals is a convenience, the device
not trusting it is the control.

A full backend breach degrades to denial of service, not RCE.

### 2. Secrets are end-to-end encrypted

```
passphrase ──Argon2id──▶ root key ──wraps──▶ DEK ──AES-256-GCM──▶ secrets
                                        │
                                        ├──sealed to──▶ device X25519 pubkey
                                        └──sealed to──▶ recovery code
```

Config stays plaintext (you can't diff what you can't read); secret *values* are
sealed and referenced symbolically as `${secret:github.token}`. `ServerVaultRecord`
is written as a type so the boundary is reviewable — if a field that could carry
plaintext appears in it, that should fail review.

Two things the UX must state plainly: losing the passphrase *and* every device
*and* the recovery code means the secrets are gone; and revoking a device
rotates the DEK forward but cannot un-know what that device already decrypted
(rotate at the source too).

### 3. The enumeration floor

`NEVER_ENUMERATE` — `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env` files, private keys,
browser profiles, keychains — is enforced in **every** mode including `full`,
and is not user-editable downward. Verified against: direct request, `..`
traversal, symlink escape, case variants on case-insensitive filesystems,
non-existent paths (fail closed, not open), and a user explicitly adding
`~/.ssh` as a root.

### 4. Secrets cannot leave the device by accident

`never-sync` KeyRules are the precise defence, but they only fire when the
document is the shape the rules were written for — and adapters accept more than
one. The same GitHub token was verified BLOCKED as
`mcpServers.github.env.TOKEN` and classified **portable** as
`stores.<id>.mcpServers.github.env.TOKEN`.

Any defence that depends on the caller passing the right shape is not a defence,
so `core/secret-guard.ts` walks whatever it is given and matches on key name and
value shape. It catches tokens smuggled through `args` arrays, which path-based
rules cannot see at all because `flatten` treats arrays as leaves. Blocked
values are stripped at source and the change is still *reported* — silently
dropping it made `diff` say "already in the desired state", which is safe but
untrue.

`DesiredState` is now a tagged union so the ambiguity that caused this cannot
recur.

### 5. One writer at a time

`apply()` takes an advisory lock across verify → backup → write. Against another
agentsync process the race is closed outright. Against a foreign writer — your
editor, or the tool writing its own settings — a lock is powerless, so the raw
bytes are re-fingerprinted immediately before the write. This narrows the window
from "the whole apply" to "between the check and one syscall"; it cannot reach
zero, because `rename(2)` swaps the inode and no fd we hold prevents that.
Losing the race now aborts instead of silently winning it.

### 6. Provenance gating

Every path table entry declares how it was verified:

- `verified-doc` — confirmed in vendor documentation
- `verified-fs` — confirmed against a real install
- `inferred` — reasoned from convention

**`apply()` refuses to write to `inferred` locations.** What remains inferred is
now a short list rather than a platform: Claude Code's keybindings file, Cursor's
Windows Group Policy registry key (the docs confirm ADMX exists but never print
the key), and Zed's Windows tasks path.

The homedir paths were briefly marked `inferred` on Windows and Linux, which was
wrong — "we have only ever seen this on macOS" is a statement about the author's
travels, not about the path. Anthropic documents `~/.claude/` once for every
platform. Being useless on an unverified platform still beats corrupting it, but
the bar is documentation, not personal acquaintance.

### 7. Detection gating

Provenance answers "do we believe this path is right?" — not "is this tool even
here?". For a table built from vendor docs alone those come apart: a
`verified-doc` path is writable, so on a machine with no Cursor we would happily
create `~/.cursor/mcp.json`, configuring software that does not exist at a
location nothing has confirmed.

So `apply()` also refuses when `detect()` reports the tool absent. This beats
tightening provenance because it self-heals — the moment a real install exists,
its real paths are confirmed by the same probe that gates the write. "Installed
but no config yet" is explicitly still allowed to create a first file.

## What refuses a write

`agentsync doctor` names whichever of these is binding:

| Reason | Clears when |
|---|---|
| adapter cannot apply | the adapter implements it |
| tool not installed | you install the tool |
| path provenance `inferred` | CI confirms it on that OS |
| managed by org policy | never — policy wins by design |
| value looks secret | you move it to the keychain |

---

## Cross-platform

The all-platforms claim is only true if it's tested on all platforms.
`.github/workflows/conformance.yml` runs the suite on macOS, Linux (with *and*
without a keyring), Windows (Developer Mode on *and* off), and WSL.

The cases that matter, because fakes cannot prove them:

- `rename()` over a file held by an exclusive lock, with Defender active
- **deleting a Windows junction must not delete its target** (data-loss class)
- headless Linux secret backend must not *hang* — every devcontainer hits this
- `MAX_PATH` behavior vs. the long-paths probe

Other cross-platform hazards handled: CRLF/LF (canonical hashing, `.gitattributes`),
case collisions, Windows reserved names (`CON`, `NUL`, `AUX`…), exec-bit loss on
round trips, and symlink-vs-junction-vs-copy materialization.

---

## Layout

```
src/core/        types · reconcile · apply-engine · control-plane · vault
                 enumeration · concepts
src/adapters/    claude-code · cursor · zed
src/platform/    host · atomic · links · secrets · paths · canonical
src/cli/         (in progress)
web/             React control plane — device matrix, plan preview,
                 layer editor, permissions editor
docs/            adapter-fit.md · zed-spike.md
```

---

## What works today

- Read, plan, and validate for Claude Code, Cursor, Zed
- **`apply()` for Claude Code** — atomic, staleness-checked, all-or-nothing,
  with rollback. Verified end-to-end against a real `~/.claude/settings.json`.
- **Comment-preserving writes.** A JSONC file keeps its comments, blank lines,
  key order and trailing commas; only the changed value spans move.
- **A CLI**: `init`, `status`, `diff`, `apply`, `rollback`, `doctor`, `devices`
  — meaningful exit codes, `--json` everywhere, `NO_COLOR` respected.
- **Sub-file addressing.** Zed's `context_servers` syncs without dragging
  `buffer_font_size`; descriptors sharing a file coalesce into one atomic write.
- Layering with enforced portability classes and per-key merge semantics
- Platform primitives: atomic writes with Windows retry, backup/restore,
  symlink/junction/copy, four secret backends, path validation

## What doesn't

- No backend exists; the web app runs against typed mocks
- Nothing syncs between machines yet — the vault is real and tested, the
  control plane is still a typed contract with no server behind it
- The web app predates `concept` / `subtree` / `activeWhen`, so it cannot yet
  group rows across tools or warn that writing `.rules` disables `CLAUDE.md`

---

## A note on testing

Three real bugs were found by writing tests for code that already "worked":

1. **`flatten()` was blind to array-rooted documents**, so array-rooted config
   (Zed's `tasks.json` — a list of shell commands) produced *zero changes and
   reported success*.
2. **Rules didn't govern their own subtrees.** `flatten()` yields leaf paths, so
   `oauthAccount` became `oauthAccount.emailAddress`, which the rule
   `match: 'oauthAccount'` didn't match — it fell through to the `**` catch-all
   and account identity was classified **portable**. Every `never-sync` rule on
   an object-valued key was silently inert.
3. **`*Cache` lost to `**`** in rule specificity scoring, because the tiebreaker
   rewarded consuming more of the path and `**` always consumes all of it.

All three were silent-wrong-answer bugs in the most load-bearing file in the
project, which had no direct tests. That was the actual gap.
