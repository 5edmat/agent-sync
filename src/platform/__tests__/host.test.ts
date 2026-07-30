import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  APP_DIR_NAME,
  detectHost,
  detectRuntime,
  detectShell,
  envGet,
  isValidDeviceId,
  isWslProcVersion,
  linuxKeyringAvailable,
  nodeHostIO,
  normalizeArch,
  normalizeOS,
  parseLongPathsRegQuery,
  probeKeyring,
  probeLongPaths,
  probeSymlinkSupport,
  readOrCreateDeviceId,
  stateDir,
  windowsDirs,
  type HostIO,
} from '../host.js'
import type { ExecFn, ExecResult } from '../secrets.js'

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-test-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

/**
 * Fixture paths in the *running host's* flavour.
 *
 * `probeSymlinkSupport` and `readOrCreateDeviceId` build their paths with
 * `node:path` — correctly, because both act on the filesystem of the machine
 * actually executing, not on a described remote host. So on Windows they look
 * for `\state\device.json`. A fixture that hardcodes `/state/device.json` is
 * simply a different key: the lookup misses in the fake fs, the code decides no
 * device id has been persisted yet, and it mints a fresh UUID. That is the test
 * encoding a macOS assumption, not the product misbehaving — so build fixtures
 * the same way the product does.
 */
const STATE_DIR = path.join(path.sep, 'state')
const DEVICE_FILE = path.join(STATE_DIR, 'device.json')

// Real /proc/version strings.
const PROC_WSL1 =
  'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0) #1237-Microsoft Sat Sep 11 14:32:00 PST 2021'
const PROC_WSL2 =
  'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1) (gcc (GCC) 11.2.0) #1 SMP Fri Mar 29 23:14:13 UTC 2024'
const PROC_UBUNTU =
  'Linux version 6.5.0-35-generic (buildd@lcy02-amd64-036) (x86_64-linux-gnu-gcc-12) #35-Ubuntu SMP PREEMPT_DYNAMIC'
const PROC_DEBIAN_DOCKER =
  'Linux version 6.6.16-linuxkit (root@buildkitsandbox) (gcc (Alpine 13.2.1) ) #1 SMP Fri Feb 16 11:54:41 UTC 2024'

// ---------------------------------------------------------------------------
// A fully in-memory HostIO so Windows and WSL branches run on macOS.
// ---------------------------------------------------------------------------

interface FakeIOOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
  files?: Record<string, string>
  /** Symlink creation fails with this errno (Windows without Developer Mode). */
  symlinkError?: string
  /** Create the link entry but not as a real link (exFAT/CIFS behavior). */
  symlinkIsFake?: boolean
  exec?: ExecFn
  which?: (cmd: string) => boolean
  uuids?: string[]
  uid?: number
}

interface FakeIO extends HostIO {
  files: Map<string, string>
  links: Map<string, string>
  dirs: Set<string>
  execCalls: Array<{ file: string; args: string[] }>
  /** Every mkdirp target, retained even after cleanup removes the directory. */
  mkdirCalls: string[]
}

