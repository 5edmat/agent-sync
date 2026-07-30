/**
 * Host detection.
 *
 * Every field in `HostEnv` that *can* be wrong if guessed is probed instead:
 *
 *  - WSL is not `process.platform === 'linux'` plus a hunch. It is a string in
 *    `/proc/version`. A WSL host writes Linux-shaped config but must also see
 *    the Windows side, and its symlink/keyring behavior matches neither.
 *  - `supportsSymlinks` is *not* derived from the OS. Windows with Developer
 *    Mode on supports them; Windows without it does not; a Linux box on a
 *    CIFS/exFAT mount does not either. So we create a real symlink in the real
 *    state directory and see what happens.
 *  - `hasKeyring` is false on headless Linux even though `secret-tool` may be
 *    installed, because there is no session bus for it to talk to.
 *  - `deviceId` is persisted, never derived. Hostname-derived IDs re-register
 *    the machine as new the day someone renames their laptop, and collide
 *    across the seventeen VMs all named `ubuntu`.
 *
 * The pure functions are exported individually so the Windows/Linux branches
 * are unit-testable from macOS with fixtures.
 */

import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostEnv, OS, Runtime } from '../core/types.js'
import { atomicWriteFile, errnoCode } from './atomic.js'
import { nodeExec, type ExecFn } from './secrets.js'

export const APP_DIR_NAME = 'agentsync'

type Shell = HostEnv['shell']
type Arch = HostEnv['arch']

// ---------------------------------------------------------------------------
// Pure detection helpers
// ---------------------------------------------------------------------------

export function normalizeOS(platform: NodeJS.Platform): OS {
  switch (platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      // FreeBSD/AIX behave like Linux for our purposes (POSIX paths, XDG).
      // Better to work with slightly wrong labels than to refuse to start.
      return 'linux'
  }
}

export function normalizeArch(arch: string): Arch {
  switch (arch) {
    case 'arm64':
    case 'aarch64':
      return 'arm64'
    case 'x64':
    case 'x86_64':
      return 'x64'
    default:
      // `HostEnv['arch']` is a closed union; ia32/armv7 hosts are not targets
      // but must not crash detection.
      return 'x64'
  }
}

/**
 * The WSL tell. Both WSL1 and WSL2 put a vendor string in `/proc/version`:
 *
 *   WSL1: "... #1-Microsoft Mon Sep 09 ..."
 *   WSL2: "... microsoft-standard-WSL2 ..."
 *
 * Case differs between the two, which is exactly the bug a naive
 * `includes('Microsoft')` ships with.
 */
export function isWslProcVersion(procVersion: string | null): boolean {
  if (!procVersion) return false
  return /microsoft|wsl/i.test(procVersion)
}

export function detectRuntime(osName: OS, procVersion: string | null, env: NodeJS.ProcessEnv): Runtime {
  if (osName !== 'linux') return 'native'
  // WSL_DISTRO_NAME / WSL_INTEROP are set by the WSL init; they are a cheap
  // confirmation but are absent inside some containers under WSL, so
  // /proc/version stays authoritative.
  if (env['WSL_DISTRO_NAME'] || env['WSL_INTEROP']) return 'wsl'
  return isWslProcVersion(procVersion) ? 'wsl' : 'native'
}

export function detectShell(osName: OS, env: NodeJS.ProcessEnv): Shell {
  if (osName === 'windows') return 'powershell'
  const shellPath = env['SHELL']
  if (shellPath) {
    const base = shellPath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (base.includes('zsh')) return 'zsh'
    if (base.includes('fish')) return 'fish'
    if (base.includes('bash')) return 'bash'
  }
  // macOS has defaulted to zsh since Catalina; Linux to bash.
  return osName === 'macos' ? 'zsh' : 'bash'
}

/**
 * Windows environment variables are case-insensitive. Node exposes
 * `process.env` with a case-insensitive proxy on win32 but a plain object
 * everywhere else — including when we are *testing* Windows behavior from
 * macOS, or reading a Windows env captured through WSL interop. Look them up
 * case-insensitively ourselves.
 */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) {
      const v = env[key]
      if (v !== undefined) return v
    }
  }
  return undefined
}

