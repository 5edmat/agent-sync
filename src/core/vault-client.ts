/**
 * `VaultClient`, for real.
 *
 * Read `vault.ts` first — it is the contract and the threat model. This file
 * implements it and records the three places where implementing it forced a
 * decision the contract did not already make.
 *
 * ---------------------------------------------------------------------------
 * 1. EVERY DEK WRAP IS A SEALED BOX, INCLUDING THE PASSPHRASE ONE
 * ---------------------------------------------------------------------------
 * The obvious construction is: passphrase -> Argon2id -> root key, AES-GCM the
 * DEK under it. That construction cannot revoke a device. `revokeDevice` is
 * handed an `UnlockedVault` — a DEK and an epoch — and has to rotate the DEK
 * and re-wrap it to *every* remaining holder. Devices are fine, because a
 * device is an X25519 public key and anybody can encrypt to a public key. The
 * passphrase and the recovery code are not: re-wrapping to them would need the
 * passphrase or the code itself, which `revokeDevice` does not have and should
 * not ask for. "Revoke my stolen laptop from my phone" would be impossible.
 *
 * So all three slots are asymmetric. The passphrase derives an X25519 identity
 * (Argon2id -> root key -> HKDF -> scalar) instead of a symmetric wrapping
 * key, and the recovery code derives one the same way. Each slot's *public*
 * key is recorded in its blob's AAD, which is authenticated plaintext. Rotation
 * then needs nothing but the public keys already in the record.
 *
 * Does publishing pub(f(passphrase)) weaken the passphrase? No. An offline
 * attacker with the record can already test a candidate passphrase by trial
 * decryption; now they can test it by comparing 32 bytes instead. Both cost one
 * Argon2id, which is the entire defence and is unchanged. What it buys is worth
 * more: the client can tell a wrong passphrase from a corrupted record, which
 * is the difference between "check your typing" and "your server is lying to
 * you" (see 3).
 *
 * ---------------------------------------------------------------------------
 * 2. AAD IS THE ONLY PLACE THE CONTRACT LEFT FOR BINDING METADATA
 * ---------------------------------------------------------------------------
 * `SealedBlob` has four fields and no room for a recipient key, an ephemeral
 * key or a slot name, and the contract is explicit that its shape is not up for
 * redesign. `aad` is authenticated-but-not-encrypted by construction, so that
 * is where the binding goes, in one canonical form that is re-derived and
 * compared on every open:
 *
 *   agentsync-vault/v1|vault=<id>|slot=passphrase|epoch=<n>|key=<b64>
 *   agentsync-vault/v1|vault=<id>|slot=recovery|epoch=<n>|key=<b64>
 *   agentsync-vault/v1|vault=<id>|slot=device|device=<id>|epoch=<n>|key=<b64>
 *   agentsync-vault/v1|vault=<id>|slot=secret|ref=<ref>|epoch=<n>
 *
 * Enforcement is the part that matters. Passing `blob.aad` to GCM proves only
 * that the blob still carries the AAD it was sealed with — a server that moves
 * a whole blob from `github.token` to `stripe.key` passes that check. So the
 * expected AAD is rebuilt from the caller's own (ref, epoch, vaultId) and
 * compared to the stored string before it is used; a blob that arrives in the
 * wrong slot is rejected on the mismatch, never on the tag.
 *
 * The ephemeral public key rides at the front of `ciphertextB64`, sealed-box
 * style, and is bound into the HKDF salt, so rewriting it changes the key and
 * the tag stops verifying.
 *
 * ---------------------------------------------------------------------------
 * 3. FAILURE MODES ARE DISTINGUISHABLE HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 * `VaultError.code` separates wrong-passphrase from tampered-ciphertext from
 * wrong-epoch from unknown-device, because a user who cannot tell those apart
 * cannot act on any of them. That resolution is safe only because it is
 * computed on the device from evidence the device already has, and it must
 * stay there: never send a code, a message or a retry count to the server. The
 * server learns nothing from a failed unlock because nothing is sent.
 *
 * Timing does not leak the distinction either. Every unlock path runs the full
 * KDF and then attempts the AEAD open unconditionally, deciding which code to
 * raise only after both have happened, so the wrong-passphrase path and the
 * tampered-record path do the same work.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS STILL DOES NOT PROTECT AGAINST
 * ---------------------------------------------------------------------------
 * Rollback. Every blob is bound to its ref and epoch, so the server cannot
 * forge, swap or downgrade one — but it can serve an *older, genuine* record
 * for the current epoch and the client will accept it, because nothing here
 * signs "this is the newest version". Closing that needs a monotonic counter
 * signed by a device key, which is a control-plane change, not a vault one.
 *
 * And the honest limit `revokeDevice` already documents: rotation protects
 * future writes. A secret the revoked device decrypted is known to it forever.
 * Rotate it at the source.
 */

import {
  aeadOpen,
  aeadSeal,
  assertUsableX25519PublicKey,
  constantTimeEqual,
  constantTimeEqualString,
  CryptoError,
  fromBase64,
  fromUtf8,
  generateX25519KeyPair,
  hkdfSha256,
  newId,
  openSealed,
  randomBytes,
  sealTo,
  toBase64,
  utf8,
  x25519PublicFromPrivate,
  zeroize,
  argon2id,
  ARGON2ID_OWASP_FLOOR,
  type SealedBox,
} from '../platform/crypto.js'
import type {
  DeviceWrappedDek,
  KdfParams,
  KeyEpoch,
  SealedBlob,
  SealedSecret,
  ServerVaultRecord,
  UnlockedVault,
  Vault,
  VaultClient,
} from './vault.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every way an operation can fail, as a code the UI can branch on.
 *
 * LOCAL ONLY. See the header: these must not cross the network, appear in
 * telemetry, or be echoed to the control plane.
 */
