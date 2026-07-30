/**
 * Secret storage with per-OS backends and a graceful degradation ladder.
 *
 * Backends, best first:
 *   macos-keychain   `security` CLI            (always present on macOS)
 *   windows-dpapi    `powershell` + DPAPI      (no native module, no admin)
 *   linux-libsecret  `secret-tool`             (needs a session D-Bus)
 *   encrypted-file   scrypt + AES-256-GCM      (headless Linux, CI, WSL)
 *
 * The last one is not a nice-to-have. Half of Linux usage is headless — no
 * D-Bus, no gnome-keyring, `secret-tool` either missing or hanging forever
 * waiting for a prompt that nobody will answer. WSL is the same story. If the
 * CLI hard-requires a keyring there, it simply does not run.
 *
 * Selection is explicit and reported, because "where is my token stored" is a
 * question users and security reviewers both ask.
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import {
  randomBytes,
  scrypt as scryptCb,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import type { HostEnv } from '../core/types.js'
import { atomicWriteFile, errnoCode } from './atomic.js'
import { canonicalJson } from './canonical.js'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type SecretBackendId =
  | 'macos-keychain'
  | 'windows-dpapi'
  | 'linux-libsecret'
  | 'encrypted-file'
  | 'memory'

export interface SecretStoreCapabilities {
  /** Can enumerate stored key names. macOS Keychain cannot without prompting. */
  list: boolean
  /** Survives a reboot / is not process-local. */
  persistent: boolean
  /** Protected by the OS user session rather than a passphrase we manage. */
  osProtected: boolean
}

export interface SecretStore {
  readonly backend: SecretBackendId
  /** Human-readable, shown in `agentsync doctor`. */
  readonly description: string
  readonly capabilities: SecretStoreCapabilities
  /** Cheap probe. Must never prompt the user or block indefinitely. */
  isAvailable(): Promise<boolean>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  /** Returns false when the key was not present. */
  delete(key: string): Promise<boolean>
  /** Throws `SecretsNotSupportedError` when `capabilities.list` is false. */
  list(): Promise<string[]>
}

export class SecretsError extends Error {
  readonly backend: SecretBackendId
  override readonly cause: unknown
  constructor(message: string, backend: SecretBackendId, cause?: unknown) {
    super(message)
    this.name = 'SecretsError'
    this.backend = backend
    this.cause = cause
  }
}

export class SecretsNotSupportedError extends SecretsError {
  constructor(backend: SecretBackendId, operation: string) {
    super(`${backend} does not support ${operation}`, backend)
    this.name = 'SecretsNotSupportedError'
  }
}

// ---------------------------------------------------------------------------
// Injectable process runner
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  /** Written to the child's stdin and then closed. */
  input?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export type ExecFn = (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>

/**
 * `spawn` with no shell, ever. Secret values reach the child through argv or
 * stdin; a shell in between would expose them to word-splitting and, worse,
 * to shell history and command-line injection.
 */
export const nodeExec: ExecFn = (file, args, options = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            // A `secret-tool` call on a broken D-Bus setup blocks forever.
            // Killing it is the difference between "degrades to file" and
            // "the CLI hangs".
            child.kill('SIGKILL')
          }, options.timeoutMs)
        : undefined

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })

    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })

const DEFAULT_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// macOS Keychain
// ---------------------------------------------------------------------------

export interface KeychainOptions {
  service?: string
  exec?: ExecFn
  timeoutMs?: number
}

/**
 * Generic passwords in the login keychain via `/usr/bin/security`.
 *
 * Caveat, deliberately not hidden: `security add-generic-password -w <value>`
 * puts the secret in the child's argv, which is readable via `ps` by the same
 * user for the lifetime of the call. `security` has no stdin mode for `-w`, so
 * the alternatives are a native Security.framework binding or this. Same-user
 * `ps` visibility is the accepted trade-off (it is what the official
 * `security` docs and every JS keychain shim do); a different *user* cannot
 * read it, and that is the boundary that matters here.
 */