export interface WindowsDirs {
  appData?: string
  localAppData?: string
  programFiles?: string
}

/**
 * `%APPDATA%` / `%LOCALAPPDATA%` / `%ProgramFiles%`.
 *
 * Fallbacks matter: these are unset when Node runs as a Windows *service*, or
 * under some CI runners, and a tool that assumes they exist writes config to
 * `undefined\Claude\settings.json`.
 */
export function windowsDirs(env: NodeJS.ProcessEnv, home: string): WindowsDirs {
  const appData = envGet(env, 'APPDATA') ?? path.win32.join(home, 'AppData', 'Roaming')
  const localAppData = envGet(env, 'LOCALAPPDATA') ?? path.win32.join(home, 'AppData', 'Local')
  const programFiles =
    envGet(env, 'ProgramFiles') ?? envGet(env, 'ProgramW6432') ?? 'C:\\Program Files'
  return { appData, localAppData, programFiles }
}

/**
 * Parse `reg query ... /v LongPathsEnabled`, whose output is:
 *
 *     HKEY_LOCAL_MACHINE\SYSTEM\...\FileSystem
 *         LongPathsEnabled    REG_DWORD    0x1
 */
export function parseLongPathsRegQuery(stdout: string): boolean {
  const m = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout)
  if (!m || m[1] === undefined) return false
  return Number.parseInt(m[1], 16) !== 0
}

export interface LinuxKeyringInputs {
  hasSecretTool: boolean
  env: NodeJS.ProcessEnv
  /** `/run/user/<uid>/bus` exists (systemd user session). */
  hasUserBusSocket: boolean
}

/**
 * A keyring on Linux needs *both* the client tool and something for it to talk
 * to. A CI container frequently has `secret-tool` installed as a transitive
 * dependency and no bus at all; calling it there blocks until the timeout.
 */
export function linuxKeyringAvailable(inputs: LinuxKeyringInputs): boolean {
  if (!inputs.hasSecretTool) return false
  const { env } = inputs
  const hasBus =
    Boolean(env['DBUS_SESSION_BUS_ADDRESS']) || inputs.hasUserBusSocket
  if (!hasBus) return false
  // A session bus with no graphical/keyring session behind it (bare SSH with
  // lingering enabled) still fails, but at that point only a real probe can
  // tell, and `selectSecretStore` will fall back when the probe fails.
  return true
}

/** Per-OS state directory for our own data (device id, vault, backups). */
export function stateDir(osName: OS, env: NodeJS.ProcessEnv, home: string): string {
  const override = envGet(env, 'AGENTSYNC_STATE_DIR')
  if (override) return override

  switch (osName) {
    case 'windows': {
      const local = envGet(env, 'LOCALAPPDATA') ?? path.win32.join(home, 'AppData', 'Local')
      return path.win32.join(local, APP_DIR_NAME)
    }
    case 'macos':
      return path.posix.join(home, 'Library', 'Application Support', APP_DIR_NAME)
    case 'linux':
    default: {
      // XDG_STATE_HOME is the correct base for "state that persists but is not
      // config" — device id and backups are exactly that.
      const xdg = envGet(env, 'XDG_STATE_HOME')
      const base = xdg && xdg.length > 0 ? xdg : path.posix.join(home, '.local', 'state')
      return path.posix.join(base, APP_DIR_NAME)
    }
  }
}

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_RE.test(value)
}

// ---------------------------------------------------------------------------
// Injectable IO surface
// ---------------------------------------------------------------------------