function makeFakeIO(options: FakeIOOptions = {}): FakeIO {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const links = new Map<string, string>()
  const dirs = new Set<string>()
  const execCalls: Array<{ file: string; args: string[] }> = []
  const mkdirCalls: string[] = []
  const uuids = [...(options.uuids ?? [])]
  let uuidCounter = 0

  const enoent = (p: string): NodeJS.ErrnoException => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    e.code = 'ENOENT'
    return e
  }

  const io: FakeIO = {
    files,
    links,
    dirs,
    execCalls,
    mkdirCalls,
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    env: options.env ?? {},
    homedir: () => options.home ?? '/home/fake',
    tmpdir: () => '/tmp',
    readTextFile: async (p) => files.get(p) ?? null,
    writeTextFile: async (p, contents) => {
      files.set(p, contents)
    },
    mkdirp: async (p) => {
      mkdirCalls.push(p)
      dirs.add(p)
    },
    pathExists: async (p) => files.has(p) || dirs.has(p) || links.has(p),
    symlink: async (target, linkPath) => {
      if (options.symlinkError) {
        const e = new Error(options.symlinkError) as NodeJS.ErrnoException
        e.code = options.symlinkError
        throw e
      }
      if (options.symlinkIsFake) {
        files.set(linkPath, 'copy-not-link')
        return
      }
      links.set(linkPath, target)
    },
    lstatIsSymlink: async (p) => {
      if (links.has(p)) return true
      if (files.has(p)) return false
      throw enoent(p)
    },
    readlink: async (p) => {
      const t = links.get(p)
      if (t === undefined) throw enoent(p)
      return t
    },
    remove: async (p) => {
      files.delete(p)
      links.delete(p)
      dirs.delete(p)
    },
    exec:
      options.exec ??
      (async (file, args): Promise<ExecResult> => {
        execCalls.push({ file, args: [...args] })
        return { code: 0, stdout: '', stderr: '' }
      }),
    which: async (cmd) => options.which?.(cmd) ?? false,
    uuid: () => uuids[uuidCounter++] ?? `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`,
    getuid: () => options.uid ?? 1000,
  }

  // Wrap a caller-supplied exec so calls are still recorded.
  if (options.exec) {
    const inner = options.exec
    io.exec = async (file, args, opts) => {
      execCalls.push({ file, args: [...args] })
      return inner(file, args, opts)
    }
  }

  return io
}

// ---------------------------------------------------------------------------

describe('normalizeOS / normalizeArch', () => {
  it('maps Node platforms to our OS union', () => {
    expect(normalizeOS('darwin')).toBe('macos')
    expect(normalizeOS('win32')).toBe('windows')
    expect(normalizeOS('linux')).toBe('linux')
  })

  it('degrades unknown POSIX platforms to linux rather than crashing', () => {
    expect(normalizeOS('freebsd')).toBe('linux')
    expect(normalizeOS('aix')).toBe('linux')
  })

  it('normalizes arch spellings', () => {
    expect(normalizeArch('arm64')).toBe('arm64')
    expect(normalizeArch('aarch64')).toBe('arm64')
    expect(normalizeArch('x64')).toBe('x64')
    expect(normalizeArch('x86_64')).toBe('x64')
    expect(normalizeArch('ia32')).toBe('x64')
  })
})

describe('isWslProcVersion', () => {
  it('detects WSL1, whose marker is capitalized "Microsoft"', () => {
    expect(isWslProcVersion(PROC_WSL1)).toBe(true)
  })

  it('detects WSL2, whose marker is lowercase "microsoft"', () => {
    // A case-sensitive `includes('Microsoft')` — the obvious implementation —
    // silently misses every WSL2 host.
    expect(PROC_WSL2.includes('Microsoft')).toBe(false)
    expect(isWslProcVersion(PROC_WSL2)).toBe(true)
  })

  it('does not fire on native Linux', () => {
    expect(isWslProcVersion(PROC_UBUNTU)).toBe(false)
    expect(isWslProcVersion(PROC_DEBIAN_DOCKER)).toBe(false)
  })

  it('handles a missing /proc/version', () => {
    expect(isWslProcVersion(null)).toBe(false)
    expect(isWslProcVersion('')).toBe(false)
  })
})

describe('detectRuntime', () => {
  it('is always native off Linux', () => {
    expect(detectRuntime('macos', null, {})).toBe('native')
    expect(detectRuntime('windows', null, {})).toBe('native')
  })

  it('uses /proc/version on Linux', () => {
    expect(detectRuntime('linux', PROC_WSL2, {})).toBe('wsl')
    expect(detectRuntime('linux', PROC_UBUNTU, {})).toBe('native')
  })

  it('accepts the WSL env vars as confirmation', () => {
    expect(detectRuntime('linux', null, { WSL_DISTRO_NAME: 'Ubuntu-24.04' })).toBe('wsl')
    expect(detectRuntime('linux', null, { WSL_INTEROP: '/run/WSL/8_interop' })).toBe('wsl')
  })

  it('trusts /proc/version even when the env vars are absent (containers under WSL)', () => {
    expect(detectRuntime('linux', PROC_WSL1, {})).toBe('wsl')
  })
})