export type VaultErrorCode =
  /** The passphrase does not derive this vault's passphrase identity. */
  | 'BAD_PASSPHRASE'
  /** The recovery code is well-formed but is not this vault's. */
  | 'BAD_RECOVERY_CODE'
  /** The recovery code failed its own checksum — almost always a typo. */
  | 'MALFORMED_RECOVERY_CODE'
  /** No wrapped DEK in this vault is addressed to that device key. */
  | 'UNKNOWN_DEVICE'
  /** AEAD tag rejected the ciphertext. Someone changed the bytes. */
  | 'TAMPERED'
  /** The blob is authentic but arrived in a slot it was not sealed for. */
  | 'AAD_MISMATCH'
  /** Right vault, wrong DEK generation — usually a stale copy after revocation. */
  | 'EPOCH_MISMATCH'
  /** The unlocked handle belongs to a different vault. */
  | 'VAULT_MISMATCH'
  /** The handle has been locked and its DEK zeroed. */
  | 'LOCKED'
  | 'VAULT_NOT_FOUND'
  | 'DEVICE_NOT_FOUND'
  | 'DUPLICATE_DEVICE'
  | 'INVALID_REF'
  | 'INVALID_DEVICE_ID'
  | 'INVALID_PUBLIC_KEY'
  | 'INVALID_PASSPHRASE'
  /** The stored record is structurally unusable — bad base64, unknown algorithm. */
  | 'MALFORMED_RECORD'
  /** `upgradeKdf` was asked to move to parameters that are not stronger. */
  | 'WEAK_KDF'
  /**
   * The caller asked for a KDF this client cannot run. Deliberately distinct
   * from MALFORMED_RECORD: "fix your call" and "your server sent you a broken
   * record" are different emergencies.
   */
  | 'UNSUPPORTED_KDF'
  /** `upgradeKdf` needs the passphrase, so it needs a passphrase unlock. */
  | 'KDF_UPGRADE_REQUIRES_PASSPHRASE'

export class VaultError extends Error {
  readonly code: VaultErrorCode
  constructor(code: VaultErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'VaultError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Where wrapped keys and ciphertext live between operations.
 *
 * `revokeDevice` and `upgradeKdf` are declared as `(unlocked, ...) => Vault`,
 * with no vault argument, so the client has to be able to find the record and
 * every sealed secret by itself. Hence an injected store rather than a pure
 * function. Everything that crosses this interface is already sealed; a store
 * implementation backed by the control plane is a `ServerVaultRecord` in and
 * out, which is exactly the boundary the contract wanted to be reviewable.
 */
export interface VaultStore {
  loadVault(vaultId: string): Promise<Vault | undefined>
  saveVault(vault: Vault): Promise<void>
  listSecrets(vaultId: string): Promise<SealedSecret[]>
  putSecret(vaultId: string, secret: SealedSecret): Promise<void>
}

/** Assemble the server's view. Nothing here has ever seen a plaintext. */
export function toServerVaultRecord(vault: Vault, secrets: readonly SealedSecret[]): ServerVaultRecord {
  return {
    vaultId: vault.vaultId,
    epoch: vault.epoch,
    kdf: vault.kdf,
    passphraseWrappedDek: vault.passphraseWrappedDek,
    deviceWrappedDeks: vault.deviceWrappedDeks,
    recoveryWrappedDek: vault.recoveryWrappedDek,
    secrets: [...secrets],
  }
}

export interface InMemoryVaultStore extends VaultStore {
  /** The server's view, for tests and for pushing to the control plane. */
  serverRecord(vaultId: string): ServerVaultRecord | undefined
}

/** Deep-copies on the way in and out, so a caller cannot mutate stored state. */
export function createInMemoryVaultStore(): InMemoryVaultStore {
  const vaults = new Map<string, Vault>()
  const secrets = new Map<string, Map<string, SealedSecret>>()
  return {
    async loadVault(vaultId) {
      const v = vaults.get(vaultId)
      return v ? structuredClone(v) : undefined
    },
    async saveVault(vault) {
      vaults.set(vault.vaultId, structuredClone(vault))
    },
    async listSecrets(vaultId) {
      return [...(secrets.get(vaultId)?.values() ?? [])].map((s) => structuredClone(s))
    },
    async putSecret(vaultId, secret) {
      let bucket = secrets.get(vaultId)
      if (!bucket) {
        bucket = new Map()
        secrets.set(vaultId, bucket)
      }
      bucket.set(secret.ref, structuredClone(secret))
    },
    serverRecord(vaultId) {
      const v = vaults.get(vaultId)
      if (!v) return undefined
      return toServerVaultRecord(structuredClone(v), [...(secrets.get(vaultId)?.values() ?? [])])
    },
  }
}

// ---------------------------------------------------------------------------
// Recovery code
// ---------------------------------------------------------------------------

/**
 * 160 bits, in 32 characters, plus a 20-bit checksum.
 *
 * WHY 160 AND NOT 128. The recovery code is the only credential with no second
 * factor and no KDF in front of it. It cannot have one: a KDF needs a stored
 * salt and cost parameters, and an attacker holding the server record controls
 * both, so any stretching here is stretching the attacker chose. That is fine
 * *provided the code itself carries the whole burden*, which is the trade this
 * makes — the code is generated by us from a CSPRNG, never chosen by a human,
 * and 160 bits is beyond exhaustion by any adversary that will ever exist
 * (2^160 is roughly the number of atoms in the Earth, squared). 128 would also
 * be beyond reach today; 160 costs the user eight more characters they will
 * paste from a password manager and removes the argument entirely.
 *
 * Crockford's alphabet drops I, L, O and U, and decoding folds I/L to 1 and O
 * to 0, because this is the one string in the product a human transcribes by
 * hand, possibly years later, possibly from paper.
 */
const RECOVERY_ENTROPY_BYTES = 20
const RECOVERY_CHARS = 32
const RECOVERY_CHECKSUM_CHARS = 4
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD.charAt((acc >>> bits) & 31)
    }
  }
  if (bits > 0) out += CROCKFORD.charAt((acc << (5 - bits)) & 31)
  return out
}