export class MacosKeychainStore implements SecretStore {
  readonly backend = 'macos-keychain' as const
  readonly description = 'macOS login Keychain (security(1) generic passwords)'
  readonly capabilities: SecretStoreCapabilities = { list: false, persistent: true, osProtected: true }

  private readonly service: string
  private readonly exec: ExecFn
  private readonly timeoutMs: number

  constructor(options: KeychainOptions = {}) {
    this.service = options.service ?? 'agentsync'
    this.exec = options.exec ?? nodeExec
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.exec('/usr/bin/security', ['list-keychains'], { timeoutMs: this.timeoutMs })
      return r.code === 0
    } catch {
      return false
    }
  }

  async get(key: string): Promise<string | null> {
    const r = await this.exec(
      '/usr/bin/security',
      ['find-generic-password', '-a', key, '-s', this.service, '-w'],
      { timeoutMs: this.timeoutMs },
    )
    if (r.code === 44 || /could not be found/i.test(r.stderr)) return null
    if (r.code !== 0) throw new SecretsError(`security find-generic-password failed: ${r.stderr.trim()}`, this.backend)
    // `-w` prints the password followed by a newline. Only strip that one.
    return r.stdout.replace(/\n$/, '')
  }

  async set(key: string, value: string): Promise<void> {
    // -U updates in place instead of failing on an existing item.
    const r = await this.exec(
      '/usr/bin/security',
      ['add-generic-password', '-a', key, '-s', this.service, '-U', '-w', value],
      { timeoutMs: this.timeoutMs },
    )
    if (r.code !== 0) throw new SecretsError(`security add-generic-password failed: ${r.stderr.trim()}`, this.backend)
  }

  async delete(key: string): Promise<boolean> {
    const r = await this.exec(
      '/usr/bin/security',
      ['delete-generic-password', '-a', key, '-s', this.service],
      { timeoutMs: this.timeoutMs },
    )
    if (r.code === 0) return true
    if (r.code === 44 || /could not be found/i.test(r.stderr)) return false
    throw new SecretsError(`security delete-generic-password failed: ${r.stderr.trim()}`, this.backend)
  }

  async list(): Promise<string[]> {
    // `security dump-keychain` prompts for authorization per item. Refusing is
    // better than triggering a wall of modal dialogs.
    throw new SecretsNotSupportedError(this.backend, 'list')
  }
}

// ---------------------------------------------------------------------------
// Windows DPAPI (via PowerShell, no native module)
// ---------------------------------------------------------------------------

export interface WindowsDpapiOptions {
  /** Directory for the DPAPI-protected blobs. Default `%LOCALAPPDATA%\agentsync\secrets`. */
  dir: string
  exec?: ExecFn
  timeoutMs?: number
  powershell?: string
  fs?: SecretFsOps
}

