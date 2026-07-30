/**
 * `agentsync doctor` — the support-burden killer.
 *
 * Design rule: every line answers a question a user or a support engineer would
 * otherwise have to ask, and anything that is wrong comes with the thing to do
 * about it. A diagnostic that says "symlinks: false" and stops has moved the
 * work rather than done it; this one says "false — Windows without Developer
 * Mode; skills will be materialised as copies; enable Developer Mode or run
 * elevated to get links."
 *
 * It is also the one command that must never fail. A host so broken that
 * detection throws is exactly when someone runs `doctor`, so every probe is
 * individually caught and reported as a finding instead of an exception.
 */

import { join } from 'node:path'

import type { HostEnv } from '../../core/types.js'
import { NoSecretBackendError, type BackendProbe } from '../../platform/secrets.js'
import { APP_DIR_NAME } from '../../platform/host.js'
import type { CommandSpec } from '../args.js'
import { boolFlag } from '../args.js'
import type { Ctx } from '../context.js'
import { EXIT } from '../exit.js'
import { probeTool, type ToolProbe } from '../planner.js'
import { readState } from '../state.js'
import { provenanceLabel, shortPath, table } from '../render.js'
import { detectHostOrExplain, stateDirFor } from './common.js'

export const doctorSpec: CommandSpec = {
  name: 'doctor',
  summary: 'Full diagnostics: host, capabilities, secret backend, per-store provenance, blockers.',
  usage: 'agentsync doctor [--stores] [--json]',
  description:
    'Run this first when anything is surprising. Every finding carries a remedy, and nothing here ' +
    'writes to a tool\'s config.',
  flags: {
    stores: { type: 'boolean', description: 'List every store for every tool, not just a summary.' },
  },
  examples: ['agentsync doctor', 'agentsync doctor --stores', 'agentsync doctor --json'],
  exitNotes: [
    '1 — something is broken and will stop agentsync working',
    '4 — nothing is broken, but every write target on this OS has an unverified path',
  ],
}

type Severity = 'blocker' | 'warning' | 'note'

interface Finding {
  severity: Severity
  area: string
  message: string
  remedy: string
}