export interface HostIO {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  homedir(): string
  tmpdir(): string
  /** Returns null on ENOENT rather than throwing. */
  readTextFile(p: string): Promise<string | null>
  writeTextFile(p: string, contents: string, mode?: number): Promise<void>
  mkdirp(p: string): Promise<void>
  pathExists(p: string): Promise<boolean>
  /** Create a symlink; used by the probe. */
  symlink(target: string, linkPath: string, type?: 'file' | 'dir' | 'junction'): Promise<void>
  lstatIsSymlink(p: string): Promise<boolean>
  readlink(p: string): Promise<string>
  remove(p: string): Promise<void>
  exec: ExecFn
  /** Is `command` resolvable on PATH? */
  which(command: string): Promise<boolean>
  uuid(): string
  getuid(): number | undefined
}

export const nodeHostIO: HostIO = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  homedir: () => os.homedir(),
  tmpdir: () => os.tmpdir(),
  readTextFile: async (p) => {
    try {
      return await fsp.readFile(p, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'EACCES') return null
      throw err
    }
  },
  writeTextFile: async (p, contents, mode) => {
    await atomicWriteFile(p, contents, mode !== undefined ? { mode } : {})
  },
  mkdirp: async (p) => {
    await fsp.mkdir(p, { recursive: true })
  },
  pathExists: async (p) => {
    try {
      await fsp.stat(p)
      return true
    } catch {
      return false
    }
  },
  symlink: (target, linkPath, type) => fsp.symlink(target, linkPath, type),
  lstatIsSymlink: async (p) => (await fsp.lstat(p)).isSymbolicLink(),
  readlink: (p) => fsp.readlink(p),
  remove: async (p) => {
    await fsp.rm(p, { recursive: true, force: true })
  },
  exec: nodeExec,
  which: async (command) => {
    const isWindows = process.platform === 'win32'
    try {
      const r = isWindows
        ? await nodeExec('where', [command], { timeoutMs: 4000 })
        : await nodeExec('/usr/bin/env', ['sh', '-c', `command -v ${JSON.stringify(command)}`], {
            timeoutMs: 4000,
          })
      return r.code === 0 && r.stdout.trim().length > 0
    } catch {
      return false
    }
  },
  uuid: () => randomUUID(),
  getuid: () => (typeof process.getuid === 'function' ? process.getuid() : undefined),
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export interface SymlinkProbeResult {
  supported: boolean
  /** errno from the failed attempt: EPERM on Windows without Developer Mode. */
  errorCode?: string
}

/**
 * Actually create a symlink and read it back.
 *
 * Probing in the state directory rather than `os.tmpdir()` is deliberate:
 * tmpdir is often a different filesystem (tmpfs, or `C:\` when the user's home
 * is a redirected network drive), and symlink support is a *filesystem*
 * property as much as an OS one. Probing the wrong volume gives the wrong
 * answer for the volume we will actually write to.
 */
export async function probeSymlinkSupport(io: HostIO, dir: string): Promise<SymlinkProbeResult> {
  const suffix = io.uuid().slice(0, 8)
  const probeDir = path.join(dir, `.symlink-probe-${suffix}`)
  const targetPath = path.join(probeDir, 'target')
  const linkPath = path.join(probeDir, 'link')

  try {
    await io.mkdirp(probeDir)
    await io.writeTextFile(targetPath, 'probe')
    await io.symlink('target', linkPath, 'file')
    // Creation succeeding is not enough: on some filesystems the call is a
    // silent no-op or produces a copy. Verify it is really a link.
    const isLink = await io.lstatIsSymlink(linkPath)
    if (!isLink) return { supported: false, errorCode: 'ENOTSUP' }
    const raw = await io.readlink(linkPath)
    return { supported: raw === 'target' || raw.endsWith('target') }
  } catch (err) {
    const code = errnoCode(err)
    return { supported: false, ...(code !== undefined ? { errorCode: code } : {}) }
  } finally {
    await io.remove(probeDir).catch(() => {})
  }
}

/** Windows long-path opt-in, read from the registry. Always true elsewhere. */
export async function probeLongPaths(io: HostIO, osName: OS): Promise<boolean> {
  // POSIX has PATH_MAX 1024/4096 and no MAX_PATH equivalent, so the gate that
  // `supportsLongPaths` controls simply does not apply.
  if (osName !== 'windows') return true
  try {
    const r = await io.exec(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
      { timeoutMs: 5000 },
    )
    if (r.code !== 0) return false
    return parseLongPathsRegQuery(r.stdout)
  } catch {
    return false
  }
}

