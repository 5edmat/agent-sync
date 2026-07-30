/**
 * End-to-end encrypted secret vault.
 *
 * DESIGN GOAL: the server stores ciphertext it is mathematically incapable of
 * reading. Not "we promise not to look" — actually cannot. This is what makes
 * syncing real credential values defensible for a public product, and it is a
 * selling point rather than a liability: a full backend breach yields blobs.
 *
 * WHAT IS AND ISN'T ENCRYPTED
 * ---------------------------
 * Config itself stays plaintext — the web app has to render diffs, and it can't
 * diff what it can't read. Only secret VALUES are sealed, and config references
 * them symbolically:
 *
 *   settings.json →  { "env": { "GITHUB_TOKEN": "${secret:github.token}" } }
 *   vault         →  { ref: "github.token", ciphertext: "..." }
 *
 * The device resolves the reference at apply time. So the plan preview shows
 * "GITHUB_TOKEN will be set from secret github.token" without anyone — us
 * included — learning the value.
 *
 * KEY HIERARCHY
 * -------------
 *   passphrase ──Argon2id──▶ root key ──wraps──▶ DEK ──AES-256-GCM──▶ secrets
 *                                          │
 *                                          ├──sealed to──▶ device X25519 pubkey
 *                                          └──sealed to──▶ recovery code
 *
 * The DEK is what actually encrypts secrets. It is wrapped once per device and
 * once to a recovery code. Enrolling a device = wrapping the DEK to its public
 * key. Revoking a device = rotating the DEK and re-wrapping to everyone else,
 * so a stolen laptop's copy is inert for anything written afterwards.
 *
 * THE PART THAT MUST BE SAID OUT LOUD AT SETUP
 * --------------------------------------------
 * If the user loses their passphrase AND every enrolled device AND the recovery
 * code, the secrets are gone. We cannot reset it — that is the whole point. The
 * onboarding flow must make the user store the recovery code before a single
 * secret is accepted, and must not let them click past it.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Argon2id parameters. Deliberately explicit and versioned: raising cost later
 * must not lock out existing vaults, so every wrapped key records the params it
 * was derived under and is upgraded on next successful unlock.
 */
export interface KdfParams {
  algorithm: 'argon2id'
  /** OWASP floor at time of writing. Tune up, never down. */
  memoryKiB: number // 19456 (19 MiB) minimum
  iterations: number // 2 minimum
  parallelism: number // 1
  saltB64: string
}

export type KeyEpoch = number

/** AEAD envelope. `aad` binds ciphertext to its ref so blobs can't be swapped. */
export interface SealedBlob {
  algorithm: 'aes-256-gcm'
  ciphertextB64: string
  ivB64: string
  tagB64: string
  /** Additional authenticated data — the secret ref and epoch, not encrypted. */
  aad: string
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface Vault {
  vaultId: string
  /** Current DEK generation. Increments on every device revocation. */
  epoch: KeyEpoch
  kdf: KdfParams
  /** DEK wrapped by the passphrase-derived root key. */
  passphraseWrappedDek: SealedBlob
  /** DEK wrapped to each enrolled device's X25519 public key. */
  deviceWrappedDeks: DeviceWrappedDek[]
  /** DEK wrapped to the printable recovery code. Exactly one, always present. */
  recoveryWrappedDek: SealedBlob
  createdAt: string
}

export interface DeviceWrappedDek {
  deviceId: string
  epoch: KeyEpoch
  /**
   * The X25519 public key this DEK was sealed to.
   *
   * Required for rotation. `revokeDevice` re-wraps the new DEK to every
   * REMAINING device — and those devices are not present to be asked, so their
   * public keys have to be in the record. Without this the implementation had
   * to recover them from each blob's AAD: authenticated and correct, but a
   * value being carried somewhere it does not belong.
   */
  devicePublicKey: string
  /** X25519 sealed box to the device key generated at pairing. */
  sealed: SealedBlob
  enrolledAt: string
}

export interface SealedSecret {
  /** Stable symbolic name used in config as `${secret:<ref>}`. */
  ref: string
  epoch: KeyEpoch
  blob: SealedBlob
  /**
   * Non-sensitive metadata the web app CAN show: which devices have resolved
   * this successfully, when it was last rotated. Never the value.
   */
  label?: string
  updatedAt: string
}

/**
 * What the server is allowed to hold. Stated as a type so the boundary is
 * reviewable: if a field that could carry plaintext ever appears here, it is a
 * design regression and should fail review.
 */
export interface ServerVaultRecord {
  vaultId: string
  epoch: KeyEpoch
  kdf: KdfParams
  passphraseWrappedDek: SealedBlob
  deviceWrappedDeks: DeviceWrappedDek[]
  recoveryWrappedDek: SealedBlob
  secrets: SealedSecret[]
  // NOTE: no passphrase, no root key, no DEK, no plaintext. Ever.
}

// ---------------------------------------------------------------------------
// Client-side operations (device + web app only — never server)
// ---------------------------------------------------------------------------

export interface VaultClient {
  /** First-run. Returns the recovery code ONCE; it is never recoverable again. */
  create(passphrase: string): Promise<{ vault: Vault; recoveryCode: string }>