export async function doctorCommand(ctx: Ctx): Promise<number> {
  const s = ctx.style
  const findings: Finding[] = []

  // ---- host ---------------------------------------------------------------
  let host: HostEnv
  try {
    host = await detectHostOrExplain(ctx)
  } catch (err) {
    // Detection itself failing is the one case doctor cannot work around, but
    // it can still say what it was trying to do.
    ctx.err(s.red(`${ctx.sym.fail} host detection failed: ${(err as Error).message}`))
    if (ctx.json) {
      ctx.emit({ ok: false, command: 'doctor', exitCode: EXIT.ERROR, error: { message: (err as Error).message } })
    }
    return EXIT.ERROR
  }

  const stateDir = stateDirFor(ctx, host)

  // ---- state directory ----------------------------------------------------
  let stateDirWritable = true
  let stateDirError: string | undefined
  try {
    await ctx.deps.fs.mkdirp(stateDir)
  } catch (err) {
    stateDirWritable = false
    stateDirError = (err as Error).message
    findings.push({
      severity: 'blocker',
      area: 'state',
      message: `The state directory ${stateDir} is not writable: ${stateDirError}`,
      remedy: 'Set AGENTSYNC_STATE_DIR to a directory you can write, or fix the permissions on that path.',
    })
  }
  const state = await readState(ctx.deps.fs, stateDir)
  if (state.problem) {
    findings.push({
      severity: 'warning',
      area: 'state',
      message: state.problem,
      remedy: 'Move that file aside and re-run `agentsync init`; nothing else depends on it.',
    })
  }

  // ---- capabilities -------------------------------------------------------
  if (!host.supportsSymlinks) {
    findings.push({
      severity: 'warning',
      area: 'filesystem',
      message: 'Symlinks are not available on this volume, so skills and agents are materialised as copies.',
      remedy:
        host.os === 'windows'
          ? 'Enable Developer Mode (Settings > Privacy & security > For developers), or run elevated. Junctions are used as a fallback for directories.'
          : 'Common on exFAT/CIFS/network mounts. Move your home to a filesystem that supports links, or accept copies.',
    })
  }
  if (host.os === 'windows' && !host.supportsLongPaths) {
    findings.push({
      severity: 'warning',
      area: 'filesystem',
      message: 'Long path support is off, so nested skill directories can exceed MAX_PATH (260 chars).',
      remedy:
        'Set HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled to 1 and reboot, or keep your config tree shallow.',
    })
  }
  if (!host.hasKeyring) {
    findings.push({
      severity: 'note',
      area: 'secrets',
      message: 'No OS keyring is reachable, so secrets fall back to an encrypted file.',
      remedy:
        host.os === 'linux'
          ? 'Headless Linux and WSL usually have no Secret Service. Set AGENTSYNC_VAULT_PASSPHRASE to enable the encrypted-file vault.'
          : 'Set AGENTSYNC_VAULT_PASSPHRASE to enable the encrypted-file vault.',
    })
  }

  // ---- secret backend -----------------------------------------------------
  const secrets = await probeSecretBackend(ctx, host, stateDir)
  if (secrets.chosen === null) {
    findings.push({
      severity: 'blocker',
      area: 'secrets',
      message: 'No usable secret backend. Any config referencing ${secret:...} cannot be applied.',
      remedy: 'Set AGENTSYNC_VAULT_PASSPHRASE to enable the encrypted-file fallback, or fix the OS keyring.',
    })
  } else if (secrets.degraded) {
    findings.push({
      severity: 'warning',
      area: 'secrets',
      message: `Fell back to "${secrets.chosen}" instead of this platform's preferred backend.`,
      remedy: 'Usually fine, but the vault is then protected by your passphrase rather than by the OS session.',
    })
  }

  // ---- tools and stores ---------------------------------------------------
  // `read: true` on purpose. Every other command probes for existence only,
  // but "your ~/.claude.json is not valid JSON" is precisely the class of
  // problem people run `doctor` to find, and it is invisible without parsing.
  const probes: ToolProbe[] = []
  for (const adapter of ctx.deps.adapters) {
    probes.push(await probeTool(adapter, host, ctx.deps.fs, ctx.cwd, { read: true }))
  }

  for (const probe of probes) {
    if (probe.error) {
      findings.push({
        severity: 'warning',
        area: probe.adapter.id,
        message: `detect() failed: ${probe.error}`,
        remedy: 'This tool will be reported as absent. Re-run with --verbose, and check filesystem permissions.',
      })
    }
    // Two more reasons a write gets refused. Both are legitimate states rather
    // than faults, so they are informational — but silence here means the user
    // discovers them by running `apply` and watching everything skip.
    if (!probe.adapter.capabilities.apply) {
      findings.push({
        severity: 'note',
        area: probe.adapter.id,
        message: `${probe.adapter.displayName} can be read and diffed, but not written by this build.`,
        remedy: probe.adapter.capabilities.reason ?? 'No reason given by the adapter.',
      })
    } else if (!probe.detection.installed) {
      findings.push({
        severity: 'note',
        area: probe.adapter.id,
        message: `${probe.adapter.displayName} is not installed here, so \`apply\` will refuse to write its config.`,
        remedy:
          'Deliberate: its paths come from vendor documentation and have never been confirmed against a ' +
          'real install, so writing would create files for software that is not here. Install the tool and this clears.',
      })
    }

    // Say when "installed" rests only on a file we can write ourselves. It is
    // still treated as installed, but presenting a guess as a fact is how a
    // stale leftover ends up silently gating writes.
    if (probe.detection.installed && probe.detection.confidence === 'weak') {
      findings.push({
        severity: 'note',
        area: probe.adapter.id,
        message: `${probe.adapter.displayName} was detected only from config files that agentsync can also write.`,
        remedy:
          'Suggestive but not independent — a file left behind by a previous install would look the same. ' +
          'Harmless unless you have uninstalled the tool and expect writes to stop.',
      })
    }

    if (!probe.detection.installed) continue

    const writeTargets = probe.stores.filter((p) => p.store.writable && p.store.syncable)
    const inferred = writeTargets.filter((p) => p.store.provenance === 'inferred')
    if (writeTargets.length > 0 && inferred.length === writeTargets.length) {
      findings.push({
        severity: 'blocker',
        area: probe.adapter.id,
        message: `Every write target for ${probe.adapter.displayName} on ${host.os}${host.runtime === 'wsl' ? '/wsl' : ''} has provenance "inferred", so \`apply\` will refuse all of them.`,
        remedy:
          'This is deliberate: writing to a path we reasoned from convention could corrupt an unrelated file. ' +
          'The cross-OS conformance job promotes these to verified. Reads, diffs and status all work today.',
      })
    } else if (inferred.length > 0) {
      findings.push({
        severity: 'warning',
        area: probe.adapter.id,
        message: `${inferred.length} of ${writeTargets.length} write targets are unverified on this OS and will be skipped by \`apply\`.`,
        remedy: `Affected: ${inferred.map((p) => p.store.id).join(', ')}`,
      })
    }

    for (const p of probe.stores) {
      if (p.error) {
        findings.push({
          severity: 'blocker',
          area: probe.adapter.id,
          message: `${p.store.id} could not be read: ${p.error}`,
          remedy: `Fix ${p.location} by hand — agentsync will not rewrite a file it cannot parse.`,
        })
      }
    }
  }

  // ---- verdict ------------------------------------------------------------
  const blockers = findings.filter((f) => f.severity === 'blocker')
  const provenanceOnly =
    blockers.length > 0 && blockers.every((f) => f.message.includes('provenance "inferred"'))
  const code = blockers.length === 0 ? EXIT.OK : provenanceOnly ? EXIT.BLOCKED_BY_PROVENANCE : EXIT.ERROR

  if (ctx.json) {
    ctx.emit({
      ok: blockers.length === 0,
      command: 'doctor',
      exitCode: code,
      version: ctx.deps.version,
      node: ctx.deps.nodeVersion,
      host: {
        os: host.os,
        runtime: host.runtime,
        arch: host.arch,
        home: host.home,
        shell: host.shell,
        deviceId: host.deviceId,
        supportsSymlinks: host.supportsSymlinks,
        supportsLongPaths: host.supportsLongPaths,
        hasKeyring: host.hasKeyring,
        appData: host.appData ?? null,
        localAppData: host.localAppData ?? null,
        programFiles: host.programFiles ?? null,
      },
      state: { dir: stateDir, writable: stateDirWritable, initialised: state.value !== null, error: stateDirError ?? null },
      terminal: {
        stdoutIsTTY: ctx.deps.io.stdoutIsTTY,
        stderrIsTTY: ctx.deps.io.stderrIsTTY,
        stdinIsTTY: ctx.deps.io.stdinIsTTY,
        color: ctx.color,
        unicode: ctx.unicode,
      },
      environment: environmentJson(ctx.deps.env),
      secrets,
      tools: probes.map((p) => ({
        toolId: p.adapter.id,
        installed: p.detection.installed,
        version: p.detection.version ?? null,
        detectError: p.error ?? null,
        stores: p.stores.map((sp) => ({
          id: sp.store.id,
          scope: sp.store.scope,
          kind: sp.store.location.kind,
          location: sp.location,
          exists: sp.exists,
          writable: sp.store.writable,
          syncable: sp.store.syncable,
          provenance: sp.store.provenance,
          writeBlocked: sp.store.writable && sp.store.provenance === 'inferred',
          notProbed: sp.notProbed ?? null,
          error: sp.error ?? null,
        })),
      })),
      findings,
    })
    return code
  }

  // ---- human report -------------------------------------------------------
  ctx.out()
  ctx.out(s.bold(`agentsync doctor`) + s.gray(`  v${ctx.deps.version} on node ${ctx.deps.nodeVersion}`))
  ctx.out()

  section(ctx, 'Host')
  row(ctx, 'os', `${host.os}${host.runtime === 'wsl' ? s.yellow('  (WSL — Linux userland reached through Windows)') : ''}`)
  row(ctx, 'runtime', host.runtime)
  row(ctx, 'arch', host.arch)
  row(ctx, 'shell', host.shell)
  row(ctx, 'home', host.home)
  row(ctx, 'device id', host.deviceId)
  if (host.runtime === 'wsl' || host.os === 'windows') {
    row(ctx, 'APPDATA', host.appData ?? s.gray('(not exposed)'))
    row(ctx, 'LOCALAPPDATA', host.localAppData ?? s.gray('(not exposed)'))
    row(ctx, 'ProgramFiles', host.programFiles ?? s.gray('(not exposed)'))
    if (host.runtime === 'wsl' && !host.appData) {
      ctx.out(
        `      ${s.gray('WSL interop is not exposing the Windows environment, so the Windows-side install cannot be seen from here.')}`,
      )
    }
  }
  ctx.out()

  section(ctx, 'Capabilities')
  row(ctx, 'symlinks', yesNo(ctx, host.supportsSymlinks) + s.gray('  (probed by creating a real link in the state dir)'))
  row(
    ctx,
    'long paths',
    host.os === 'windows'
      ? yesNo(ctx, host.supportsLongPaths) + s.gray('  (HKLM ... FileSystem\\LongPathsEnabled)')
      : yesNo(ctx, true) + s.gray('  (no MAX_PATH limit on this OS)'),
  )
  row(ctx, 'os keyring', yesNo(ctx, host.hasKeyring))
  ctx.out()

  section(ctx, 'State')
  row(ctx, 'directory', shortPath(stateDir, host.home))
  row(ctx, 'writable', yesNo(ctx, stateDirWritable) + (stateDirError ? s.red(`  ${stateDirError}`) : ''))
  row(ctx, 'initialised', yesNo(ctx, state.value !== null) + (state.value ? '' : s.gray('  run `agentsync init`')))
  row(ctx, 'devices known', String(state.value?.devices.length ?? 0))
  ctx.out()

  section(ctx, 'Secret backend')
  if (secrets.chosen === null) {
    row(ctx, 'chosen', s.red('none'))
  } else {
    row(ctx, 'chosen', `${s.green(secrets.chosen)}${secrets.degraded ? s.yellow('  (degraded)') : ''}`)
    row(ctx, 'description', secrets.description ?? '')
  }
  ctx.out(`      ${s.gray('considered, in preference order:')}`)
  for (const a of secrets.attempted) {
    const mark = a.available ? s.green(ctx.sym.ok) : s.gray(ctx.sym.bullet)
    ctx.out(`      ${mark} ${a.backend}${a.reason ? s.gray(`  — ${a.reason}`) : ''}`)
  }
  ctx.out()

  section(ctx, 'Terminal')
  row(ctx, 'stdout', ctx.deps.io.stdoutIsTTY ? 'tty' : s.gray('pipe or file'))
  row(ctx, 'stderr', ctx.deps.io.stderrIsTTY ? 'tty' : s.gray('pipe or file'))
  row(ctx, 'stdin', ctx.deps.io.stdinIsTTY ? 'tty' : s.gray('not interactive — apply cannot prompt, use --yes'))
  row(ctx, 'colour', `${ctx.color.enabled ? 'on' : 'off'} ${s.gray(`(${ctx.color.reason})`)}`)
  row(ctx, 'glyphs', `${ctx.unicode.enabled ? 'unicode' : 'ascii'} ${s.gray(`(${ctx.unicode.reason})`)}`)
  ctx.out()

  const envRows = Object.entries(environmentJson(ctx.deps.env)).filter(([, v]) => v !== null)
  if (envRows.length > 0) {
    section(ctx, 'Environment overrides in effect')
    for (const [k, v] of envRows) row(ctx, k, String(v))
    ctx.out()
  }

  section(ctx, 'Tools')
  const toolRows = probes.map((p) => {
    const writeTargets = p.stores.filter((x) => x.store.writable && x.store.syncable)
    const inferred = writeTargets.filter((x) => x.store.provenance === 'inferred').length
    return [
      p.detection.installed ? s.green(ctx.sym.ok) : s.gray(ctx.sym.bullet),
      p.adapter.displayName,
      p.detection.installed ? (p.detection.version ?? s.gray('—')) : s.gray('not installed'),
      `${p.stores.filter((x) => x.exists).length}/${p.stores.length}`,
      // Three separate reasons a write can be refused, and a user who only sees
      // one of them will be baffled by the other two. Report the binding one.
      !p.adapter.capabilities.apply
        ? s.gray('cannot apply yet')
        : !p.detection.installed
          ? s.gray('tool not installed')
          : inferred > 0
            ? s.yellow(`${inferred}/${writeTargets.length} unverified`)
            : s.green('ok'),
    ]
  })
  for (const line of table(
    ctx,
    [{ header: '' }, { header: 'TOOL' }, { header: 'VERSION' }, { header: 'STORES' }, { header: 'WRITE' }],
    toolRows,
  )) {
    ctx.out(line)
  }
  ctx.out()

  if (boolFlag(ctx.args, 'stores')) {
    for (const p of probes) {
      section(ctx, `${p.adapter.displayName} stores`)
      const rows = p.stores.map((sp) => [
        sp.exists ? s.green(ctx.sym.ok) : sp.notProbed ? s.gray('?') : s.gray(ctx.sym.bullet),
        sp.store.id,
        sp.store.scope,
        sp.store.location.kind,
        provenanceLabel(ctx, sp.store),
        sp.store.writable ? (sp.store.provenance === 'inferred' ? s.yellow('blocked') : s.green('writable')) : s.gray('read-only'),
        s.gray(shortPath(sp.location, host.home)),
      ])
      for (const line of table(
        ctx,
        [
          { header: '' },
          { header: 'STORE' },
          { header: 'SCOPE' },
          { header: 'KIND' },
          { header: 'PROVENANCE' },
          { header: 'WRITE' },
          { header: 'LOCATION' },
        ],
        rows,
      )) {
        ctx.out(line)
      }
      ctx.out()
    }
  } else {
    ctx.note(`  ${s.gray('`agentsync doctor --stores` lists every store and its provenance.')}`)
    ctx.note()
  }

  section(ctx, 'Findings')
  if (findings.length === 0) {
    ctx.out(`  ${s.green(ctx.sym.ok)} Nothing to report. This host is fully supported.`)
  } else {
    for (const f of findings) {
      const badge =
        f.severity === 'blocker'
          ? s.red(`${ctx.sym.fail} BLOCKER`)
          : f.severity === 'warning'
            ? s.yellow(`${ctx.sym.warn} warning`)
            : s.gray(`${ctx.sym.info} note`);
      ctx.out(`  ${badge} ${s.gray(`[${f.area}]`)} ${f.message}`)
      ctx.out(`      ${s.gray(ctx.sym.arrow)} ${f.remedy}`)
      ctx.out()
    }
  }

  const verdict =
    code === EXIT.OK
      ? s.green(`${ctx.sym.ok} healthy`)
      : code === EXIT.BLOCKED_BY_PROVENANCE
        ? s.yellow(`${ctx.sym.warn} read-only on this platform — writes are blocked by unverified paths`)
        : s.red(`${ctx.sym.fail} ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`)
  ctx.out(`  ${s.bold('Verdict')}  ${verdict}  ${s.gray(`(exit ${code})`)}`)
  ctx.out()

  return code
}