/** Is an OS keyring reachable *right now*? Never prompts. */
export async function probeKeyring(io: HostIO, osName: OS, runtime: Runtime): Promise<boolean> {
  switch (osName) {
    case 'macos': {
      try {
        const r = await io.exec('/usr/bin/security', ['list-keychains'], { timeoutMs: 5000 })
        return r.code === 0
      } catch {
        return false
      }
    }
    case 'windows':
      return io.which('powershell.exe').then((ok) => ok || io.which('powershell'))
    case 'linux':
    default: {
      const uid = io.getuid()
      const hasUserBusSocket =
        uid !== undefined ? await io.pathExists(`/run/user/${uid}/bus`) : false
      const hasSecretTool = await io.which('secret-tool')
      const available = linuxKeyringAvailable({ hasSecretTool, env: io.env, hasUserBusSocket })
      if (!available) return false
      // WSL: a bus may exist (systemd support landed in WSL) but the Secret
      // Service behind it usually does not. Fall through to the real probe.
      if (runtime === 'wsl') {
        try {
          const r = await io.exec('secret-tool', ['search', '--all', 'service', APP_DIR_NAME], {
            timeoutMs: 3000,
          })
          return r.code === 0 || r.code === 1
        } catch {
          return false
        }
      }
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Device id
// ---------------------------------------------------------------------------

interface DeviceIdFile {
  v: 1
  deviceId: string
  createdAt: string
}

/**
 * Read the persisted device id, creating it on first run.
 *
 * Explicitly NOT derived from hostname, MAC address, or machine-id:
 *  - hostname changes when a user renames their laptop, and every VM in a
 *    fleet is called `ubuntu`
 *  - MACs change with docking stations and VPN adapters
 *  - `/etc/machine-id` is cloned into every VM from a golden image
 *
 * A random UUID written once and read forever has none of those failure modes.
 */
export async function readOrCreateDeviceId(io: HostIO, dir: string): Promise<string> {
  const override = envGet(io.env, 'AGENTSYNC_DEVICE_ID')
  if (isValidDeviceId(override)) return override

  const file = path.join(dir, 'device.json')
  const raw = await io.readTextFile(file)

  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<DeviceIdFile>
      if (isValidDeviceId(parsed.deviceId)) return parsed.deviceId
    } catch {
      // Tolerate an older/hand-written plain-UUID file before regenerating.
      const trimmed = raw.trim()
      if (isValidDeviceId(trimmed)) return trimmed
    }
  }

  const deviceId = io.uuid()
  const payload: DeviceIdFile = { v: 1, deviceId, createdAt: new Date().toISOString() }
  try {
    await io.mkdirp(dir)
    // 0600: the device id is a fleet identifier, not a secret, but it is also
    // nobody else's business on a shared box.
    await io.writeTextFile(file, `${JSON.stringify(payload, null, 2)}\n`, 0o600)
  } catch {
    // A read-only home (locked-down CI) must not stop the CLI. The id is then
    // per-process, which the caller can detect by the id changing between runs.
  }
  return deviceId
}

// ---------------------------------------------------------------------------
// detectHost
// ---------------------------------------------------------------------------

export interface DetectHostOptions {
  io?: HostIO
  /**
   * Skip the symlink/keyring/registry probes and use conservative defaults.
   * For fast paths that only need os/home/arch.
   */
  skipProbes?: boolean
}

/**
 * Full host detection. ~5-15ms warm; the symlink probe is the only write.
 */
export async function detectHost(options: DetectHostOptions = {}): Promise<HostEnv> {
  const io = options.io ?? nodeHostIO
  const env = io.env

  const osName = normalizeOS(io.platform)
  const arch = normalizeArch(io.arch)

  const procVersion = osName === 'linux' ? await io.readTextFile('/proc/version') : null
  const runtime = detectRuntime(osName, procVersion, env)

  // On Windows, USERPROFILE is authoritative; os.homedir() falls back to
  // HOMEDRIVE+HOMEPATH which points at a network share in many AD domains.
  const home =
    osName === 'windows'
      ? (envGet(env, 'USERPROFILE') ?? io.homedir())
      : (envGet(env, 'HOME') ?? io.homedir())

  const dir = stateDir(osName, env, home)

  const shell = detectShell(osName, env)

  let supportsSymlinks: boolean
  let hasKeyring: boolean
  let supportsLongPaths: boolean

  if (options.skipProbes) {
    supportsSymlinks = osName !== 'windows'
    hasKeyring = osName !== 'linux'
    supportsLongPaths = osName !== 'windows'
  } else {
    // Escape hatches for CI and for users on exotic mounts, checked before we
    // pay for the probe.
    const symlinkOverride = envGet(env, 'AGENTSYNC_ASSUME_SYMLINKS')
    if (symlinkOverride !== undefined) {
      supportsSymlinks = symlinkOverride === '1' || symlinkOverride.toLowerCase() === 'true'
    } else {
      await io.mkdirp(dir).catch(() => {})
      let probe = await probeSymlinkSupport(io, dir)
      if (!probe.supported && probe.errorCode === 'ENOENT') {
        // State dir unwritable (locked-down home). Fall back to tmpdir and
        // accept the "wrong volume" caveat rather than reporting a false no.
        probe = await probeSymlinkSupport(io, io.tmpdir())
      }
      supportsSymlinks = probe.supported
    }

    ;[hasKeyring, supportsLongPaths] = await Promise.all([
      probeKeyring(io, osName, runtime),
      probeLongPaths(io, osName),
    ])
  }

  const deviceId = await readOrCreateDeviceId(io, dir)

  const host: HostEnv = {
    os: osName,
    runtime,
    arch,
    home,
    supportsSymlinks,
    hasKeyring,
    supportsLongPaths,
    shell,
    deviceId,
  }

  if (osName === 'windows' || runtime === 'wsl') {
    // WSL can see the Windows side through /mnt/c and needs those paths to
    // read the host's Claude Code / Cursor config. They are only populated
    // when interop actually exposes them.
    const dirs = windowsDirs(env, home)
    if (osName === 'windows') {
      if (dirs.appData !== undefined) host.appData = dirs.appData
      if (dirs.localAppData !== undefined) host.localAppData = dirs.localAppData
      if (dirs.programFiles !== undefined) host.programFiles = dirs.programFiles
    } else {
      // Under WSL only trust real env vars from interop, never the synthesized
      // fallbacks — `C:\Program Files` is meaningless from inside the distro.
      const appData = envGet(env, 'APPDATA')
      const localAppData = envGet(env, 'LOCALAPPDATA')
      const programFiles = envGet(env, 'ProgramFiles')
      if (appData) host.appData = appData
      if (localAppData) host.localAppData = localAppData
      if (programFiles) host.programFiles = programFiles
    }
  }

  return host
}

/** Convenience: the resolved state directory for an already-detected host. */
/**
 * Where this device keeps its own state, with ONE documented precedence:
 *
 *   1. `override`                  — an explicit `--state-dir` flag
 *   2. `AGENTSYNC_STATE_DIR`       — environment, for containers and CI
 *   3. the per-OS default          — Application Support / XDG / LOCALAPPDATA
 *
 * There were two mechanisms with no stated ordering (`hostStateDir` read the
 * env var; `ApplyDeps.stateDirOverride` was checked separately), so every
 * caller had to thread both and hope they agreed. This is the single answer.
 */
export function resolveStateDir(
  host: HostEnv,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return override ?? hostStateDir(host, env)
}

export function hostStateDir(host: HostEnv, env: NodeJS.ProcessEnv = process.env): string {
  return stateDir(host.os, env, host.home)
}
