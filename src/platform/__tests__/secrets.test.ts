import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { HostEnv } from '../../core/types.js'
import {
  decodeSecretFileName,
  encodeSecretFileName,
  EncryptedFileStore,
  LinuxLibsecretStore,
  MacosKeychainStore,
  MemorySecretStore,
  NoSecretBackendError,
  parseSecretToolSearch,
  secretEquals,
  SecretsError,
  SecretsNotSupportedError,
  selectSecretStore,
  WindowsDpapiStore,
  type ExecFn,
  type ExecResult,
  type SecretFsOps,
  type VaultFile,
} from '../secrets.js'

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'secrets-test-'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

// scrypt at the production N=32768 costs ~60ms per call; tests do dozens.
const TEST_N = 2048

interface RecordedCall {
  file: string
  args: string[]
  input: string | undefined
}

function recordingExec(handler: (call: RecordedCall) => ExecResult): {
  exec: ExecFn
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const exec: ExecFn = async (file, args, options) => {
    const call = { file, args: [...args], input: options?.input }
    calls.push(call)
    return handler(call)
  }
  return { exec, calls }
}

function memFs(): SecretFsOps & { files: Map<string, Buffer>; modes: Map<string, number> } {
  const files = new Map<string, Buffer>()
  const modes = new Map<string, number>()
  const enoent = (p: string): NodeJS.ErrnoException => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    e.code = 'ENOENT'
    return e
  }
  return {
    files,
    modes,
    async readFile(p) {
      const v = files.get(p)
      if (!v) throw enoent(p)
      return v
    },
    async readdir(p) {
      const prefix = `${p}${path.sep}`
      const names = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
      if (names.length === 0 && ![...files.keys()].some((k) => k.startsWith(p))) throw enoent(p)
      return names
    },
    async rm(p) {
      files.delete(p)
      modes.delete(p)
    },
    async mkdir() {
      return undefined
    },
    async writeFile(p, data, opts) {
      files.set(p, Buffer.from(data as Uint8Array | string))
      if (opts?.mode !== undefined) modes.set(p, opts.mode)
    },
  }
}

const hostOf = (over: Partial<HostEnv>): HostEnv => ({
  os: 'macos',
  runtime: 'native',
  arch: 'arm64',
  home: '/Users/x',
  supportsSymlinks: true,
  hasKeyring: true,
  supportsLongPaths: true,
  shell: 'zsh',
  deviceId: '00000000-0000-4000-8000-000000000000',
  ...over,
})

// ---------------------------------------------------------------------------