// ---------------------------------------------------------------------------

interface SecretReport {
  chosen: string | null
  description: string | null
  degraded: boolean
  attempted: BackendProbe[]
  error: string | null
}

async function probeSecretBackend(ctx: Ctx, host: HostEnv, stateDir: string): Promise<SecretReport> {
  const passphrase = ctx.deps.env['AGENTSYNC_VAULT_PASSPHRASE']
  const forced = ctx.deps.env['AGENTSYNC_SECRET_BACKEND']
  try {
    const selection = await ctx.deps.selectSecretStore(host, {
      service: APP_DIR_NAME,
      vaultFile: join(stateDir, 'secrets.vault.json'),
      dpapiDir: join(stateDir, 'secrets'),
      ...(passphrase !== undefined ? { passphrase } : {}),
      ...(forced !== undefined ? { force: forced as never } : {}),
    })
    return {
      chosen: selection.chosen,
      description: selection.store.description,
      degraded: selection.degraded,
      attempted: selection.attempted,
      error: null,
    }
  } catch (err) {
    if (err instanceof NoSecretBackendError) {
      return { chosen: null, description: null, degraded: true, attempted: err.attempted, error: err.message }
    }
    return { chosen: null, description: null, degraded: true, attempted: [], error: (err as Error).message }
  }
}