export interface SecretFsOps {
  readFile(p: string): Promise<Buffer>
  readdir(p: string): Promise<string[]>
  rm(p: string, opts: { force?: boolean }): Promise<void>
  mkdir(p: string, opts: { recursive: true }): Promise<string | undefined>
  writeFile(p: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>
}

export const nodeSecretFsOps: SecretFsOps = {
  readFile: (p) => fsp.readFile(p),
  readdir: (p) => fsp.readdir(p),
  rm: (p, opts) => fsp.rm(p, opts),
  mkdir: (p, opts) => fsp.mkdir(p, opts),
  writeFile: async (p, data, opts) => {
    await atomicWriteFile(p, data, opts?.mode !== undefined ? { mode: opts.mode } : {})
  },
}

/** Key name -> a filename that is safe on NTFS and reversible. */
export function encodeSecretFileName(key: string): string {
  return `${Buffer.from(key, 'utf8').toString('base64url')}.dpapi`
}
export function decodeSecretFileName(name: string): string | null {
  if (!name.endsWith('.dpapi')) return null
  try {
    return Buffer.from(name.slice(0, -'.dpapi'.length), 'base64url').toString('utf8')
  } catch {
    return null
  }
}

/**
 * DPAPI at CurrentUser scope through PowerShell's `ConvertFrom-SecureString` /
 * `ConvertTo-SecureString`, which are thin wrappers over
 * `CryptProtectData`/`CryptUnprotectData`.
 *
 * Why not Credential Manager: `cmdkey` can *store* a generic credential but
 * offers no way to read the password back, and `CredRead` requires P/Invoke.
 * DPAPI blobs give the same protection boundary (the user's login secret,
 * unreadable by other users) with no native dependency and no admin rights.
 *
 * The secret is passed on stdin, never argv — on Windows the full command line
 * of any process is readable by any process in the same session.
 *
 * Everything crossing the process boundary is base64, in both directions, and
 * that is not decoration. `[Console]::In` / `[Console]::Out` in Windows
 * PowerShell use `Console.InputEncoding` / `Console.OutputEncoding`, which
 * default to the console's OEM code page (437 on a US runner) — not UTF-8, and
 * not configurable from here without touching console handles that do not exist
 * when stdio is redirected. Writing the raw secret meant Node's UTF-8 bytes were
 * decoded as CP437 on the way in and re-encoded as CP437 on the way out, so any
 * non-ASCII secret came back mangled. Base64 is ASCII in every code page, so the
 * round trip is byte-exact regardless of the runner's locale.
 */
export class WindowsDpapiStore implements SecretStore {
  readonly backend = 'windows-dpapi' as const
  readonly description = 'Windows DPAPI (CurrentUser scope) blobs under %LOCALAPPDATA%'
  readonly capabilities: SecretStoreCapabilities = { list: true, persistent: true, osProtected: true }

  private readonly dir: string
  private readonly exec: ExecFn
  private readonly timeoutMs: number
  private readonly powershell: string
  private readonly fs: SecretFsOps

  constructor(options: WindowsDpapiOptions) {
    this.dir = options.dir
    this.exec = options.exec ?? nodeExec
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.powershell = options.powershell ?? 'powershell.exe'
    this.fs = options.fs ?? nodeSecretFsOps
  }