describe('EncryptedFileStore', () => {
  const make = (over: { passphrase?: string; fs?: SecretFsOps; file?: string } = {}): EncryptedFileStore =>
    new EncryptedFileStore({
      file: over.file ?? path.join(dir, 'secrets.vault.json'),
      passphrase: over.passphrase ?? 'correct horse battery staple',
      ...(over.fs ? { fs: over.fs } : {}),
      scryptN: TEST_N,
    })

  it('round-trips a secret', async () => {
    const store = make()
    expect(await store.get('anthropic-token')).toBeNull()
    await store.set('anthropic-token', 'sk-ant-abc123')
    expect(await store.get('anthropic-token')).toBe('sk-ant-abc123')
  })

  it('keeps multiple keys and lists them sorted', async () => {
    const store = make()
    await store.set('b', '2')
    await store.set('a', '1')
    await store.set('c', '3')
    expect(await store.list()).toEqual(['a', 'b', 'c'])
    expect(await store.get('b')).toBe('2')
  })

  it('deletes and reports whether the key was present', async () => {
    const store = make()
    await store.set('k', 'v')
    expect(await store.delete('k')).toBe(true)
    expect(await store.delete('k')).toBe(false)
    expect(await store.get('k')).toBeNull()
  })

  it('handles empty and unicode values', async () => {
    const store = make()
    await store.set('empty', '')
    await store.set('uni', 'pässwörd 😀 \n\t')
    expect(await store.get('empty')).toBe('')
    expect(await store.get('uni')).toBe('pässwörd 😀 \n\t')
  })

  it('never writes the plaintext to disk', async () => {
    const file = path.join(dir, 'v.json')
    await make({ file }).set('token', 'SUPER-SECRET-VALUE')
    const raw = await fsp.readFile(file, 'utf8')
    expect(raw).not.toContain('SUPER-SECRET-VALUE')
    expect(raw).not.toContain('token') // key names are inside the ciphertext too
  })

  // POSIX only, and the assertion stays at full strength there: a secrets vault
  // readable by every account on a shared machine is a real leak, so 0600 is not
  // negotiable on macOS or Linux. Windows has no POSIX mode bits at all — libuv
  // synthesizes 0666/0444 from the read-only attribute and `atomic.ts` never
  // chmods there on purpose — so demanding 0600 would be demanding a guarantee
  // the platform cannot give. What protects the vault on Windows is the ACL the
  // file inherits from %LOCALAPPDATA%, which Node offers no API to inspect;
  // "never writes the plaintext to disk" above is the confidentiality property
  // that does hold identically on every OS.
  it.skipIf(process.platform === 'win32')('writes the vault 0600', async () => {
    const file = path.join(dir, 'v.json')
    await make({ file }).set('k', 'v')
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('rejects a wrong passphrase without revealing which part was wrong', async () => {
    const file = path.join(dir, 'v.json')
    await make({ file }).set('k', 'v')
    const wrong = make({ file, passphrase: 'nope' })
    await expect(wrong.get('k')).rejects.toBeInstanceOf(SecretsError)
    await expect(wrong.get('k')).rejects.toThrow(/wrong passphrase or the vault has been modified/)
  })

  it('detects tampering with the ciphertext (GCM auth tag)', async () => {
    const file = path.join(dir, 'v.json')
    const store = make({ file })
    await store.set('k', 'v')

    const vault = JSON.parse(await fsp.readFile(file, 'utf8')) as VaultFile
    const ct = Buffer.from(vault.ct, 'base64')
    ct[0] = (ct[0]! ^ 0xff) & 0xff
    vault.ct = ct.toString('base64')
    await fsp.writeFile(file, JSON.stringify(vault))

    await expect(store.get('k')).rejects.toThrow(/modified/)
  })

  it('detects a downgraded KDF cost (the header is authenticated)', async () => {
    // Without binding the KDF params as AAD, an attacker could rewrite N=2 and
    // brute-force the passphrase against the same ciphertext.
    const file = path.join(dir, 'v.json')
    const store = make({ file })
    await store.set('k', 'v')

    const vault = JSON.parse(await fsp.readFile(file, 'utf8')) as VaultFile
    vault.kdf.N = 2
    await fsp.writeFile(file, JSON.stringify(vault))

    await expect(store.get('k')).rejects.toThrow(/modified/)
  })

  it('uses a fresh IV and salt on every write (GCM fails catastrophically on IV reuse)', async () => {
    const file = path.join(dir, 'v.json')
    const store = make({ file })
    await store.set('k', 'v1')
    const first = JSON.parse(await fsp.readFile(file, 'utf8')) as VaultFile
    await store.set('k', 'v2')
    const second = JSON.parse(await fsp.readFile(file, 'utf8')) as VaultFile

    expect(second.iv).not.toBe(first.iv)
    expect(second.kdf.salt).not.toBe(first.kdf.salt)
  })

  it('treats a missing vault as empty, not an error', async () => {
    const store = make({ file: path.join(dir, 'does-not-exist.json') })
    expect(await store.list()).toEqual([])
    expect(await store.get('k')).toBeNull()
  })

  it('reports a corrupt (non-JSON) vault clearly', async () => {
    const file = path.join(dir, 'v.json')
    await fsp.writeFile(file, 'not json at all')
    await expect(make({ file }).get('k')).rejects.toThrow(/not valid JSON/)
  })

  it('refuses an empty passphrase at construction', () => {
    expect(() => new EncryptedFileStore({ file: path.join(dir, 'v'), passphrase: '' })).toThrow(
      /requires a passphrase/,
    )
  })

  it('rekeys without losing entries', async () => {
    const file = path.join(dir, 'v.json')
    const store = make({ file })
    await store.set('a', '1')
    await store.set('b', '2')

    await store.rekey('a brand new passphrase')

    await expect(store.get('a')).rejects.toThrow(/wrong passphrase/)
    const rekeyed = make({ file, passphrase: 'a brand new passphrase' })
    expect(await rekeyed.list()).toEqual(['a', 'b'])
    expect(await rekeyed.get('b')).toBe('2')
  })

  it('advertises its capabilities honestly', async () => {
    const store = make()
    expect(store.capabilities).toEqual({ list: true, persistent: true, osProtected: false })
    expect(await store.isAvailable()).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('MacosKeychainStore', () => {
  it('builds the expected security(1) invocation for set', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 0, stdout: '', stderr: '' }))
    await new MacosKeychainStore({ service: 'agentsync', exec }).set('token', 'sk-123')
    expect(calls[0]?.file).toBe('/usr/bin/security')
    expect(calls[0]?.args).toEqual([
      'add-generic-password',
      '-a',
      'token',
      '-s',
      'agentsync',
      '-U', // update in place instead of failing on an existing item
      '-w',
      'sk-123',
    ])
  })

  it('strips exactly one trailing newline from a read', async () => {
    const { exec } = recordingExec(() => ({ code: 0, stdout: 'sk-123\n', stderr: '' }))
    expect(await new MacosKeychainStore({ exec }).get('token')).toBe('sk-123')
  })

  it('preserves a trailing newline that is part of the secret', async () => {
    const { exec } = recordingExec(() => ({ code: 0, stdout: 'line1\nline2\n', stderr: '' }))
    expect(await new MacosKeychainStore({ exec }).get('k')).toBe('line1\nline2')
  })

  it('maps "not found" (exit 44) to null rather than throwing', async () => {
    const { exec } = recordingExec(() => ({
      code: 44,
      stdout: '',
      stderr: 'The specified item could not be found in the keychain.',
    }))
    expect(await new MacosKeychainStore({ exec }).get('missing')).toBeNull()
  })

  it('throws on an unexpected failure', async () => {
    const { exec } = recordingExec(() => ({ code: 1, stdout: '', stderr: 'boom' }))
    await expect(new MacosKeychainStore({ exec }).get('k')).rejects.toBeInstanceOf(SecretsError)
  })

  it('reports delete of a missing item as false', async () => {
    const { exec } = recordingExec(() => ({ code: 44, stdout: '', stderr: 'could not be found' }))
    expect(await new MacosKeychainStore({ exec }).delete('k')).toBe(false)
  })

  it('refuses to list rather than triggering a wall of auth prompts', async () => {
    const { exec } = recordingExec(() => ({ code: 0, stdout: '', stderr: '' }))
    const store = new MacosKeychainStore({ exec })
    expect(store.capabilities.list).toBe(false)
    await expect(store.list()).rejects.toBeInstanceOf(SecretsNotSupportedError)
  })

  it('reports unavailable when security(1) cannot be spawned', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    }
    expect(await new MacosKeychainStore({ exec }).isAvailable()).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin')('is genuinely available on this macOS host', async () => {
    // Read-only probe against the real `security` binary; never writes an item.
    expect(await new MacosKeychainStore().isAvailable()).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('LinuxLibsecretStore', () => {
  it('passes the secret on stdin, never in argv', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 0, stdout: '', stderr: '' }))
    await new LinuxLibsecretStore({ service: 'agentsync', exec }).set('token', 'sk-SECRET')

    expect(calls[0]?.input).toBe('sk-SECRET')
    expect(calls[0]?.args.join(' ')).not.toContain('sk-SECRET')
    expect(calls[0]?.args).toEqual([
      'store',
      '--label',
      'agentsync: token',
      'service',
      'agentsync',
      'account',
      'token',
    ])
  })

  it('looks a secret up by attributes', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 0, stdout: 'sk-123', stderr: '' }))
    expect(await new LinuxLibsecretStore({ exec }).get('token')).toBe('sk-123')
    expect(calls[0]?.args).toEqual(['lookup', 'service', 'agentsync', 'account', 'token'])
  })

  it('maps a non-zero lookup to null', async () => {
    const { exec } = recordingExec(() => ({ code: 1, stdout: '', stderr: '' }))
    expect(await new LinuxLibsecretStore({ exec }).get('missing')).toBeNull()
  })

  it('does not clear a key that was never stored', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 1, stdout: '', stderr: '' }))
    expect(await new LinuxLibsecretStore({ exec }).delete('k')).toBe(false)
    expect(calls.map((c) => c.args[0])).toEqual(['lookup'])
  })

  it('reports unavailable when secret-tool is not installed', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })
    }
    expect(await new LinuxLibsecretStore({ exec }).isAvailable()).toBe(false)
  })

  it('treats "no results" (exit 1) as available — the daemon answered', async () => {
    const { exec } = recordingExec(() => ({ code: 1, stdout: '', stderr: '' }))
    expect(await new LinuxLibsecretStore({ exec }).isAvailable()).toBe(true)
  })

  it('bounds the call so a dead D-Bus cannot hang the CLI', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 0, stdout: '', stderr: '' }))
    await new LinuxLibsecretStore({ exec }).get('k')
    // Timeout is threaded through to spawn; without it, secret-tool blocks
    // forever on a session bus with no Secret Service behind it.
    expect(calls).toHaveLength(1)
  })
})