/** Only names and presence. A passphrase is never printed, ever. */
function environmentJson(env: NodeJS.ProcessEnv): Record<string, string | null> {
  const present = (name: string) => (env[name] !== undefined && env[name] !== '' ? 'set (value hidden)' : null)
  const literal = (name: string) => (env[name] !== undefined && env[name] !== '' ? (env[name] as string) : null)
  return {
    AGENTSYNC_STATE_DIR: literal('AGENTSYNC_STATE_DIR'),
    AGENTSYNC_DEVICE_ID: present('AGENTSYNC_DEVICE_ID'),
    AGENTSYNC_ASSUME_SYMLINKS: literal('AGENTSYNC_ASSUME_SYMLINKS'),
    AGENTSYNC_SECRET_BACKEND: literal('AGENTSYNC_SECRET_BACKEND'),
    AGENTSYNC_VAULT_PASSPHRASE: present('AGENTSYNC_VAULT_PASSPHRASE'),
    AGENTSYNC_ASCII: literal('AGENTSYNC_ASCII'),
    XDG_STATE_HOME: literal('XDG_STATE_HOME'),
    NO_COLOR: literal('NO_COLOR'),
    FORCE_COLOR: literal('FORCE_COLOR'),
    WSL_DISTRO_NAME: literal('WSL_DISTRO_NAME'),
  }
}

function section(ctx: Ctx, title: string): void {
  ctx.out(ctx.style.bold(title))
}

function row(ctx: Ctx, label: string, value: string): void {
  ctx.out(`  ${ctx.style.gray(label.padEnd(15))} ${value}`)
}

function yesNo(ctx: Ctx, value: boolean): string {
  return value ? ctx.style.green('yes') : ctx.style.yellow('no')
}