describe('detectShell', () => {
  it('is powershell on Windows regardless of SHELL', () => {
    expect(detectShell('windows', { SHELL: '/bin/bash' })).toBe('powershell')
  })

  it('reads the SHELL basename', () => {
    expect(detectShell('macos', { SHELL: '/bin/zsh' })).toBe('zsh')
    expect(detectShell('linux', { SHELL: '/usr/bin/fish' })).toBe('fish')
    expect(detectShell('linux', { SHELL: '/bin/bash' })).toBe('bash')
    expect(detectShell('linux', { SHELL: '/opt/homebrew/bin/bash' })).toBe('bash')
  })

  it('falls back per-OS when SHELL is unset', () => {
    expect(detectShell('macos', {})).toBe('zsh')
    expect(detectShell('linux', {})).toBe('bash')
  })

  it('falls back for an unrecognized shell', () => {
    expect(detectShell('linux', { SHELL: '/bin/ksh' })).toBe('bash')
  })
})

describe('envGet', () => {
  it('finds an exact match', () => {
    expect(envGet({ APPDATA: 'x' }, 'APPDATA')).toBe('x')
  })

  it('is case-insensitive, as Windows env vars are', () => {
    // process.env is a case-insensitive proxy only *on* win32. Reading a
    // captured Windows environment anywhere else needs this.
    expect(envGet({ appdata: 'x' }, 'APPDATA')).toBe('x')
    expect(envGet({ LocalAppData: 'y' }, 'LOCALAPPDATA')).toBe('y')
    expect(envGet({ PROGRAMFILES: 'z' }, 'ProgramFiles')).toBe('z')
  })

  it('returns undefined when absent', () => {
    expect(envGet({}, 'APPDATA')).toBeUndefined()
  })
})

describe('windowsDirs', () => {
  const home = 'C:\\Users\\alice'

  it('uses the real environment variables when present', () => {
    expect(
      windowsDirs(
        {
          APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
          ProgramFiles: 'C:\\Program Files',
        },
        home,
      ),
    ).toEqual({
      appData: 'C:\\Users\\alice\\AppData\\Roaming',
      localAppData: 'C:\\Users\\alice\\AppData\\Local',
      programFiles: 'C:\\Program Files',
    })
  })

  it('derives sane fallbacks when they are unset (Node as a service, some CI)', () => {
    expect(windowsDirs({}, home)).toEqual({
      appData: 'C:\\Users\\alice\\AppData\\Roaming',
      localAppData: 'C:\\Users\\alice\\AppData\\Local',
      programFiles: 'C:\\Program Files',
    })
  })

  it('accepts ProgramW6432 for the 64-bit Program Files', () => {
    expect(windowsDirs({ ProgramW6432: 'D:\\Program Files' }, home).programFiles).toBe('D:\\Program Files')
  })

  it('is case-insensitive about the variable names', () => {
    expect(windowsDirs({ localappdata: 'E:\\Local' }, home).localAppData).toBe('E:\\Local')
  })
})

describe('parseLongPathsRegQuery', () => {
  const output = (hex: string): string =>
    `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\r\n    LongPathsEnabled    REG_DWORD    ${hex}\r\n\r\n`

  it('reads an enabled flag', () => {
    expect(parseLongPathsRegQuery(output('0x1'))).toBe(true)
    expect(parseLongPathsRegQuery(output('0x00000001'))).toBe(true)
  })

  it('reads a disabled flag', () => {
    expect(parseLongPathsRegQuery(output('0x0'))).toBe(false)
    expect(parseLongPathsRegQuery(output('0x00000000'))).toBe(false)
  })

  it('treats missing output as disabled', () => {
    expect(parseLongPathsRegQuery('')).toBe(false)
    expect(parseLongPathsRegQuery('ERROR: The system was unable to find the specified value.')).toBe(false)
  })
})

describe('linuxKeyringAvailable', () => {
  it('needs both the client tool and a bus', () => {
    expect(
      linuxKeyringAvailable({
        hasSecretTool: true,
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        hasUserBusSocket: false,
      }),
    ).toBe(true)
    expect(linuxKeyringAvailable({ hasSecretTool: true, env: {}, hasUserBusSocket: true })).toBe(true)
  })

  it('is false on headless Linux with no bus at all', () => {
    // The CI/container case: secret-tool is installed as a transitive dep and
    // calling it blocks until the timeout.
    expect(linuxKeyringAvailable({ hasSecretTool: true, env: {}, hasUserBusSocket: false })).toBe(false)
  })

  it('is false when secret-tool is not installed', () => {
    expect(
      linuxKeyringAvailable({
        hasSecretTool: false,
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        hasUserBusSocket: true,
      }),
    ).toBe(false)
  })
})