describe('parseSecretToolSearch', () => {
  it('extracts account attributes from real-shaped output', () => {
    const stdout = [
      '[/org/freedesktop/secrets/collection/login/1]',
      'label = agentsync: token',
      'secret = sk-123',
      'created = 2026-07-29 10:00:00',
      'attribute.service = agentsync',
      'attribute.account = token',
      '',
      '[/org/freedesktop/secrets/collection/login/2]',
      'label = agentsync: refresh',
      'attribute.service = agentsync',
      'attribute.account = refresh',
    ].join('\n')
    expect(parseSecretToolSearch(stdout).sort()).toEqual(['refresh', 'token'])
  })

  it('deduplicates and tolerates empty output', () => {
    expect(parseSecretToolSearch('')).toEqual([])
    expect(parseSecretToolSearch('attribute.account = a\nattribute.account = a')).toEqual(['a'])
  })

  it('does not mistake the label or secret lines for an account', () => {
    expect(parseSecretToolSearch('label = attribute.account = x\nsecret = y')).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('WindowsDpapiStore', () => {
  /**
   * Stands in for CryptProtectData: SecureString round-trip through a hex blob.
   *
   * It models the *wire* contract as well as the crypto one. The plaintext
   * crosses the process boundary base64-encoded in both directions, because
   * PowerShell's `[Console]::In`/`[Console]::Out` use the OEM console code page
   * rather than UTF-8 and would otherwise corrupt any non-ASCII secret.
   */
  const fakePowershell: ExecFn = async (_file, args, options) => {
    const script = args[args.length - 1] ?? ''
    const input = options?.input ?? ''
    if (script.includes('ConvertFrom-SecureString')) {
      // Protect: base64(UTF-8 plaintext) in, an opaque hex blob out.
      const plain = Buffer.from(input.trim(), 'base64').toString('utf8')
      return { code: 0, stdout: `${Buffer.from(plain, 'utf16le').toString('hex')}\n`, stderr: '' }
    }
    if (script.includes('SecureStringToBSTR')) {
      // Unprotect: the hex blob in, base64(UTF-8 plaintext) out.
      const plain = Buffer.from(input.trim(), 'hex').toString('utf16le')
      return { code: 0, stdout: Buffer.from(plain, 'utf8').toString('base64'), stderr: '' }
    }
    if (script.includes('ok')) return { code: 0, stdout: 'ok', stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected script' }
  }

  const make = (over: { exec?: ExecFn; fs?: SecretFsOps } = {}): WindowsDpapiStore =>
    new WindowsDpapiStore({
      dir: 'C:\\Users\\x\\AppData\\Local\\agentsync\\secrets',
      exec: over.exec ?? fakePowershell,
      fs: over.fs ?? memFs(),
    })

  it('round-trips a secret through DPAPI', async () => {
    const store = make()
    await store.set('token', 'sk-ant-xyz')
    expect(await store.get('token')).toBe('sk-ant-xyz')
  })

  it('round-trips a NON-ASCII secret byte for byte', async () => {
    // The conformance suite proves this against real DPAPI on a real runner;
    // this proves the transport encoding from here. PowerShell decodes stdin
    // with the console's OEM code page (437 on a US machine), so handing it raw
    // UTF-8 mangled every accented or CJK character on the way in and again on
    // the way out. Both directions are base64 now, which is ASCII in every code
    // page — and this test fails the moment someone "simplifies" that away.
    const store = make()
    for (const value of ['hunter2-é中', 'ünïcødé 🔑', 'ascii-only']) {
      await store.set('token', value)
      expect(await store.get('token')).toBe(value)
    }
  })

  it('never puts the secret in the command line', async () => {
    // On Windows any process in the session can read another process's argv.
    const calls: RecordedCall[] = []
    const exec: ExecFn = async (file, args, options) => {
      calls.push({ file, args: [...args], input: options?.input })
      return fakePowershell(file, args, options)
    }
    await make({ exec }).set('token', 'sk-SECRET-VALUE')
    const encoded = Buffer.from('sk-SECRET-VALUE', 'utf8').toString('base64')
    const argv = calls.map((c) => c.args.join(' '))
    expect(argv.every((a) => !a.includes('sk-SECRET-VALUE') && !a.includes(encoded))).toBe(true)
    // stdin is where it went, base64-encoded so the console code page cannot
    // corrupt it. Encoding is not obfuscation: this is transport, not secrecy.
    expect(calls[0]?.input).toBe(encoded)
  })

  it('invokes powershell non-interactively with no profile', async () => {
    const calls: RecordedCall[] = []
    const exec: ExecFn = async (file, args, options) => {
      calls.push({ file, args: [...args], input: options?.input })
      return fakePowershell(file, args, options)
    }
    await make({ exec }).set('k', 'v')
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ])
  })

  it('stores the blob 0600 and not in plaintext', async () => {
    const fs = memFs()
    await make({ fs }).set('token', 'sk-SECRET')
    const [file] = [...fs.files.keys()]
    expect(fs.modes.get(file!)).toBe(0o600)
    expect(fs.files.get(file!)!.toString('utf8')).not.toContain('sk-SECRET')
  })

  it('returns null for a key that was never stored', async () => {
    expect(await make().get('nope')).toBeNull()
  })

  it('lists and deletes stored keys', async () => {
    const store = make()
    await store.set('b', '2')
    await store.set('a', '1')
    expect(await store.list()).toEqual(['a', 'b'])
    expect(await store.delete('a')).toBe(true)
    expect(await store.delete('a')).toBe(false)
    expect(await store.list()).toEqual(['b'])
  })

  it('surfaces a powershell failure', async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'DPAPI unavailable' })
    await expect(make({ exec }).set('k', 'v')).rejects.toThrow(/DPAPI protect failed/)
  })

  it('rejects an empty protected blob instead of storing nothing', async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: '   \n', stderr: '' })
    await expect(make({ exec }).set('k', 'v')).rejects.toThrow(/empty blob/)
  })
})