function base32Decode(chars: string): Uint8Array | undefined {
  const out = new Uint8Array(Math.floor((chars.length * 5) / 8))
  let acc = 0
  let bits = 0
  let at = 0
  for (const ch of chars) {
    const idx = CROCKFORD.indexOf(ch)
    if (idx < 0) return undefined
    acc = (acc << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[at++] = (acc >>> bits) & 0xff
    }
  }
  return out
}

/** Not a security control — a transcription check, so typos say "typo". */
function recoveryChecksum(payload: Uint8Array): string {
  return base32Encode(hkdfSha256(payload, utf8('agentsync/vault/recovery-checksum/v1'), 'checksum', 3))
    .slice(0, RECOVERY_CHECKSUM_CHARS)
}

function formatRecoveryCode(payload: Uint8Array): string {
  const body = base32Encode(payload) + recoveryChecksum(payload)
  return (body.match(/.{1,4}/g) ?? []).join('-')
}

function generateRecoveryCode(): { code: string; payload: Uint8Array } {
  const payload = randomBytes(RECOVERY_ENTROPY_BYTES)
  return { code: formatRecoveryCode(payload), payload }
}

/**
 * Normalise and validate a code a human typed. Folds case and the ambiguous
 * glyph pairs, ignores any grouping the user did or did not reproduce.
 */
function decodeRecoveryCode(code: string): Uint8Array {
  const normalized = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')

  if (normalized.length !== RECOVERY_CHARS + RECOVERY_CHECKSUM_CHARS) {
    throw new VaultError('MALFORMED_RECOVERY_CODE', 'recovery code is the wrong length')
  }
  const payload = base32Decode(normalized.slice(0, RECOVERY_CHARS))
  if (!payload) {
    throw new VaultError('MALFORMED_RECOVERY_CODE', 'recovery code contains characters that are not in the alphabet')
  }
  if (!constantTimeEqualString(recoveryChecksum(payload), normalized.slice(RECOVERY_CHARS))) {
    zeroize(payload)
    throw new VaultError('MALFORMED_RECOVERY_CODE', 'recovery code failed its checksum — check for a mistyped character')
  }
  return payload
}

// ---------------------------------------------------------------------------
// AAD
// ---------------------------------------------------------------------------

const AAD_VERSION = 'agentsync-vault/v1'
type SlotKind = 'passphrase' | 'recovery' | 'device'

/**
 * Refs and device ids appear unescaped inside the AAD, so their charset is a
 * security control: a ref containing `|` or `=` could forge a different
 * binding. This is the contract's own ref charset (`SECRET_REF_PATTERN`), and
 * a superset of the product's UUID device ids.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,256}$/

function slotAad(vaultId: string, slot: SlotKind, epoch: KeyEpoch, keyB64: string, deviceId?: string): string {
  const device = slot === 'device' ? `|device=${deviceId as string}` : ''
  return `${AAD_VERSION}|vault=${vaultId}|slot=${slot}${device}|epoch=${epoch}|key=${keyB64}`
}

function secretAad(vaultId: string, ref: string, epoch: KeyEpoch): string {
  return `${AAD_VERSION}|vault=${vaultId}|slot=secret|ref=${ref}|epoch=${epoch}`
}

interface ParsedSlotAad {
  vaultId: string
  slot: SlotKind
  deviceId?: string
  epoch: KeyEpoch
  keyB64: string
}

/**
 * Parse a slot AAD, then prove the parse by re-serialising and demanding the
 * exact original string. Anything with a duplicated field, an odd separator or
 * a stray suffix fails, so the parser can never disagree with the builder.
 */
function failAad(): never {
  throw new VaultError('MALFORMED_RECORD', 'wrapped key is not bound by a recognisable AAD')
}

function parseSlotAad(aad: string): ParsedSlotAad {
  const parts = aad.split('|')
  if (parts[0] !== AAD_VERSION) failAad()

  const fields = new Map<string, string>()
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq < 1) failAad()
    const key = part.slice(0, eq)
    if (fields.has(key)) failAad()
    fields.set(key, part.slice(eq + 1))
  }

  const slot = fields.get('slot')
  if (slot !== 'passphrase' && slot !== 'recovery' && slot !== 'device') failAad()
  const vaultId = fields.get('vault')
  const keyB64 = fields.get('key')
  const epochRaw = fields.get('epoch')
  if (vaultId === undefined || keyB64 === undefined || epochRaw === undefined) failAad()
  if (!/^\d+$/.test(epochRaw)) failAad()
  const deviceId = fields.get('device')
  if ((slot === 'device') !== (deviceId !== undefined)) failAad()

  const parsed: ParsedSlotAad = {
    vaultId,
    slot,
    epoch: Number(epochRaw),
    keyB64,
    ...(deviceId === undefined ? {} : { deviceId }),
  }
  if (slotAad(parsed.vaultId, parsed.slot, parsed.epoch, parsed.keyB64, parsed.deviceId) !== aad) failAad()
  return parsed
}