  private ps(script: string, input?: string): Promise<ExecResult> {
    return this.exec(
      this.powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeoutMs: this.timeoutMs, ...(input !== undefined ? { input } : {}) },
    )
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await this.ps('[Console]::Out.Write("ok")')
      return r.code === 0 && r.stdout.includes('ok')
    } catch {
      return false
    }
  }

  async get(key: string): Promise<string | null> {
    const file = path.join(this.dir, encodeSecretFileName(key))
    let blob: string
    try {
      blob = (await this.fs.readFile(file)).toString('utf8').trim()
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null
      throw err
    }
    // Round-trip the protected string back to plaintext. Marshal/ZeroFreeBSTR
    // is the documented way to read a SecureString without leaving copies.
    // The plaintext leaves as base64 so the console code page cannot touch it.
    const script = [
      '$e = [Console]::In.ReadToEnd().Trim();',
      '$ss = ConvertTo-SecureString -String $e;',
      '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss);',
      'try {',
      '$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b);',
      '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))',
      '}',
      'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
    ].join(' ')
    const r = await this.ps(script, blob)
    if (r.code !== 0) throw new SecretsError(`DPAPI unprotect failed: ${r.stderr.trim()}`, this.backend)
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
  }

  async set(key: string, value: string): Promise<void> {
    // The value arrives base64-encoded for the same reason it leaves that way
    // in get(): stdin is decoded with the OEM code page, not UTF-8.
    const script = [
      '$e = [Console]::In.ReadToEnd().Trim();',
      '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($e));',
      '$ss = ConvertTo-SecureString -String $p -AsPlainText -Force;',
      '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $ss))',
    ].join(' ')
    const r = await this.ps(script, Buffer.from(value, 'utf8').toString('base64'))
    if (r.code !== 0) throw new SecretsError(`DPAPI protect failed: ${r.stderr.trim()}`, this.backend)
    const blob = r.stdout.trim()
    if (blob.length === 0) throw new SecretsError('DPAPI protect returned an empty blob', this.backend)
    await this.fs.mkdir(this.dir, { recursive: true })
    await this.fs.writeFile(path.join(this.dir, encodeSecretFileName(key)), blob, { mode: 0o600 })
  }

  async delete(key: string): Promise<boolean> {
    const file = path.join(this.dir, encodeSecretFileName(key))
    try {
      await this.fs.readFile(file)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false
      throw err
    }
    await this.fs.rm(file, { force: true })
    return true
  }

  async list(): Promise<string[]> {
    try {
      const names = await this.fs.readdir(this.dir)
      return names
        .map(decodeSecretFileName)
        .filter((k): k is string => k !== null)
        .sort()
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return []
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Linux libsecret
// ---------------------------------------------------------------------------

export interface LibsecretOptions {
  service?: string
  exec?: ExecFn
  timeoutMs?: number
  binary?: string
}

/**
 * `secret-tool` (libsecret). Values go over stdin, which `secret-tool store`
 * explicitly supports — so unlike the macOS path, nothing lands in argv.
 */
export class LinuxLibsecretStore implements SecretStore {
  readonly backend = 'linux-libsecret' as const
  readonly description = 'Linux libsecret / Secret Service (secret-tool)'
  readonly capabilities: SecretStoreCapabilities = { list: true, persistent: true, osProtected: true }

  private readonly service: string
  private readonly exec: ExecFn
  private readonly timeoutMs: number
  private readonly binary: string

  constructor(options: LibsecretOptions = {}) {
    this.service = options.service ?? 'agentsync'
    this.exec = options.exec ?? nodeExec
    // Short: on a broken/absent D-Bus this call is the one that hangs.
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.binary = options.binary ?? 'secret-tool'
  }

  async isAvailable(): Promise<boolean> {
    try {
      // A lookup for a key that does not exist exits non-zero but proves the
      // daemon answered. A missing binary throws ENOENT; a dead bus times out.
      const r = await this.exec(
        this.binary,
        ['search', '--all', 'service', this.service],
        { timeoutMs: this.timeoutMs },
      )
      return r.code === 0 || r.code === 1
    } catch {
      return false
    }
  }

  async get(key: string): Promise<string | null> {
    const r = await this.exec(this.binary, ['lookup', 'service', this.service, 'account', key], {
      timeoutMs: this.timeoutMs,
    })
    if (r.code !== 0) return null
    // secret-tool lookup does not append a newline, but be tolerant.
    return r.stdout.replace(/\n$/, '')
  }

  async set(key: string, value: string): Promise<void> {
    const r = await this.exec(
      this.binary,
      ['store', '--label', `${this.service}: ${key}`, 'service', this.service, 'account', key],
      { input: value, timeoutMs: this.timeoutMs },
    )
    if (r.code !== 0) throw new SecretsError(`secret-tool store failed: ${r.stderr.trim()}`, this.backend)
  }

  async delete(key: string): Promise<boolean> {
    const existing = await this.get(key)
    if (existing === null) return false
    const r = await this.exec(this.binary, ['clear', 'service', this.service, 'account', key], {
      timeoutMs: this.timeoutMs,
    })
    if (r.code !== 0) throw new SecretsError(`secret-tool clear failed: ${r.stderr.trim()}`, this.backend)
    return true
  }

  async list(): Promise<string[]> {
    const r = await this.exec(this.binary, ['search', '--all', 'service', this.service], {
      timeoutMs: this.timeoutMs,
    })
    if (r.code !== 0) return []
    return parseSecretToolSearch(r.stdout).sort()
  }
}

/**
 * Pull `account` attribute values out of `secret-tool search --all` output,
 * which looks like:
 *
 *   [/org/freedesktop/secrets/collection/login/1]
 *   label = agentsync: token
 *   secret = ...
 *   created = ...
 *   attribute.service = agentsync
 *   attribute.account = token
 */
export function parseSecretToolSearch(stdout: string): string[] {
  const keys: string[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*attribute\.account\s*=\s*(.+?)\s*$/.exec(line)
    if (m && m[1] !== undefined) keys.push(m[1])
  }
  return [...new Set(keys)]
}

// ---------------------------------------------------------------------------
// Encrypted file fallback
// ---------------------------------------------------------------------------

export interface VaultKdfParams {
  algo: 'scrypt'
  N: number
  r: number
  p: number
  keyLen: number
  /** base64 */
  salt: string
}

export interface VaultFile {
  v: 1
  kdf: VaultKdfParams
  cipher: 'aes-256-gcm'
  /** base64 */
  iv: string
  /** base64 */
  tag: string
  /** base64 */
  ct: string
}

export interface EncryptedFileOptions {
  /** Vault file path, e.g. `<stateDir>/secrets.vault.json`. */
  file: string
  /**
   * Passphrase. Required. Read it from the environment (CI) or prompt once and
   * cache it in memory — never write it next to the vault.
   */
  passphrase: string
  fs?: SecretFsOps
  /** scrypt cost. Default N=2^15. Lower it only in tests. */
  scryptN?: number
}

const SCRYPT_DEFAULT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

/**
 * AES-256-GCM over a single JSON map, key derived with scrypt.
 *
 * Design notes worth defending in a review:
 *  - One vault rather than a file per secret: it hides *how many* secrets and
 *    which key names exist, which a directory listing would otherwise leak.
 *  - The KDF header is bound in as GCM additional authenticated data, so an
 *    attacker cannot rewrite `N` down to 2 and brute-force the passphrase
 *    against the same ciphertext.
 *  - The salt is per-vault and the IV is regenerated on *every* write. GCM
 *    catastrophically fails on IV reuse under the same key.
 */
export class EncryptedFileStore implements SecretStore {
  readonly backend = 'encrypted-file' as const
  readonly description: string
  readonly capabilities: SecretStoreCapabilities = { list: true, persistent: true, osProtected: false }

  private readonly file: string
  private readonly passphrase: string
  private readonly fs: SecretFsOps
  private readonly scryptN: number

  constructor(options: EncryptedFileOptions) {
    if (!options.passphrase) {
      throw new SecretsError('encrypted-file backend requires a passphrase', 'encrypted-file')
    }
    this.file = options.file
    this.passphrase = options.passphrase
    this.fs = options.fs ?? nodeSecretFsOps
    this.scryptN = options.scryptN ?? SCRYPT_DEFAULT_N
    this.description = `Encrypted file vault (scrypt + AES-256-GCM) at ${options.file}`
  }

  async isAvailable(): Promise<boolean> {
    return this.passphrase.length > 0
  }

  private async deriveKey(kdf: VaultKdfParams): Promise<Buffer> {
    if (kdf.algo !== 'scrypt') throw new SecretsError(`unsupported KDF ${String(kdf.algo)}`, this.backend)
    // maxmem must exceed 128 * N * r or scrypt refuses to run.
    const maxmem = 256 * kdf.N * kdf.r + 1024 * 1024
    return scrypt(this.passphrase, Buffer.from(kdf.salt, 'base64'), kdf.keyLen, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem,
    })
  }

  private aad(vault: Pick<VaultFile, 'v' | 'kdf' | 'cipher'>): Buffer {
    return Buffer.from(canonicalJson({ v: vault.v, kdf: vault.kdf, cipher: vault.cipher }), 'utf8')
  }

  private async readVault(): Promise<Record<string, string>> {
    let raw: Buffer
    try {
      raw = await this.fs.readFile(this.file)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return {}
      throw err
    }

    let vault: VaultFile
    try {
      vault = JSON.parse(raw.toString('utf8')) as VaultFile
    } catch (err) {
      throw new SecretsError(`vault ${this.file} is not valid JSON`, this.backend, err)
    }
    if (vault.v !== 1 || vault.cipher !== 'aes-256-gcm') {
      throw new SecretsError(`unsupported vault format in ${this.file}`, this.backend)
    }

    const key = await this.deriveKey(vault.kdf)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.iv, 'base64'))
    decipher.setAAD(this.aad(vault))
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'))
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(vault.ct, 'base64')), decipher.final()])
      return JSON.parse(plain.toString('utf8')) as Record<string, string>
    } catch (err) {
      // GCM tag mismatch. Indistinguishable — on purpose — between a wrong
      // passphrase and a tampered file.
      throw new SecretsError(
        `could not decrypt ${this.file}: wrong passphrase or the vault has been modified`,
        this.backend,
        err,
      )
    }
  }

  private async writeVault(entries: Record<string, string>): Promise<void> {
    const kdf: VaultKdfParams = {
      algo: 'scrypt',
      N: this.scryptN,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLen: KEY_LEN,
      salt: randomBytes(16).toString('base64'),
    }
    const key = await this.deriveKey(kdf)
    const iv = randomBytes(12)
    const header = { v: 1 as const, kdf, cipher: 'aes-256-gcm' as const }
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(this.aad(header))
    const ct = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(entries), 'utf8')),
      cipher.final(),
    ])
    const vault: VaultFile = {
      ...header,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    }
    await this.fs.mkdir(path.dirname(this.file), { recursive: true })
    await this.fs.writeFile(this.file, canonicalJson(vault), { mode: 0o600 })
  }

  async get(key: string): Promise<string | null> {
    const entries = await this.readVault()
    return Object.prototype.hasOwnProperty.call(entries, key) ? (entries[key] as string) : null
  }

  async set(key: string, value: string): Promise<void> {
    const entries = await this.readVault()
    entries[key] = value
    await this.writeVault(entries)
  }

  async delete(key: string): Promise<boolean> {
    const entries = await this.readVault()
    if (!Object.prototype.hasOwnProperty.call(entries, key)) return false
    delete entries[key]
    await this.writeVault(entries)
    return true
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.readVault()).sort()
  }

  /** Re-encrypt under a new passphrase. Rotation without re-entering secrets. */
  async rekey(newPassphrase: string): Promise<void> {
    const entries = await this.readVault()
    const next = new EncryptedFileStore({
      file: this.file,
      passphrase: newPassphrase,
      fs: this.fs,
      scryptN: this.scryptN,
    })
    await next.writeVault(entries)
  }
}