  unlockWithPassphrase(vault: Vault, passphrase: string): Promise<UnlockedVault>
  unlockWithDeviceKey(vault: Vault, devicePrivateKey: Uint8Array): Promise<UnlockedVault>
  unlockWithRecoveryCode(vault: Vault, recoveryCode: string): Promise<UnlockedVault>

  /** Wrap the current DEK to a newly paired device's public key. */
  enrollDevice(unlocked: UnlockedVault, deviceId: string, devicePublicKey: string): Promise<DeviceWrappedDek>

  /**
   * Rotate the DEK and re-wrap to every device EXCEPT the revoked one, then
   * re-encrypt all secrets under the new epoch.
   *
   * Honest limitation to surface in the UI: this protects future writes. It
   * cannot un-know a secret the revoked device already decrypted. Anything that
   * device actually held should be treated as compromised and rotated at the
   * source (revoke the GitHub token, not just the device).
   */
  revokeDevice(unlocked: UnlockedVault, deviceId: string): Promise<Vault>

  seal(unlocked: UnlockedVault, ref: string, value: string): Promise<SealedSecret>
  open(unlocked: UnlockedVault, secret: SealedSecret): Promise<string>

  /** Re-derive under stronger KDF params after a successful unlock. */
  upgradeKdf(unlocked: UnlockedVault, params: KdfParams): Promise<Vault>
}

export interface UnlockedVault {
  vaultId: string
  epoch: KeyEpoch
  /** Held in memory only. Must be zeroed on lock and never written to disk. */
  dek: Uint8Array
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

/** `${secret:github.token}` — the only form config may use to reach a secret. */
export const SECRET_REF_PATTERN = /\$\{secret:([a-zA-Z0-9._-]+)\}/g

export function extractSecretRefs(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...value.matchAll(SECRET_REF_PATTERN)].map((m) => m[1] as string)
}

/**
 * Resolve references at apply time, on the device, after the vault is unlocked.
 *
 * `missing` is not an error here: a device that has not yet been enrolled, or a
 * secret the user chose not to sync, must degrade to a clear "this device is
 * missing github.token" in the UI rather than writing the literal string
 * "${secret:github.token}" into a config file and breaking the tool silently.
 */
export interface ResolutionResult {
  resolved: string
  missing: string[]
}

export function resolveSecretRefs(
  template: string,
  values: ReadonlyMap<string, string>,
): ResolutionResult {
  const missing: string[] = []
  const resolved = template.replace(SECRET_REF_PATTERN, (whole, ref: string) => {
    const v = values.get(ref)
    if (v === undefined) {
      missing.push(ref)
      return whole
    }
    return v
  })
  return { resolved, missing }
}