// ---------------------------------------------------------------------------
// Blob conversion
// ---------------------------------------------------------------------------

function toSealedBlob(box: SealedBox, aad: string): SealedBlob {
  return {
    algorithm: 'aes-256-gcm',
    ciphertextB64: toBase64(box.body),
    ivB64: toBase64(box.iv),
    tagB64: toBase64(box.tag),
    aad,
  }
}

function fromSealedBlob(blob: SealedBlob): SealedBox {
  if (blob.algorithm !== 'aes-256-gcm') {
    throw new VaultError('MALFORMED_RECORD', `unsupported blob algorithm ${String(blob.algorithm)}`)
  }
  try {
    return {
      body: fromBase64(blob.ciphertextB64, 'ciphertext'),
      iv: fromBase64(blob.ivB64, 'iv'),
      tag: fromBase64(blob.tagB64, 'tag'),
    }
  } catch (err) {
    throw new VaultError('MALFORMED_RECORD', 'sealed blob is not decodable', { cause: err })
  }
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const DEK_BYTES = 32
const KDF_SALT_BYTES = 16

function kdfSalt(kdf: KdfParams): Uint8Array {
  let salt: Uint8Array
  try {
    salt = fromBase64(kdf.saltB64, 'kdf salt')
  } catch (err) {
    throw new VaultError('MALFORMED_RECORD', 'kdf salt is not decodable', { cause: err })
  }
  if (kdf.algorithm !== 'argon2id') {
    throw new VaultError('MALFORMED_RECORD', `unsupported kdf algorithm ${String(kdf.algorithm)}`)
  }
  if (salt.length < 8) throw new VaultError('MALFORMED_RECORD', 'kdf salt is too short')
  return salt
}

/**
 * passphrase -> Argon2id -> root key -> HKDF -> X25519 scalar.
 *
 * The root key is never stored and never leaves this function; only the public
 * half of what it derives is recorded, in the AAD.
 */
function passphraseIdentity(passphrase: Uint8Array, kdf: KdfParams): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const salt = kdfSalt(kdf)
  let root: Uint8Array | undefined
  try {
    root = argon2id(passphrase, salt, {
      memoryKiB: kdf.memoryKiB,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      tagLength: 32,
    })
    const privateKey = hkdfSha256(root, salt, 'agentsync/vault/passphrase-identity/v1')
    return { privateKey, publicKey: x25519PublicFromPrivate(privateKey) }
  } finally {
    zeroize(root)
  }
}

/**
 * No Argon2id here, deliberately: the code is 160 CSPRNG bits, so there is
 * nothing to stretch and stretching would only slow the legitimate user.
 */
function recoveryIdentity(payload: Uint8Array, vaultId: string): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = hkdfSha256(payload, utf8(vaultId), 'agentsync/vault/recovery-identity/v1')
  return { privateKey, publicKey: x25519PublicFromPrivate(privateKey) }
}

/**
 * Per-ref subkey rather than the DEK itself.
 *
 * Not the control that stops blobs being swapped between refs — the AAD check
 * in `openSecret` is, and it fires first. This is about key-usage limits:
 * AES-GCM with random 96-bit IVs starts to accumulate collision risk in the
 * neighbourhood of 2^32 encryptions under one key, and a single DEK covering
 * every secret in a long-lived vault is the one place that could plausibly be
 * approached. A subkey per ref caps it at "how often was this one secret
 * rotated", which is a number in the tens.
 */
function secretKey(dek: Uint8Array, ref: string): Uint8Array {
  return hkdfSha256(dek, utf8(ref), 'agentsync/vault/secret/v1')
}

// ---------------------------------------------------------------------------
// Device pairing helper
// ---------------------------------------------------------------------------

export interface DeviceKeyPair {
  /** Give this to `enrollDevice`. Public, safe to send anywhere. */
  publicKeyB64: string
  /** NEVER leaves the device. Store it in the OS keychain, not in the vault. */
  privateKey: Uint8Array
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateX25519KeyPair()
  return { publicKeyB64: toBase64(publicKey), privateKey }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface VaultClientOptions {
  store: VaultStore
  /**
   * KDF cost for vaults created by this client. Defaults to the OWASP floor
   * the contract quotes. Lower it only in tests — and the type will still say
   * argon2id, because it will still be argon2id.
   */
  kdf?: Omit<KdfParams, 'saltB64'>
  now?: () => Date
}

/**
 * Per-unlock state that is NOT part of `UnlockedVault`.
 *
 * `upgradeKdf(unlocked, params)` has to re-derive the root key under the new
 * cost, which needs the passphrase itself — a derived key cannot be re-stretched
 * into a different Argon2id output. The contract gives it no passphrase
 * argument, so a passphrase unlock keeps a copy here for the life of the
 * session, held as bytes (zeroable) rather than as the caller's string (not).
 * Any other unlock path leaves this empty and `upgradeKdf` refuses with
 * KDF_UPGRADE_REQUIRES_PASSPHRASE rather than silently doing something weaker.
 *
 * A WeakMap keyed on the handle: nothing is added to `UnlockedVault`, and the
 * entry becomes unreachable when the handle does.
 */
interface UnlockSession {
  passphrase?: Uint8Array
}

export class LocalVaultClient implements VaultClient {
  private readonly store: VaultStore
  private readonly defaultKdf: Omit<KdfParams, 'saltB64'>
  private readonly now: () => Date
  private readonly sessions = new WeakMap<UnlockedVault, UnlockSession>()