/** Constant-time compare, exported because callers keep reaching for `===`. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ---------------------------------------------------------------------------
// In-memory (tests, --dry-run)
// ---------------------------------------------------------------------------

export class MemorySecretStore implements SecretStore {
  readonly backend = 'memory' as const
  readonly description = 'In-memory only (not persisted)'
  readonly capabilities: SecretStoreCapabilities = { list: true, persistent: false, osProtected: false }
  private readonly map = new Map<string, string>()

  async isAvailable(): Promise<boolean> {
    return true
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()].sort()
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface BackendProbe {
  backend: SecretBackendId
  available: boolean
  reason?: string
}

export interface SecretBackendSelection {
  store: SecretStore
  chosen: SecretBackendId
  /** Every backend considered, in preference order, with why it was skipped. */
  attempted: BackendProbe[]
  /** True when we fell back off the OS-protected backend for this host. */
  degraded: boolean
}

export interface SelectSecretStoreOptions {
  /** Namespace for keychain/libsecret items. Default `agentsync`. */
  service?: string
  /** Vault path for the encrypted-file fallback. */
  vaultFile?: string
  /** Directory for DPAPI blobs on Windows. */
  dpapiDir?: string
  /** Passphrase for the encrypted-file fallback; usually from env. */
  passphrase?: string
  /** Force a specific backend (`AGENTSYNC_SECRET_BACKEND`). Skips probing others. */
  force?: SecretBackendId
  /** Permit the non-persistent memory store as a last resort. Default false. */
  allowMemory?: boolean
  exec?: ExecFn
  fs?: SecretFsOps
  scryptN?: number
}