describe('secret file name encoding', () => {
  it('round-trips key names that are illegal as NTFS filenames', () => {
    for (const key of ['a/b', 'a:b', 'CON', 'a*b?', 'ünïcødé', 'x'.repeat(50)]) {
      expect(decodeSecretFileName(encodeSecretFileName(key)), key).toBe(key)
    }
  })

  it('produces base64url (no /, no +, no padding) so the name is NTFS-safe', () => {
    const name = encodeSecretFileName('a/b+c==')
    expect(name).toMatch(/^[A-Za-z0-9_-]+\.dpapi$/)
  })

  it('ignores unrelated files in the directory', () => {
    expect(decodeSecretFileName('readme.txt')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('secretEquals', () => {
  it('compares correctly', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
    expect(secretEquals('abc', 'abd')).toBe(false)
    expect(secretEquals('abc', 'abcd')).toBe(false)
    expect(secretEquals('', '')).toBe(true)
  })
})

describe('MemorySecretStore', () => {
  it('works but declares itself non-persistent', async () => {
    const store = new MemorySecretStore()
    await store.set('k', 'v')
    expect(await store.get('k')).toBe('v')
    expect(store.capabilities.persistent).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('selectSecretStore', () => {
  const okExec: ExecFn = async () => ({ code: 0, stdout: 'ok', stderr: '' })
  const failExec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no' })

  it('picks the Keychain on macOS', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'macos' }), { exec: okExec })
    expect(sel.chosen).toBe('macos-keychain')
    expect(sel.degraded).toBe(false)
  })

  it('degrades to the encrypted file when the Keychain probe fails', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'macos' }), {
      exec: failExec,
      vaultFile: path.join(dir, 'v.json'),
      passphrase: 'pw',
      scryptN: TEST_N,
    })
    expect(sel.chosen).toBe('encrypted-file')
    expect(sel.degraded).toBe(true)
    expect(sel.attempted[0]).toMatchObject({ backend: 'macos-keychain', available: false })
  })

  it('picks DPAPI on Windows', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'windows', shell: 'powershell' }), {
      exec: okExec,
      dpapiDir: 'C:\\x',
      fs: memFs(),
    })
    expect(sel.chosen).toBe('windows-dpapi')
    expect(sel.degraded).toBe(false)
  })

  it('picks libsecret on a Linux desktop', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'linux', shell: 'bash', hasKeyring: true }), {
      exec: okExec,
    })
    expect(sel.chosen).toBe('linux-libsecret')
  })

  it('skips libsecret entirely on headless Linux, without paying its timeout', async () => {
    // hasKeyring:false is the probed truth from detectHost. Calling secret-tool
    // here would block until the timeout on a machine with no session bus.
    let execCalls = 0
    const countingExec: ExecFn = async () => {
      execCalls++
      return { code: 0, stdout: '', stderr: '' }
    }
    const sel = await selectSecretStore(hostOf({ os: 'linux', shell: 'bash', hasKeyring: false }), {
      exec: countingExec,
      vaultFile: path.join(dir, 'v.json'),
      passphrase: 'ci-passphrase',
      scryptN: TEST_N,
    })
    expect(sel.chosen).toBe('encrypted-file')
    expect(sel.degraded).toBe(true)
    expect(sel.attempted[0]).toMatchObject({
      backend: 'linux-libsecret',
      available: false,
      reason: 'host reports no keyring',
    })
    expect(execCalls).toBe(0)
  })

  it('works for WSL, which reports no keyring', async () => {
    const sel = await selectSecretStore(
      hostOf({ os: 'linux', runtime: 'wsl', shell: 'bash', hasKeyring: false }),
      { vaultFile: path.join(dir, 'v.json'), passphrase: 'pw', scryptN: TEST_N },
    )
    expect(sel.chosen).toBe('encrypted-file')
  })

  it('throws an actionable error when nothing is usable', async () => {
    const err = await selectSecretStore(hostOf({ os: 'linux', shell: 'bash', hasKeyring: false }), {}).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(NoSecretBackendError)
    expect((err as Error).message).toContain('AGENTSYNC_VAULT_PASSPHRASE')
    expect((err as NoSecretBackendError).attempted.map((a) => a.backend)).toEqual([
      'linux-libsecret',
      'encrypted-file',
    ])
  })

  it('honors a forced backend and does not call it degraded', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'macos' }), {
      force: 'encrypted-file',
      vaultFile: path.join(dir, 'v.json'),
      passphrase: 'pw',
      scryptN: TEST_N,
    })
    expect(sel.chosen).toBe('encrypted-file')
    expect(sel.degraded).toBe(false)
  })

  it('allows the memory store only when explicitly opted in', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'linux', shell: 'bash', hasKeyring: false }), {
      allowMemory: true,
    })
    expect(sel.chosen).toBe('memory')
    expect(sel.degraded).toBe(true)
  })

  it('explains why each backend was skipped', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'windows', shell: 'powershell' }), {
      exec: okExec,
      vaultFile: path.join(dir, 'v.json'),
      passphrase: 'pw',
      scryptN: TEST_N,
      // No dpapiDir, so the DPAPI backend cannot be constructed.
    })
    expect(sel.chosen).toBe('encrypted-file')
    expect(sel.attempted[0]).toMatchObject({
      backend: 'windows-dpapi',
      available: false,
      reason: 'not configured for this host',
    })
  })

  it('returns a store that actually works end to end', async () => {
    const sel = await selectSecretStore(hostOf({ os: 'linux', shell: 'bash', hasKeyring: false }), {
      vaultFile: path.join(dir, 'v.json'),
      passphrase: 'pw',
      scryptN: TEST_N,
    })
    await sel.store.set('k', 'v')
    expect(await sel.store.get('k')).toBe('v')
  })
})