  constructor(options: VaultClientOptions) {
    this.store = options.store
    this.defaultKdf = options.kdf ?? { algorithm: 'argon2id', ...ARGON2ID_OWASP_FLOOR }
    this.now = options.now ?? (() => new Date())
  }

  // -- lifecycle ------------------------------------------------------------

  async create(passphrase: string): Promise<{ vault: Vault; recoveryCode: string }> {
    assertPassphrase(passphrase)
    const vaultId = newId()
    const epoch = 1
    const kdf: KdfParams = { ...this.defaultKdf, saltB64: toBase64(randomBytes(KDF_SALT_BYTES)) }

    const dek = randomBytes(DEK_BYTES)
    const passBytes = utf8(passphrase)
    const recovery = generateRecoveryCode()
    let passIdentity: { publicKey: Uint8Array; privateKey: Uint8Array } | undefined
    let recoveryKeys: { publicKey: Uint8Array; privateKey: Uint8Array } | undefined
    try {
      passIdentity = passphraseIdentity(passBytes, kdf)
      recoveryKeys = recoveryIdentity(recovery.payload, vaultId)

      const vault: Vault = {
        vaultId,
        epoch,
        kdf,
        passphraseWrappedDek: wrapDek(dek, passIdentity.publicKey, vaultId, 'passphrase', epoch),
        deviceWrappedDeks: [],
        recoveryWrappedDek: wrapDek(dek, recoveryKeys.publicKey, vaultId, 'recovery', epoch),
        createdAt: this.now().toISOString(),
      }
      await this.store.saveVault(vault)
      return { vault, recoveryCode: recovery.code }
    } finally {
      // The recovery code string itself is the caller's problem — it has to be
      // shown to a human, and JavaScript strings cannot be wiped. Everything
      // that CAN be wiped is.
      zeroize(dek, passBytes, recovery.payload, passIdentity?.privateKey, recoveryKeys?.privateKey)
    }
  }

  /**
   * Zero the DEK and drop the session. After this the handle is inert and every
   * operation on it raises LOCKED.
   */
  lock(unlocked: UnlockedVault): void {
    const session = this.sessions.get(unlocked)
    if (session) {
      zeroize(session.passphrase)
      this.sessions.delete(unlocked)
    }
    zeroize(unlocked.dek)
  }

  // -- unlock ---------------------------------------------------------------

  async unlockWithPassphrase(vault: Vault, passphrase: string): Promise<UnlockedVault> {
    assertPassphrase(passphrase)
    const passBytes = utf8(passphrase)
    const identity = passphraseIdentity(passBytes, vault.kdf)
    try {
      const dek = unwrapDek(
        identity.privateKey,
        identity.publicKey,
        vault.passphraseWrappedDek,
        vault.vaultId,
        'passphrase',
        vault.epoch,
        'BAD_PASSPHRASE',
      )
      const unlocked: UnlockedVault = { vaultId: vault.vaultId, epoch: vault.epoch, dek }
      this.sessions.set(unlocked, { passphrase: passBytes })
      return unlocked
    } catch (err) {
      zeroize(passBytes)
      throw err
    } finally {
      zeroize(identity.privateKey)
    }
  }

  async unlockWithDeviceKey(vault: Vault, devicePrivateKey: Uint8Array): Promise<UnlockedVault> {
    let publicKey: Uint8Array
    try {
      publicKey = x25519PublicFromPrivate(devicePrivateKey)
    } catch (err) {
      throw new VaultError('INVALID_PUBLIC_KEY', 'device private key is not a valid x25519 key', { cause: err })
    }
    const publicKeyB64 = toBase64(publicKey)

    // Scan every entry rather than returning on the first hit: which device a
    // key belongs to is not worth leaking through timing, and the list is tiny.
    let match: DeviceWrappedDek | undefined
    for (const wrapped of vault.deviceWrappedDeks) {
      const parsed = parseSlotAad(wrapped.sealed.aad)
      if (parsed.slot === 'device' && constantTimeEqualString(parsed.keyB64, publicKeyB64)) match = wrapped
    }
    if (!match) {
      throw new VaultError(
        'UNKNOWN_DEVICE',
        'this device is not enrolled in the vault (or its enrolment was revoked)',
      )
    }
    if (match.epoch !== vault.epoch) {
      throw new VaultError(
        'EPOCH_MISMATCH',
        `this device holds a key for epoch ${match.epoch} but the vault is at epoch ${vault.epoch}`,
      )
    }

    const dek = unwrapDek(
      devicePrivateKey,
      publicKey,
      match.sealed,
      vault.vaultId,
      'device',
      vault.epoch,
      'UNKNOWN_DEVICE',
      match.deviceId,
    )
    const unlocked: UnlockedVault = { vaultId: vault.vaultId, epoch: vault.epoch, dek }
    this.sessions.set(unlocked, {})
    return unlocked
  }