export class NoSecretBackendError extends Error {
  readonly attempted: BackendProbe[]
  constructor(attempted: BackendProbe[]) {
    super(
      `no usable secret backend. Tried: ${attempted
        .map((a) => `${a.backend} (${a.available ? 'available' : (a.reason ?? 'unavailable')})`)
        .join('; ')}. ` +
        'Set a passphrase (AGENTSYNC_VAULT_PASSPHRASE) to enable the encrypted-file fallback.',
    )
    this.name = 'NoSecretBackendError'
    this.attempted = attempted
  }
}

function candidateOrder(host: HostEnv): SecretBackendId[] {
  switch (host.os) {
    case 'macos':
      return ['macos-keychain', 'encrypted-file']
    case 'windows':
      return ['windows-dpapi', 'encrypted-file']
    case 'linux':
      // WSL almost never has a working Secret Service; probing is cheap and
      // the timeout in LinuxLibsecretStore keeps a broken bus from hanging us.
      return ['linux-libsecret', 'encrypted-file']
    default:
      return ['encrypted-file']
  }
}

/**
 * Pick the best backend this host can actually use, and report the whole
 * decision so `doctor` can explain it.
 */
export async function selectSecretStore(
  host: HostEnv,
  options: SelectSecretStoreOptions = {},
): Promise<SecretBackendSelection> {
  const attempted: BackendProbe[] = []

  const build = (id: SecretBackendId): SecretStore | null => {
    switch (id) {
      case 'macos-keychain':
        return new MacosKeychainStore({
          ...(options.service !== undefined ? { service: options.service } : {}),
          ...(options.exec ? { exec: options.exec } : {}),
        })
      case 'windows-dpapi': {
        const dir = options.dpapiDir
        if (!dir) return null
        return new WindowsDpapiStore({
          dir,
          ...(options.exec ? { exec: options.exec } : {}),
          ...(options.fs ? { fs: options.fs } : {}),
        })
      }
      case 'linux-libsecret':
        return new LinuxLibsecretStore({
          ...(options.service !== undefined ? { service: options.service } : {}),
          ...(options.exec ? { exec: options.exec } : {}),
        })
      case 'encrypted-file': {
        if (!options.vaultFile || !options.passphrase) return null
        return new EncryptedFileStore({
          file: options.vaultFile,
          passphrase: options.passphrase,
          ...(options.fs ? { fs: options.fs } : {}),
          ...(options.scryptN !== undefined ? { scryptN: options.scryptN } : {}),
        })
      }
      case 'memory':
        return new MemorySecretStore()
      default:
        return null
    }
  }

  const order = options.force ? [options.force] : candidateOrder(host)
  const preferred = order[0]

  for (const id of order) {
    // hasKeyring is the probed truth from detectHost: headless Linux with no
    // D-Bus reports false and we skip libsecret without paying its timeout.
    if (!host.hasKeyring && id !== 'encrypted-file' && id !== 'memory' && !options.force) {
      attempted.push({ backend: id, available: false, reason: 'host reports no keyring' })
      continue
    }

    const store = build(id)
    if (!store) {
      attempted.push({
        backend: id,
        available: false,
        reason: id === 'encrypted-file' ? 'no passphrase or vault path configured' : 'not configured for this host',
      })
      continue
    }

    let available = false
    let reason: string | undefined
    try {
      available = await store.isAvailable()
      if (!available) reason = 'probe failed'
    } catch (err) {
      available = false
      reason = err instanceof Error ? err.message : String(err)
    }

    attempted.push({ backend: id, available, ...(reason !== undefined ? { reason } : {}) })
    if (available) {
      return { store, chosen: id, attempted, degraded: id !== preferred }
    }
  }

  if (options.allowMemory) {
    attempted.push({ backend: 'memory', available: true, reason: 'explicitly allowed' })
    return { store: new MemorySecretStore(), chosen: 'memory', attempted, degraded: true }
  }

  throw new NoSecretBackendError(attempted)
}