describe('stateDir', () => {
  it('uses Application Support on macOS', () => {
    expect(stateDir('macos', {}, '/Users/alice')).toBe(
      `/Users/alice/Library/Application Support/${APP_DIR_NAME}`,
    )
  })

  it('uses LOCALAPPDATA on Windows', () => {
    expect(stateDir('windows', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toBe(
      `C:\\Users\\a\\AppData\\Local\\${APP_DIR_NAME}`,
    )
  })

  it('falls back to a derived AppData path on Windows', () => {
    expect(stateDir('windows', {}, 'C:\\Users\\a')).toBe(
      `C:\\Users\\a\\AppData\\Local\\${APP_DIR_NAME}`,
    )
  })

  it('honors XDG_STATE_HOME on Linux', () => {
    expect(stateDir('linux', { XDG_STATE_HOME: '/custom/state' }, '/home/a')).toBe(
      `/custom/state/${APP_DIR_NAME}`,
    )
    expect(stateDir('linux', {}, '/home/a')).toBe(`/home/a/.local/state/${APP_DIR_NAME}`)
  })

  it('ignores an empty XDG_STATE_HOME', () => {
    expect(stateDir('linux', { XDG_STATE_HOME: '' }, '/home/a')).toBe(
      `/home/a/.local/state/${APP_DIR_NAME}`,
    )
  })

  it('honors an explicit override on every OS', () => {
    for (const o of ['macos', 'linux', 'windows'] as const) {
      expect(stateDir(o, { AGENTSYNC_STATE_DIR: '/override' }, '/h')).toBe('/override')
    }
  })
})

// ---------------------------------------------------------------------------

describe('probeSymlinkSupport', () => {
  it('returns true on this macOS host using the real filesystem', async () => {
    const r = await probeSymlinkSupport(nodeHostIO, dir)
    expect(r.supported).toBe(true)
  })

  it('cleans up after itself', async () => {
    await probeSymlinkSupport(nodeHostIO, dir)
    expect(await fsp.readdir(dir)).toEqual([])
  })

  it('reports EPERM the way Windows without Developer Mode does', async () => {
    const io = makeFakeIO({ platform: 'win32', symlinkError: 'EPERM' })
    const r = await probeSymlinkSupport(io, 'C:\\state')
    expect(r).toEqual({ supported: false, errorCode: 'EPERM' })
  })

  it('detects a filesystem that accepts the call but does not make a real link', async () => {
    // exFAT/CIFS/some Docker volume drivers: no error, no link either.
    const io = makeFakeIO({ symlinkIsFake: true })
    const r = await probeSymlinkSupport(io, '/state')
    expect(r).toEqual({ supported: false, errorCode: 'ENOTSUP' })
  })

  it('probes the state directory, not tmpdir (symlink support is per-volume)', async () => {
    // tmpdir is frequently a different filesystem (tmpfs, or C:\ when home is
    // a redirected network drive), and symlink support is a property of the
    // volume we will actually write to.
    const stateDirPath = path.join(path.sep, 'some', 'state', 'dir')
    const io = makeFakeIO({})
    await probeSymlinkSupport(io, stateDirPath)
    expect(io.mkdirCalls[0]?.startsWith(path.join(stateDirPath, '.symlink-probe-'))).toBe(true)
    expect(io.mkdirCalls.some((p) => p.startsWith(io.tmpdir()))).toBe(false)
  })
})

describe('probeLongPaths', () => {
  it('is always true off Windows (no MAX_PATH there)', async () => {
    const io = makeFakeIO({})
    expect(await probeLongPaths(io, 'macos')).toBe(true)
    expect(await probeLongPaths(io, 'linux')).toBe(true)
  })

  it('reads the registry on Windows', async () => {
    const enabled: ExecFn = async () => ({
      code: 0,
      stdout: '    LongPathsEnabled    REG_DWORD    0x1\r\n',
      stderr: '',
    })
    const io = makeFakeIO({ platform: 'win32', exec: enabled })
    expect(await probeLongPaths(io, 'windows')).toBe(true)
    expect(io.execCalls[0]?.file).toBe('reg')
    expect(io.execCalls[0]?.args).toContain('LongPathsEnabled')
  })

  it('is false when the value is 0 or the query fails', async () => {
    const disabled: ExecFn = async () => ({
      code: 0,
      stdout: '    LongPathsEnabled    REG_DWORD    0x0\r\n',
      stderr: '',
    })
    expect(await probeLongPaths(makeFakeIO({ exec: disabled }), 'windows')).toBe(false)

    const missing: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'ERROR' })
    expect(await probeLongPaths(makeFakeIO({ exec: missing }), 'windows')).toBe(false)
  })

  it('is false when reg cannot be spawned at all', async () => {
    const boom: ExecFn = async () => {
      throw new Error('spawn reg ENOENT')
    }
    expect(await probeLongPaths(makeFakeIO({ exec: boom }), 'windows')).toBe(false)
  })
})