  async unlockWithRecoveryCode(vault: Vault, recoveryCode: string): Promise<UnlockedVault> {
    const payload = decodeRecoveryCode(recoveryCode)
    const identity = recoveryIdentity(payload, vault.vaultId)
    try {
      const dek = unwrapDek(
        identity.privateKey,
        identity.publicKey,
        vault.recoveryWrappedDek,
        vault.vaultId,
        'recovery',
        vault.epoch,
        'BAD_RECOVERY_CODE',
      )
      const unlocked: UnlockedVault = { vaultId: vault.vaultId, epoch: vault.epoch, dek }
      this.sessions.set(unlocked, {})
      return unlocked
    } finally {
      zeroize(payload, identity.privateKey)
    }
  }

  // -- devices --------------------------------------------------------------

  async enrollDevice(
    unlocked: UnlockedVault,
    deviceId: string,
    devicePublicKey: string,
  ): Promise<DeviceWrappedDek> {
    assertUnlocked(unlocked)
    if (!SAFE_ID.test(deviceId)) {
      throw new VaultError('INVALID_DEVICE_ID', 'device id must be 1-256 chars of [A-Za-z0-9._-]')
    }
    const vault = await this.currentVault(unlocked)
    if (vault.deviceWrappedDeks.some((d) => d.deviceId === deviceId)) {
      throw new VaultError('DUPLICATE_DEVICE', `device ${deviceId} is already enrolled`)
    }

    const publicKey = decodeDevicePublicKey(devicePublicKey)
    const wrapped: DeviceWrappedDek = {
      deviceId,
      epoch: vault.epoch,
      // Recorded explicitly now that `DeviceWrappedDek` carries it. Rotation
      // needs every remaining device's public key and cannot ask the absent
      // devices for it; recovering it from the blob's AAD worked, but stored a
      // value somewhere it did not belong. The AAD still BINDS it — this field
      // is where it is read from, not what makes it trustworthy.
      devicePublicKey,
      sealed: wrapDek(unlocked.dek, publicKey, vault.vaultId, 'device', vault.epoch, deviceId),
      enrolledAt: this.now().toISOString(),
    }
    vault.deviceWrappedDeks = [...vault.deviceWrappedDeks, wrapped]
    await this.store.saveVault(vault)
    return wrapped
  }

  /**
   * Rotate, re-wrap, re-encrypt.
   *
   * The new DEK is fresh CSPRNG output, never derived from the old one — a
   * revoked device holds the old DEK, and any derivation it could also compute
   * would make revocation theatre.
   *
   * Ordering: the record is written before the secrets are re-encrypted, so a
   * crash mid-way leaves a vault at epoch n+1 with some secrets still at n.
   * Those are recoverable — the old DEK still opens them and this method is
   * idempotent enough to re-run — but the revoked device is locked out from the
   * first write, which is the property that must not be sacrificed for tidiness.
   */
  async revokeDevice(unlocked: UnlockedVault, deviceId: string): Promise<Vault> {
    assertUnlocked(unlocked)
    const vault = await this.currentVault(unlocked)
    if (!vault.deviceWrappedDeks.some((d) => d.deviceId === deviceId)) {
      throw new VaultError('DEVICE_NOT_FOUND', `device ${deviceId} is not enrolled in this vault`)
    }

    const nextEpoch = vault.epoch + 1
    const nextDek = randomBytes(DEK_BYTES)
    try {
      const survivors = vault.deviceWrappedDeks.filter((d) => d.deviceId !== deviceId)

      const rotated: Vault = {
        ...vault,
        epoch: nextEpoch,
        passphraseWrappedDek: wrapDek(
          nextDek,
          recipientKeyOf(vault.passphraseWrappedDek, 'passphrase'),
          vault.vaultId,
          'passphrase',
          nextEpoch,
        ),
        recoveryWrappedDek: wrapDek(
          nextDek,
          recipientKeyOf(vault.recoveryWrappedDek, 'recovery'),
          vault.vaultId,
          'recovery',
          nextEpoch,
        ),
        deviceWrappedDeks: survivors.map((d) => ({
          ...d,
          epoch: nextEpoch,
          sealed: wrapDek(
            nextDek,
            recipientKeyOf(d.sealed, 'device'),
            vault.vaultId,
            'device',
            nextEpoch,
            d.deviceId,
          ),
        })),
      }
      await this.store.saveVault(rotated)

      for (const secret of await this.store.listSecrets(vault.vaultId)) {
        const value = openSecret(unlocked.dek, secret, vault.vaultId, vault.epoch)
        try {
          await this.store.putSecret(
            vault.vaultId,
            sealSecret(nextDek, secret.ref, value, vault.vaultId, nextEpoch, this.now(), secret.label),
          )
        } finally {
          zeroize(value)
        }
      }

      // Carry the caller's handle forward in place: the same object stays live
      // and usable, and the old DEK is overwritten rather than abandoned.
      unlocked.dek.set(nextDek)
      unlocked.epoch = nextEpoch
      return rotated
    } finally {
      zeroize(nextDek)
    }
  }

  // -- secrets --------------------------------------------------------------

  async seal(unlocked: UnlockedVault, ref: string, value: string): Promise<SealedSecret> {
    assertUnlocked(unlocked)
    if (!SAFE_ID.test(ref)) {
      throw new VaultError('INVALID_REF', `secret ref ${JSON.stringify(ref)} must be 1-256 chars of [A-Za-z0-9._-]`)
    }
    const plaintext = utf8(value)
    try {
      const secret = sealSecret(
        unlocked.dek,
        ref,
        plaintext,
        unlocked.vaultId,
        unlocked.epoch,
        this.now(),
      )
      await this.store.putSecret(unlocked.vaultId, secret)
      return secret
    } finally {
      zeroize(plaintext)
    }
  }

  async open(unlocked: UnlockedVault, secret: SealedSecret): Promise<string> {
    assertUnlocked(unlocked)
    const plaintext = openSecret(unlocked.dek, secret, unlocked.vaultId, unlocked.epoch)
    try {
      return fromUtf8(plaintext)
    } finally {
      // The returned string cannot be zeroed — that is inherent to the
      // contract's `Promise<string>`. The buffer it came from can be.
      zeroize(plaintext)
    }
  }

  // -- kdf ------------------------------------------------------------------

  /**
   * Re-seal the passphrase slot under stronger parameters.
   *
   * Only the passphrase slot changes. The DEK, the epoch, every device wrap and
   * the recovery wrap are untouched, so raising cost cannot lock out a device
   * that is not present to participate — which was the reason the contract
   * versioned KDF parameters in the first place.
   *
   * A fresh salt is generated unless the caller supplies a usable one, since
   * re-deriving under new cost is a natural moment to stop reusing the old salt.
   */
  async upgradeKdf(unlocked: UnlockedVault, params: KdfParams): Promise<Vault> {
    assertUnlocked(unlocked)
    const session = this.sessions.get(unlocked)
    const passphrase = session?.passphrase
    if (!passphrase) {
      throw new VaultError(
        'KDF_UPGRADE_REQUIRES_PASSPHRASE',
        'changing KDF parameters re-derives the root key, which needs the passphrase — unlock with it first',
      )
    }
    const vault = await this.currentVault(unlocked)
    assertStrongerKdf(vault.kdf, params)

    let salt: Uint8Array
    try {
      salt = params.saltB64 ? fromBase64(params.saltB64, 'kdf salt') : new Uint8Array(0)
    } catch {
      salt = new Uint8Array(0)
    }
    const kdf: KdfParams = {
      ...params,
      saltB64: salt.length >= KDF_SALT_BYTES ? params.saltB64 : toBase64(randomBytes(KDF_SALT_BYTES)),
    }

    const identity = passphraseIdentity(passphrase, kdf)
    try {
      const upgraded: Vault = {
        ...vault,
        kdf,
        passphraseWrappedDek: wrapDek(
          unlocked.dek,
          identity.publicKey,
          vault.vaultId,
          'passphrase',
          vault.epoch,
        ),
      }
      await this.store.saveVault(upgraded)
      return upgraded
    } finally {
      zeroize(identity.privateKey)
    }
  }

  // -- internals ------------------------------------------------------------

  private async currentVault(unlocked: UnlockedVault): Promise<Vault> {
    const vault = await this.store.loadVault(unlocked.vaultId)
    if (!vault) throw new VaultError('VAULT_NOT_FOUND', `no vault ${unlocked.vaultId}`)
    if (vault.vaultId !== unlocked.vaultId) {
      throw new VaultError('VAULT_MISMATCH', 'this session belongs to a different vault')
    }
    if (vault.epoch !== unlocked.epoch) {
      throw new VaultError(
        'EPOCH_MISMATCH',
        `session is at epoch ${unlocked.epoch}, vault is at epoch ${vault.epoch} — unlock again`,
      )
    }
    return vault
  }
}

// ---------------------------------------------------------------------------
// Free functions the class is built from
// ---------------------------------------------------------------------------

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    // Strength policy belongs to the onboarding UI, which can show a meter and
    // explain the stakes. An empty string is not a weak passphrase, it is a bug.
    throw new VaultError('INVALID_PASSPHRASE', 'passphrase must not be empty')
  }
}

function assertUnlocked(unlocked: UnlockedVault): void {
  if (unlocked.dek.length !== DEK_BYTES || constantTimeEqual(unlocked.dek, new Uint8Array(DEK_BYTES))) {
    throw new VaultError('LOCKED', 'this vault handle has been locked — unlock again')
  }
}

/**
 * `upgradeKdf` must only ever move cost up.
 *
 * Monotonicity is the invariant, not an absolute floor: the floor is expressed
 * by `ARGON2ID_OWASP_FLOOR` being this client's default, and a caller that
 * lowers it in the constructor has said so out loud. What must never happen is
 * an *upgrade* path that quietly walks cost back down, because that is the one
 * an attacker who can write to the record would reach for.
 */
function assertStrongerKdf(current: KdfParams, next: KdfParams): void {
  if (next.algorithm !== 'argon2id') {
    throw new VaultError('UNSUPPORTED_KDF', `unsupported kdf algorithm ${String(next.algorithm)}`)
  }
  const weaker =
    next.memoryKiB < current.memoryKiB ||
    next.iterations < current.iterations ||
    next.parallelism < current.parallelism
  const same =
    next.memoryKiB === current.memoryKiB &&
    next.iterations === current.iterations &&
    next.parallelism === current.parallelism
  if (weaker || same) {
    throw new VaultError(
      'WEAK_KDF',
      'kdf parameters must increase — tune cost up, never down (contract: "Tune up, never down")',
    )
  }
}