describe('probeKeyring', () => {
  it('is true on macOS when security(1) answers', async () => {
    const ok: ExecFn = async () => ({ code: 0, stdout: '"/Users/a/Library/Keychains/login.keychain-db"', stderr: '' })
    expect(await probeKeyring(makeFakeIO({ exec: ok }), 'macos', 'native')).toBe(true)
  })

  it('is false on macOS when security(1) fails', async () => {
    const bad: ExecFn = async () => ({ code: 1, stdout: '', stderr: '' })
    expect(await probeKeyring(makeFakeIO({ exec: bad }), 'macos', 'native')).toBe(false)
  })

  it('is true on Windows when powershell is on PATH', async () => {
    const io = makeFakeIO({ platform: 'win32', which: (c) => c === 'powershell.exe' })
    expect(await probeKeyring(io, 'windows', 'native')).toBe(true)
  })

  it('is false on a Linux desktop with no secret-tool', async () => {
    const io = makeFakeIO({
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      which: () => false,
    })
    expect(await probeKeyring(io, 'linux', 'native')).toBe(false)
  })

  it('is true on a Linux desktop with secret-tool and a session bus', async () => {
    const io = makeFakeIO({
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      which: (c) => c === 'secret-tool',
    })
    expect(await probeKeyring(io, 'linux', 'native')).toBe(true)
  })

  it('is false on headless Linux even with secret-tool installed', async () => {
    const io = makeFakeIO({ env: {}, which: (c) => c === 'secret-tool', uid: 1000 })
    expect(await probeKeyring(io, 'linux', 'native')).toBe(false)
  })

  it('accepts a systemd user bus socket in place of the env var', async () => {
    const io = makeFakeIO({ env: {}, which: (c) => c === 'secret-tool', uid: 1000 })
    io.dirs.add('/run/user/1000/bus')
    expect(await probeKeyring(io, 'linux', 'native')).toBe(true)
  })

  it('additionally probes the Secret Service under WSL, where a bus rarely means a keyring', async () => {
    const noService: ExecFn = async () => ({ code: 2, stdout: '', stderr: 'Cannot autolaunch D-Bus' })
    const io = makeFakeIO({
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', WSL_DISTRO_NAME: 'Ubuntu' },
      which: (c) => c === 'secret-tool',
      exec: noService,
    })
    expect(await probeKeyring(io, 'linux', 'wsl')).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('readOrCreateDeviceId', () => {
  it('creates a UUID and persists it', async () => {
    const io = makeFakeIO({ uuids: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'] })
    const id = await readOrCreateDeviceId(io, STATE_DIR)
    expect(id).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    expect(io.files.get(DEVICE_FILE)).toContain('3f2504e0')
  })

  it('is stable across calls — the whole point', async () => {
    const io = makeFakeIO({ uuids: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'aaaaaaaa-4f89-41d3-9a0c-0305e82c3301'] })
    const first = await readOrCreateDeviceId(io, STATE_DIR)
    const second = await readOrCreateDeviceId(io, STATE_DIR)
    expect(second).toBe(first)
  })

  it('is not derived from the hostname', async () => {
    // Renaming a machine must not re-register it as a new device, and every VM
    // in a fleet is called `ubuntu`.
    const io = makeFakeIO({})
    const id = await readOrCreateDeviceId(io, STATE_DIR)
    expect(id.toLowerCase()).not.toContain(os.hostname().toLowerCase())
    expect(isValidDeviceId(id)).toBe(true)
  })

  it('survives a machine rename (the file is what matters)', async () => {
    const io = makeFakeIO({
      files: { [DEVICE_FILE]: JSON.stringify({ v: 1, deviceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }) },
    })
    expect(await readOrCreateDeviceId(io, STATE_DIR)).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
  })

  it('accepts a legacy bare-UUID file', async () => {
    const io = makeFakeIO({ files: { [DEVICE_FILE]: '3f2504e0-4f89-41d3-9a0c-0305e82c3301\n' } })
    expect(await readOrCreateDeviceId(io, STATE_DIR)).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
  })

  it('regenerates when the file is garbage or holds a bad id', async () => {
    for (const contents of ['{"v":1,"deviceId":"not-a-uuid"}', 'total garbage', '{}']) {
      const io = makeFakeIO({ files: { [DEVICE_FILE]: contents } })
      expect(isValidDeviceId(await readOrCreateDeviceId(io, STATE_DIR))).toBe(true)
    }
  })

  it('honors an environment override for CI', async () => {
    const io = makeFakeIO({ env: { AGENTSYNC_DEVICE_ID: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' } })
    expect(await readOrCreateDeviceId(io, STATE_DIR)).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    expect(io.files.size).toBe(0) // nothing written
  })

  it('ignores an invalid environment override', async () => {
    const io = makeFakeIO({ env: { AGENTSYNC_DEVICE_ID: 'nope' } })
    expect(isValidDeviceId(await readOrCreateDeviceId(io, STATE_DIR))).toBe(true)
  })

  it('still returns an id when the home directory is read-only', async () => {
    const io = makeFakeIO({})
    io.writeTextFile = async () => {
      const e = new Error('EROFS') as NodeJS.ErrnoException
      e.code = 'EROFS'
      throw e
    }
    expect(isValidDeviceId(await readOrCreateDeviceId(io, STATE_DIR))).toBe(true)
  })

  it('writes the file 0600', async () => {
    const modes: number[] = []
    const io = makeFakeIO({})
    const inner = io.writeTextFile
    io.writeTextFile = async (p, c, mode) => {
      if (mode !== undefined) modes.push(mode)
      return inner(p, c, mode)
    }
    await readOrCreateDeviceId(io, STATE_DIR)
    expect(modes).toEqual([0o600])
  })
})

describe('isValidDeviceId', () => {
  it('accepts a v4 UUID and rejects everything else', () => {
    expect(isValidDeviceId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
    expect(isValidDeviceId('not-a-uuid')).toBe(false)
    expect(isValidDeviceId('')).toBe(false)
    expect(isValidDeviceId(undefined)).toBe(false)
    expect(isValidDeviceId(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('detectHost with a simulated Windows host', () => {
  const winExec: ExecFn = async (file, args) => {
    if (file === 'reg' && args.includes('LongPathsEnabled')) {
      return { code: 0, stdout: '    LongPathsEnabled    REG_DWORD    0x1\r\n', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: '' }
  }

  const winEnv = {
    USERPROFILE: 'C:\\Users\\alice',
    APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  }

  it('detects Windows without Developer Mode', async () => {
    const io = makeFakeIO({
      platform: 'win32',
      arch: 'x64',
      env: winEnv,
      home: 'C:\\Users\\alice',
      symlinkError: 'EPERM',
      exec: winExec,
      which: (c) => c === 'powershell.exe',
    })

    const host = await detectHost({ io })

    expect(host.os).toBe('windows')
    expect(host.runtime).toBe('native')
    expect(host.arch).toBe('x64')
    expect(host.home).toBe('C:\\Users\\alice')
    expect(host.shell).toBe('powershell')
    expect(host.appData).toBe('C:\\Users\\alice\\AppData\\Roaming')
    expect(host.localAppData).toBe('C:\\Users\\alice\\AppData\\Local')
    expect(host.programFiles).toBe('C:\\Program Files')
    // Probed, not assumed from the OS.
    expect(host.supportsSymlinks).toBe(false)
    expect(host.supportsLongPaths).toBe(true)
    expect(host.hasKeyring).toBe(true)
    expect(isValidDeviceId(host.deviceId)).toBe(true)
  })

  it('detects Windows WITH Developer Mode as supporting symlinks', async () => {
    const io = makeFakeIO({
      platform: 'win32',
      env: winEnv,
      home: 'C:\\Users\\alice',
      exec: winExec,
      which: (c) => c === 'powershell.exe',
    })
    const host = await detectHost({ io })
    expect(host.supportsSymlinks).toBe(true)
  })

  it('reports long paths off when the registry key is absent', async () => {
    const io = makeFakeIO({
      platform: 'win32',
      env: winEnv,
      home: 'C:\\Users\\alice',
      exec: async () => ({ code: 1, stdout: '', stderr: 'ERROR' }),
    })
    const host = await detectHost({ io })
    expect(host.supportsLongPaths).toBe(false)
  })

  it('prefers USERPROFILE over os.homedir() (AD homedirs point at a network share)', async () => {
    const io = makeFakeIO({
      platform: 'win32',
      env: winEnv,
      home: '\\\\fileserver\\redirected\\alice',
      exec: winExec,
    })
    const host = await detectHost({ io })
    expect(host.home).toBe('C:\\Users\\alice')
  })

  it('synthesizes AppData paths when the env vars are missing', async () => {
    const io = makeFakeIO({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\bob' },
      home: 'C:\\Users\\bob',
      exec: winExec,
    })
    const host = await detectHost({ io })
    expect(host.appData).toBe('C:\\Users\\bob\\AppData\\Roaming')
    expect(host.localAppData).toBe('C:\\Users\\bob\\AppData\\Local')
  })
})

describe('detectHost with a simulated WSL host', () => {
  it('reports linux/wsl and no keyring', async () => {
    const io = makeFakeIO({
      platform: 'linux',
      arch: 'x64',
      env: { HOME: '/home/alice', SHELL: '/bin/bash', WSL_DISTRO_NAME: 'Ubuntu-24.04' },
      home: '/home/alice',
      files: { '/proc/version': PROC_WSL2 },
      which: () => false,
    })

    const host = await detectHost({ io })

    expect(host.os).toBe('linux')
    expect(host.runtime).toBe('wsl')
    expect(host.shell).toBe('bash')
    expect(host.hasKeyring).toBe(false)
    expect(host.supportsLongPaths).toBe(true)
    // No interop env vars => no Windows paths, rather than bogus C:\ guesses.
    expect(host.appData).toBeUndefined()
    expect(host.programFiles).toBeUndefined()
  })

  it('surfaces the Windows paths WSL interop exposes, without synthesizing any', async () => {
    const io = makeFakeIO({
      platform: 'linux',
      env: {
        HOME: '/home/alice',
        WSL_DISTRO_NAME: 'Ubuntu',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      },
      home: '/home/alice',
      files: { '/proc/version': PROC_WSL2 },
    })
    const host = await detectHost({ io })
    expect(host.appData).toBe('C:\\Users\\alice\\AppData\\Roaming')
    // Absent from the interop env, so we do not invent it.
    expect(host.localAppData).toBeUndefined()
    expect(host.programFiles).toBeUndefined()
  })

  it('detects native Linux as native with no Windows paths', async () => {
    const io = makeFakeIO({
      platform: 'linux',
      env: { HOME: '/home/alice', SHELL: '/usr/bin/fish' },
      home: '/home/alice',
      files: { '/proc/version': PROC_UBUNTU },
    })
    const host = await detectHost({ io })
    expect(host.runtime).toBe('native')
    expect(host.shell).toBe('fish')
    expect(host.appData).toBeUndefined()
  })
})

describe('detectHost with a simulated headless Linux CI runner', () => {
  it('reports no keyring so the encrypted-file fallback is selected', async () => {
    const io = makeFakeIO({
      platform: 'linux',
      env: { HOME: '/root', CI: 'true' }, // no DBUS_SESSION_BUS_ADDRESS
      home: '/root',
      files: { '/proc/version': PROC_DEBIAN_DOCKER },
      which: (c) => c === 'secret-tool', // installed, but nothing to talk to
      uid: 0,
    })
    const host = await detectHost({ io })
    expect(host.runtime).toBe('native')
    expect(host.hasKeyring).toBe(false)
    expect(host.supportsSymlinks).toBe(true)
  })
})

describe('detectHost overrides and fast path', () => {
  it('honors AGENTSYNC_ASSUME_SYMLINKS', async () => {
    const io = makeFakeIO({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\a', AGENTSYNC_ASSUME_SYMLINKS: '1' },
      home: 'C:\\Users\\a',
      symlinkError: 'EPERM', // would otherwise report false
    })
    const host = await detectHost({ io })
    expect(host.supportsSymlinks).toBe(true)
  })

  it('skipProbes avoids all IO and uses conservative defaults', async () => {
    const io = makeFakeIO({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\a' }, home: 'C:\\Users\\a' })
    const host = await detectHost({ io, skipProbes: true })
    expect(io.execCalls).toEqual([])
    expect(host.supportsSymlinks).toBe(false)
    expect(host.supportsLongPaths).toBe(false)
  })
})

describe('detectHost on the real host', () => {
  it('detects this macOS machine correctly', async () => {
    // Redirect state to a temp dir so the test never touches the real
    // ~/Library/Application Support.
    const io: HostIO = { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: dir } }
    const host = await detectHost({ io })

    expect(host.os).toBe(normalizeOS(process.platform))
    expect(host.runtime).toBe('native')
    expect(['x64', 'arm64']).toContain(host.arch)
    expect(host.home).toBe(os.homedir())
    expect(host.supportsLongPaths).toBe(true)
    expect(isValidDeviceId(host.deviceId)).toBe(true)
  })

  it('really creates a symlink to answer supportsSymlinks', async () => {
    const io: HostIO = { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: dir } }
    const host = await detectHost({ io })
    expect(host.supportsSymlinks).toBe(true)
    // The probe must not leave anything behind.
    expect((await fsp.readdir(dir)).filter((f) => f.startsWith('.symlink-probe'))).toEqual([])
  })

  it('persists the device id across separate detections', async () => {
    const io: HostIO = { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: dir } }
    const a = await detectHost({ io })
    const b = await detectHost({ io })
    expect(b.deviceId).toBe(a.deviceId)
    expect(await fsp.readFile(path.join(dir, 'device.json'), 'utf8')).toContain(a.deviceId)
  })

  // POSIX only. Windows has no POSIX mode bits: libuv synthesizes 0666/0444
  // from the read-only attribute, and `atomic.ts` deliberately never chmods
  // there because doing so would clear that attribute or fail outright. So this
  // asserts a guarantee the platform genuinely makes on macOS and Linux — where
  // a world-readable device file on a shared box is a real defect — and cannot
  // make on Windows, where confidentiality comes from the inherited NTFS ACL on
  // %LOCALAPPDATA% and Node exposes no way to read it. There is nothing honest
  // to assert in its place here; the Windows half of the mode contract is
  // covered by atomic.test.ts ("reports no mode on Windows").
  it.skipIf(process.platform === 'win32')('writes the device id 0600', async () => {
    const io: HostIO = { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: dir } }
    await detectHost({ io })
    expect((await fsp.stat(path.join(dir, 'device.json'))).mode & 0o777).toBe(0o600)
  })

  it('gives a different device id to a different install', async () => {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-test-2-'))
    try {
      const a = await detectHost({ io: { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: dir } } })
      const b = await detectHost({ io: { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: other } } })
      expect(b.deviceId).not.toBe(a.deviceId)
    } finally {
      await fsp.rm(other, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')('finds the macOS keyring', async () => {
    const io: HostIO = { ...nodeHostIO, env: { ...process.env, AGENTSYNC_STATE_DIR: dir } }
    expect((await detectHost({ io })).hasKeyring).toBe(true)
  })
})