function decodeDevicePublicKey(devicePublicKey: string): Uint8Array {
  let publicKey: Uint8Array
  try {
    publicKey = fromBase64(devicePublicKey, 'device public key')
  } catch (err) {
    throw new VaultError('INVALID_PUBLIC_KEY', 'device public key is not valid base64', { cause: err })
  }
  try {
    assertUsableX25519PublicKey(publicKey)
  } catch (err) {
    throw new VaultError('INVALID_PUBLIC_KEY', 'device public key is not a usable x25519 point', { cause: err })
  }
  return publicKey
}

/** The public key a stored wrap is addressed to, recovered from its AAD. */
function recipientKeyOf(blob: SealedBlob, expected: SlotKind): Uint8Array {
  const parsed = parseSlotAad(blob.aad)
  if (parsed.slot !== expected) {
    throw new VaultError('AAD_MISMATCH', `wrapped key is bound to slot ${parsed.slot}, expected ${expected}`)
  }
  try {
    return fromBase64(parsed.keyB64, 'recipient key')
  } catch (err) {
    throw new VaultError('MALFORMED_RECORD', 'recipient key in AAD is not decodable', { cause: err })
  }
}

function wrapDek(
  dek: Uint8Array,
  recipientPublicKey: Uint8Array,
  vaultId: string,
  slot: SlotKind,
  epoch: KeyEpoch,
  deviceId?: string,
): SealedBlob {
  const aad = slotAad(vaultId, slot, epoch, toBase64(recipientPublicKey), deviceId)
  return toSealedBlob(sealTo(recipientPublicKey, dek, utf8(aad)), aad)
}

/**
 * Open a wrapped DEK, deciding between "you are not who this was sealed for"
 * and "these bytes have been changed" — and doing the same work either way, so
 * the two are indistinguishable from outside the process.
 */
function unwrapDek(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  blob: SealedBlob,
  vaultId: string,
  slot: SlotKind,
  epoch: KeyEpoch,
  wrongKeyCode: VaultErrorCode,
  deviceId?: string,
): Uint8Array {
  const parsed = parseSlotAad(blob.aad)
  if (parsed.slot !== slot || parsed.vaultId !== vaultId || parsed.deviceId !== deviceId) {
    throw new VaultError('AAD_MISMATCH', 'wrapped key is bound to a different slot')
  }
  if (parsed.epoch !== epoch) {
    throw new VaultError(
      'EPOCH_MISMATCH',
      `wrapped key is for epoch ${parsed.epoch}, vault is at epoch ${epoch}`,
    )
  }

  const expectedAad = slotAad(vaultId, slot, epoch, toBase64(publicKey), deviceId)
  const addressedToUs = constantTimeEqualString(blob.aad, expectedAad)

  // Attempt the open even when we already know the key is wrong, so the two
  // failure paths cost the same.
  let dek: Uint8Array | undefined
  try {
    dek = openSealed(privateKey, fromSealedBlob(blob), utf8(blob.aad))
  } catch (err) {
    if (!(err instanceof CryptoError)) throw err
  }

  if (!addressedToUs) {
    zeroize(dek)
    throw new VaultError(wrongKeyCode, 'this key does not open the vault')
  }
  if (!dek) {
    throw new VaultError('TAMPERED', 'the wrapped key failed authentication — it has been modified')
  }
  if (dek.length !== DEK_BYTES) {
    zeroize(dek)
    throw new VaultError('MALFORMED_RECORD', 'wrapped key is the wrong size')
  }
  return dek
}

function sealSecret(
  dek: Uint8Array,
  ref: string,
  plaintext: Uint8Array,
  vaultId: string,
  epoch: KeyEpoch,
  at: Date,
  label?: string,
): SealedSecret {
  const aad = secretAad(vaultId, ref, epoch)
  const key = secretKey(dek, ref)
  try {
    const { ciphertext, iv, tag } = aeadSeal(key, plaintext, utf8(aad))
    return {
      ref,
      epoch,
      blob: {
        algorithm: 'aes-256-gcm',
        ciphertextB64: toBase64(ciphertext),
        ivB64: toBase64(iv),
        tagB64: toBase64(tag),
        aad,
      },
      ...(label === undefined ? {} : { label }),
      updatedAt: at.toISOString(),
    }
  } finally {
    zeroize(key)
  }
}

function openSecret(dek: Uint8Array, secret: SealedSecret, vaultId: string, epoch: KeyEpoch): Uint8Array {
  if (secret.epoch !== epoch) {
    throw new VaultError(
      'EPOCH_MISMATCH',
      `secret ${secret.ref} is sealed under epoch ${secret.epoch}, this session is at epoch ${epoch}`,
    )
  }
  const expectedAad = secretAad(vaultId, secret.ref, epoch)
  if (!constantTimeEqualString(secret.blob.aad, expectedAad)) {
    // The blob is intact but it is not this secret's blob. This is the check
    // that stops the server swapping ciphertext between two refs.
    throw new VaultError(
      'AAD_MISMATCH',
      `sealed blob for ${secret.ref} is bound to a different ref, vault or epoch`,
    )
  }

  const box = fromSealedBlob(secret.blob)
  const key = secretKey(dek, secret.ref)
  try {
    return aeadOpen(key, { ciphertext: box.body, iv: box.iv, tag: box.tag }, utf8(expectedAad))
  } catch (err) {
    if (err instanceof CryptoError) {
      throw new VaultError('TAMPERED', `sealed blob for ${secret.ref} failed authentication`, { cause: err })
    }
    throw err
  } finally {
    zeroize(key)
  }
}
