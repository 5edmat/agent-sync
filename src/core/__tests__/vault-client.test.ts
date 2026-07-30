/**
 * Vault tests.
 *
 * Real Argon2id, real X25519, real AES-256-GCM. Nothing about a primitive is
 * stubbed, because every property under test here is a property of the bytes:
 * "the server cannot read this" is not observable through a mock.
 *
 * The cost knobs are turned down (64 KiB, one pass) so the suite stays fast.
 * That is a *cost* change, not an algorithm change — the label still says
 * argon2id and it is still argon2id. One test runs at the shipping parameters
 * so the production path is exercised too.
 */

import { describe, expect, it } from 'vitest'

import {
  createInMemoryVaultStore,
  generateDeviceKeyPair,
  LocalVaultClient,
  toServerVaultRecord,
  VaultError,
  type InMemoryVaultStore,
  type VaultErrorCode,
} from '../vault-client.js'
import type { KdfParams, SealedSecret, UnlockedVault, Vault } from '../vault.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Cheap Argon2id. Cost only — the algorithm and the label are unchanged. */
const TEST_KDF: Omit<KdfParams, 'saltB64'> = {
  algorithm: 'argon2id',
  memoryKiB: 64,
  iterations: 1,
  parallelism: 1,
}

const PASSPHRASE = 'correct horse battery staple'

interface Harness {
  client: LocalVaultClient
  store: InMemoryVaultStore
}

function harness(kdf: Omit<KdfParams, 'saltB64'> = TEST_KDF): Harness {
  const store = createInMemoryVaultStore()
  return { client: new LocalVaultClient({ store, kdf }), store }
}

async function reload(h: Harness, vaultId: string): Promise<Vault> {
  const vault = await h.store.loadVault(vaultId)
  if (!vault) throw new Error(`test bug: no vault ${vaultId}`)
  return vault
}

/** Assert a rejection and hand back the error so its code can be checked. */
async function vaultErrorOf(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof VaultError) return err
    throw err
  }
  throw new Error('expected a VaultError, but the call resolved')
}

async function expectCode(promise: Promise<unknown>, code: VaultErrorCode): Promise<void> {
  expect((await vaultErrorOf(promise)).code).toBe(code)
}

const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64')
const hex = (v: Uint8Array): string => Buffer.from(v).toString('hex')

/** Flip a byte inside a base64 field, keeping it well-formed base64. */
function flipByte(value: string, index: number): string {
  const buf = Buffer.from(value, 'base64')
  buf[index] = (buf[index] as number) ^ 0xff
  return buf.toString('base64')
}

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe('unlock paths', () => {
  it('round trips a secret through a passphrase unlock', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const sealed = await h.client.seal(unlocked, 'github.token', 'ghp_live_value')
    expect(await h.client.open(unlocked, sealed)).toBe('ghp_live_value')
  })

  it('round trips through a device key, from enrolment to open', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const sealed = await h.client.seal(unlocked, 'api.key', 'sk-live-123')

    const device = generateDeviceKeyPair()
    const wrapped = await h.client.enrollDevice(unlocked, 'laptop-1', device.publicKeyB64)
    expect(wrapped.deviceId).toBe('laptop-1')
    expect(wrapped.epoch).toBe(vault.epoch)

    // A second device, unlocking from the record alone and its own private key.
    const onDevice = await h.client.unlockWithDeviceKey(await reload(h, vault.vaultId), device.privateKey)
    expect(onDevice.epoch).toBe(vault.epoch)
    expect(await h.client.open(onDevice, sealed)).toBe('sk-live-123')
  })

  it('round trips through the recovery code alone', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const sealed = await h.client.seal(unlocked, 'db.password', 'hunter2')

    // The scenario the recovery code exists for: no passphrase, no device.
    const recovered = await h.client.unlockWithRecoveryCode(vault, recoveryCode)
    expect(await h.client.open(recovered, sealed)).toBe('hunter2')
  })

  it('every unlock path yields the same DEK', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const byPassphrase = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const device = generateDeviceKeyPair()
    await h.client.enrollDevice(byPassphrase, 'laptop-1', device.publicKeyB64)

    const byDevice = await h.client.unlockWithDeviceKey(await reload(h, vault.vaultId), device.privateKey)
    const byRecovery = await h.client.unlockWithRecoveryCode(vault, recoveryCode)

    expect(hex(byDevice.dek)).toBe(hex(byPassphrase.dek))
    expect(hex(byRecovery.dek)).toBe(hex(byPassphrase.dek))
  })

  it('works at the shipping KDF parameters, not just the test ones', async () => {
    const h = harness({ algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1 })
    const { vault } = await h.client.create(PASSPHRASE)
    expect(vault.kdf.memoryKiB).toBe(19456)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const sealed = await h.client.seal(unlocked, 'prod.token', 'value')
    expect(await h.client.open(unlocked, sealed)).toBe('value')
  })

  it('handles unicode and long secret values byte-exactly', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const value = `${'x'.repeat(4096)}—🔐—${String.fromCodePoint(0x10ffff)}`
    const sealed = await h.client.seal(unlocked, 'big.secret', value)
    expect(await h.client.open(unlocked, sealed)).toBe(value)
  })

  it('gives two secrets with the same value unrelated ciphertext', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const a = await h.client.seal(unlocked, 'a', 'same-value')
    const b = await h.client.seal(unlocked, 'b', 'same-value')
    expect(a.blob.ciphertextB64).not.toBe(b.blob.ciphertextB64)
    expect(a.blob.ivB64).not.toBe(b.blob.ivB64)
  })
})

// ---------------------------------------------------------------------------
// Wrong credentials
// ---------------------------------------------------------------------------

describe('wrong credentials', () => {
  it('rejects a wrong passphrase, distinguishably from tampering', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    await expectCode(h.client.unlockWithPassphrase(vault, 'not the passphrase'), 'BAD_PASSPHRASE')
    await expectCode(h.client.unlockWithPassphrase(vault, `${PASSPHRASE} `), 'BAD_PASSPHRASE')
    await expectCode(h.client.unlockWithPassphrase(vault, ''), 'INVALID_PASSPHRASE')
  })

  it('rejects an unenrolled device key as UNKNOWN_DEVICE', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const stranger = generateDeviceKeyPair()
    await expectCode(h.client.unlockWithDeviceKey(vault, stranger.privateKey), 'UNKNOWN_DEVICE')
  })

  it('separates a mistyped recovery code from someone else’s valid one', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const other = await h.client.create(PASSPHRASE)

    // A single wrong character fails the checksum: "you mistyped it".
    const first = recoveryCode.charAt(0)
    const typo = (first === 'A' ? 'B' : 'A') + recoveryCode.slice(1)
    await expectCode(h.client.unlockWithRecoveryCode(vault, typo), 'MALFORMED_RECOVERY_CODE')
    await expectCode(h.client.unlockWithRecoveryCode(vault, 'too-short'), 'MALFORMED_RECOVERY_CODE')

    // A well-formed code for a different vault: "that is not this vault's code".
    await expectCode(h.client.unlockWithRecoveryCode(vault, other.recoveryCode), 'BAD_RECOVERY_CODE')
  })

  it('accepts a recovery code however the human retypes it', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const sealed = await h.client.seal(unlocked, 'x', 'v')

    for (const variant of [
      recoveryCode.toLowerCase(),
      recoveryCode.replace(/-/g, ''),
      recoveryCode.replace(/-/g, ' '),
      // Crockford folds the glyphs a human confuses on paper.
      recoveryCode.replace(/0/g, 'O').replace(/1/g, 'l'),
    ]) {
      const via = await h.client.unlockWithRecoveryCode(vault, variant)
      expect(await h.client.open(via, sealed)).toBe('v')
    }
  })

  it('mints a 160-bit recovery code in a shape a human can transcribe', async () => {
    const h = harness()
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const { recoveryCode } = await h.client.create(PASSPHRASE)
      // 32 payload chars (32 * 5 = 160 bits) + a 4-char checksum, in groups of 4.
      expect(recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/)
      seen.add(recoveryCode)
    }
    expect(seen.size).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

describe('integrity', () => {
  async function sealed(): Promise<{ h: Harness; vault: Vault; unlocked: UnlockedVault; secret: SealedSecret }> {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const secret = await h.client.seal(unlocked, 'github.token', 'ghp_live_value')
    return { h, vault, unlocked, secret }
  }

  it('rejects tampered secret ciphertext, iv and tag', async () => {
    const { h, unlocked, secret } = await sealed()
    for (const mutate of [
      (s: SealedSecret) => (s.blob.ciphertextB64 = flipByte(s.blob.ciphertextB64, 0)),
      (s: SealedSecret) => (s.blob.ivB64 = flipByte(s.blob.ivB64, 0)),
      (s: SealedSecret) => (s.blob.tagB64 = flipByte(s.blob.tagB64, 0)),
    ]) {
      const copy = structuredClone(secret)
      mutate(copy)
      await expectCode(h.client.open(unlocked, copy), 'TAMPERED')
    }
  })

  it('rejects a rewritten AAD even though the ciphertext is untouched', async () => {
    const { h, unlocked, secret } = await sealed()
    const copy = structuredClone(secret)
    copy.blob.aad = copy.blob.aad.replace('ref=github.token', 'ref=stripe.key')
    await expectCode(h.client.open(unlocked, copy), 'AAD_MISMATCH')

    const reEpoched = structuredClone(secret)
    reEpoched.blob.aad = reEpoched.blob.aad.replace(/epoch=\d+/, 'epoch=99')
    await expectCode(h.client.open(unlocked, reEpoched), 'AAD_MISMATCH')

    const reVaulted = structuredClone(secret)
    reVaulted.blob.aad = reVaulted.blob.aad.replace(/vault=[^|]+/, 'vault=someone-elses')
    await expectCode(h.client.open(unlocked, reVaulted), 'AAD_MISMATCH')
  })

  it('rejects a blob moved from one ref to another', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const lowValue = await h.client.seal(unlocked, 'staging.token', 'staging-value')
    const highValue = await h.client.seal(unlocked, 'prod.token', 'prod-value')

    // The attack: a server that cannot read either value swaps them, hoping a
    // device writes the staging credential where the production one belongs.
    const swapped: SealedSecret = { ...structuredClone(highValue), blob: structuredClone(lowValue.blob) }
    await expectCode(h.client.open(unlocked, swapped), 'AAD_MISMATCH')

    // And with the AAD rewritten to match its new home, so only the key binding
    // is left to catch it.
    const swappedAndRelabelled = structuredClone(swapped)
    swappedAndRelabelled.blob.aad = highValue.blob.aad
    await expectCode(h.client.open(unlocked, swappedAndRelabelled), 'TAMPERED')

    // The values themselves never moved.
    expect(await h.client.open(unlocked, highValue)).toBe('prod-value')
    expect(await h.client.open(unlocked, lowValue)).toBe('staging-value')
  })

  it('rejects a secret presented at the wrong epoch', async () => {
    const { h, unlocked, secret } = await sealed()
    const stale = { ...structuredClone(secret), epoch: secret.epoch + 1 }
    await expectCode(h.client.open(unlocked, stale), 'EPOCH_MISMATCH')
  })

  it('rejects tampering with a wrapped DEK, and says which kind', async () => {
    const { h, vault } = await sealed()

    const flipped = structuredClone(vault)
    // Byte 40 is inside the wrapped key, past the 32-byte ephemeral public key.
    flipped.passphraseWrappedDek.ciphertextB64 = flipByte(flipped.passphraseWrappedDek.ciphertextB64, 40)
    await expectCode(h.client.unlockWithPassphrase(flipped, PASSPHRASE), 'TAMPERED')

    const reEpoched = structuredClone(vault)
    reEpoched.passphraseWrappedDek.aad = reEpoched.passphraseWrappedDek.aad.replace(/epoch=\d+/, 'epoch=7')
    await expectCode(h.client.unlockWithPassphrase(reEpoched, PASSPHRASE), 'EPOCH_MISMATCH')

    const reVaulted = structuredClone(vault)
    reVaulted.passphraseWrappedDek.aad = reVaulted.passphraseWrappedDek.aad.replace(
      /vault=[^|]+/,
      'vault=someone-elses',
    )
    await expectCode(h.client.unlockWithPassphrase(reVaulted, PASSPHRASE), 'AAD_MISMATCH')

    const reSlotted = structuredClone(vault)
    reSlotted.passphraseWrappedDek.aad = reSlotted.passphraseWrappedDek.aad.replace(
      'slot=passphrase',
      'slot=recovery',
    )
    await expectCode(h.client.unlockWithPassphrase(reSlotted, PASSPHRASE), 'AAD_MISMATCH')

    const mangled = structuredClone(vault)
    mangled.passphraseWrappedDek.aad = 'whatever the server feels like'
    await expectCode(h.client.unlockWithPassphrase(mangled, PASSPHRASE), 'MALFORMED_RECORD')

    const swappedSlots = structuredClone(vault)
    swappedSlots.passphraseWrappedDek = structuredClone(vault.recoveryWrappedDek)
    await expectCode(h.client.unlockWithPassphrase(swappedSlots, PASSPHRASE), 'AAD_MISMATCH')
  })

  it('cross-checks the unauthenticated fields on a device wrap against its AAD', async () => {
    // `DeviceWrappedDek.epoch` and `.deviceId` sit outside the AEAD — they are
    // plain JSON the server hands over and could rewrite freely. Each one is
    // therefore only believed when the authenticated AAD agrees with it.
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const device = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'laptop-1', device.publicKeyB64)
    const current = await reload(h, vault.vaultId)

    const forgedEpoch = structuredClone(current)
    ;(forgedEpoch.deviceWrappedDeks[0] as { epoch: number }).epoch = 99
    await expectCode(h.client.unlockWithDeviceKey(forgedEpoch, device.privateKey), 'EPOCH_MISMATCH')

    const forgedId = structuredClone(current)
    ;(forgedId.deviceWrappedDeks[0] as { deviceId: string }).deviceId = 'someone-elses-laptop'
    await expectCode(h.client.unlockWithDeviceKey(forgedId, device.privateKey), 'AAD_MISMATCH')

    // The untouched record still opens, so the checks above rejected the
    // forgery rather than the device.
    expect((await h.client.unlockWithDeviceKey(current, device.privateKey)).epoch).toBe(current.epoch)
  })

  it('rejects a record that is not decodable at all', async () => {
    const { h, vault } = await sealed()
    const junk = structuredClone(vault)
    junk.passphraseWrappedDek.ciphertextB64 = 'not base64 !!'
    await expectCode(h.client.unlockWithPassphrase(junk, PASSPHRASE), 'MALFORMED_RECORD')

    const badAlgo = structuredClone(vault)
    ;(badAlgo.passphraseWrappedDek as { algorithm: string }).algorithm = 'rot13'
    await expectCode(h.client.unlockWithPassphrase(badAlgo, PASSPHRASE), 'MALFORMED_RECORD')

    const badKdf = structuredClone(vault)
    ;(badKdf.kdf as { algorithm: string }).algorithm = 'md5'
    await expectCode(h.client.unlockWithPassphrase(badKdf, PASSPHRASE), 'MALFORMED_RECORD')
  })

  it('refuses refs and device ids that could forge an AAD binding', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)

    // `|` and `=` are the AAD's own separators — a ref carrying them could
    // claim to be bound to a different epoch or vault.
    for (const ref of ['a|b', 'a=b', 'epoch=1|ref=other', '', '../etc/passwd', 'a b']) {
      await expectCode(h.client.seal(unlocked, ref, 'v'), 'INVALID_REF')
    }
    const device = generateDeviceKeyPair()
    await expectCode(h.client.enrollDevice(unlocked, 'a|b', device.publicKeyB64), 'INVALID_DEVICE_ID')
    await expectCode(h.client.enrollDevice(unlocked, 'ok-device', 'not base64!'), 'INVALID_PUBLIC_KEY')
    // An all-zero point would make every "shared" secret the same known value.
    await expectCode(
      h.client.enrollDevice(unlocked, 'ok-device', Buffer.alloc(32).toString('base64')),
      'INVALID_PUBLIC_KEY',
    )
  })
})

// ---------------------------------------------------------------------------
// Devices and revocation
// ---------------------------------------------------------------------------

describe('device enrolment and revocation', () => {
  it('refuses to enrol the same device id twice', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const device = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'laptop-1', device.publicKeyB64)
    await expectCode(h.client.enrollDevice(unlocked, 'laptop-1', device.publicKeyB64), 'DUPLICATE_DEVICE')
  })

  it('refuses to revoke a device that was never enrolled', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    await expectCode(h.client.revokeDevice(unlocked, 'ghost'), 'DEVICE_NOT_FOUND')
  })

  it('rotates the epoch, re-wraps the survivors, and locks out the revoked device', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)

    const stolen = generateDeviceKeyPair()
    const keeper = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'stolen-laptop', stolen.publicKeyB64)
    await h.client.enrollDevice(unlocked, 'phone', keeper.publicKeyB64)

    const before = await reload(h, vault.vaultId)
    const stolenWrapBefore = before.deviceWrappedDeks.find((d) => d.deviceId === 'stolen-laptop')
    if (!stolenWrapBefore) throw new Error('test bug')
    const oldSecret = await h.client.seal(unlocked, 'github.token', 'ghp_old')
    const dekBefore = hex(unlocked.dek)

    // Revoke from a session that is NOT the stolen device — the realistic
    // flow, and the one that only works because every slot is asymmetric.
    const rotated = await h.client.revokeDevice(unlocked, 'stolen-laptop')

    expect(rotated.epoch).toBe(before.epoch + 1)
    expect(rotated.deviceWrappedDeks.map((d) => d.deviceId)).toEqual(['phone'])
    expect(rotated.deviceWrappedDeks.every((d) => d.epoch === rotated.epoch)).toBe(true)
    expect(hex(unlocked.dek)).not.toBe(dekBefore)
    expect(unlocked.epoch).toBe(rotated.epoch)

    // Existing secrets were re-encrypted under the new epoch...
    const secrets = await h.store.listSecrets(vault.vaultId)
    expect(secrets.every((s) => s.epoch === rotated.epoch)).toBe(true)
    const rotatedSecret = secrets.find((s) => s.ref === 'github.token')
    if (!rotatedSecret) throw new Error('test bug')
    expect(rotatedSecret.blob.ciphertextB64).not.toBe(oldSecret.blob.ciphertextB64)
    expect(await h.client.open(unlocked, rotatedSecret)).toBe('ghp_old')

    // ...and every surviving credential still opens the vault.
    const keeperSession = await h.client.unlockWithDeviceKey(rotated, keeper.privateKey)
    expect(await h.client.open(keeperSession, rotatedSecret)).toBe('ghp_old')
    const byPassphrase = await h.client.unlockWithPassphrase(rotated, PASSPHRASE)
    expect(await h.client.open(byPassphrase, rotatedSecret)).toBe('ghp_old')
    const byRecovery = await h.client.unlockWithRecoveryCode(rotated, recoveryCode)
    expect(await h.client.open(byRecovery, rotatedSecret)).toBe('ghp_old')

    // The revoked device is gone from the record.
    await expectCode(h.client.unlockWithDeviceKey(rotated, stolen.privateKey), 'UNKNOWN_DEVICE')

    // Splicing its old wrap back in does not help: the AAD names the old epoch.
    const spliced = structuredClone(rotated)
    spliced.deviceWrappedDeks = [...spliced.deviceWrappedDeks, stolenWrapBefore]
    await expectCode(h.client.unlockWithDeviceKey(spliced, stolen.privateKey), 'EPOCH_MISMATCH')
  })

  it('leaves the revoked device holding a DEK that opens nothing written since', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const stolen = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'stolen-laptop', stolen.publicKeyB64)

    // What the thief actually keeps: the record as it was, on their disk.
    const keptRecord = await reload(h, vault.vaultId)
    await h.client.revokeDevice(unlocked, 'stolen-laptop')
    const afterRevocation = await h.client.seal(unlocked, 'rotated.token', 'new-value')

    // The old wrap still opens — of course it does, they have the bytes.
    const stolenSession = await h.client.unlockWithDeviceKey(keptRecord, stolen.privateKey)
    expect(stolenSession.epoch).toBe(keptRecord.epoch)

    // But it is a DEK for a dead generation. The epoch check refuses first...
    await expectCode(h.client.open(stolenSession, afterRevocation), 'EPOCH_MISMATCH')

    // ...and forcing the epoch past that check gets them nothing either,
    // because the key genuinely is not the key any more.
    const forced: UnlockedVault = { ...stolenSession, epoch: afterRevocation.epoch }
    await expectCode(h.client.open(forced, afterRevocation), 'TAMPERED')
  })

  it('rejects a session whose epoch has moved on underneath it', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const a = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const b = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const device = generateDeviceKeyPair()
    await h.client.enrollDevice(a, 'laptop-1', device.publicKeyB64)
    await h.client.revokeDevice(a, 'laptop-1')

    // `b` still believes it is at the old epoch.
    await expectCode(h.client.enrollDevice(b, 'laptop-2', device.publicKeyB64), 'EPOCH_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// KDF upgrade
// ---------------------------------------------------------------------------

describe('upgradeKdf', () => {
  const STRONGER: KdfParams = {
    algorithm: 'argon2id',
    memoryKiB: 256,
    iterations: 2,
    parallelism: 1,
    saltB64: '',
  }

  it('re-derives under stronger parameters without disturbing any other holder', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const one = generateDeviceKeyPair()
    const two = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'laptop-1', one.publicKeyB64)
    await h.client.enrollDevice(unlocked, 'phone', two.publicKeyB64)
    const secret = await h.client.seal(unlocked, 'github.token', 'ghp_value')

    const before = await reload(h, vault.vaultId)
    const upgraded = await h.client.upgradeKdf(unlocked, STRONGER)

    expect(upgraded.kdf.memoryKiB).toBe(256)
    expect(upgraded.kdf.iterations).toBe(2)
    // A fresh salt, and a passphrase wrap that necessarily changed with it.
    expect(upgraded.kdf.saltB64).not.toBe(before.kdf.saltB64)
    expect(upgraded.passphraseWrappedDek.ciphertextB64).not.toBe(before.passphraseWrappedDek.ciphertextB64)

    // Nothing else moved. This is the property the contract asked for: raising
    // cost must not lock out a device that is not here to re-wrap itself.
    expect(upgraded.epoch).toBe(before.epoch)
    expect(upgraded.deviceWrappedDeks).toEqual(before.deviceWrappedDeks)
    expect(upgraded.recoveryWrappedDek).toEqual(before.recoveryWrappedDek)

    // Every credential still works against the upgraded record.
    const viaPassphrase = await h.client.unlockWithPassphrase(upgraded, PASSPHRASE)
    expect(await h.client.open(viaPassphrase, secret)).toBe('ghp_value')
    for (const device of [one, two]) {
      const session = await h.client.unlockWithDeviceKey(upgraded, device.privateKey)
      expect(await h.client.open(session, secret)).toBe('ghp_value')
    }
    const viaRecovery = await h.client.unlockWithRecoveryCode(upgraded, recoveryCode)
    expect(await h.client.open(viaRecovery, secret)).toBe('ghp_value')

    // And the old passphrase parameters no longer derive the identity.
    await expectCode(h.client.unlockWithPassphrase(upgraded, 'wrong'), 'BAD_PASSPHRASE')
  })

  it('honours a caller-supplied salt when it is long enough', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const saltB64 = Buffer.alloc(16, 0xab).toString('base64')
    const upgraded = await h.client.upgradeKdf(unlocked, { ...STRONGER, saltB64 })
    expect(upgraded.kdf.saltB64).toBe(saltB64)
    await h.client.unlockWithPassphrase(upgraded, PASSPHRASE)
  })

  it('will not walk cost back down, or sideways', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    await expectCode(
      h.client.upgradeKdf(unlocked, { ...STRONGER, memoryKiB: 32, iterations: 1 }),
      'WEAK_KDF',
    )
    await expectCode(h.client.upgradeKdf(unlocked, { ...vault.kdf }), 'WEAK_KDF')
    // Only reachable from untyped JSON or a cast, but that is exactly how a
    // downgrade would arrive. "Fix your call" is not "your record is corrupt".
    await expectCode(
      h.client.upgradeKdf(unlocked, { ...STRONGER, algorithm: 'scrypt' } as unknown as KdfParams),
      'UNSUPPORTED_KDF',
    )
  })

  it('refuses when the session cannot re-derive the root key', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const device = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'laptop-1', device.publicKeyB64)

    // A device session has the DEK but not the passphrase, and Argon2id cannot
    // be re-run without it. Say so, rather than doing something weaker.
    const viaDevice = await h.client.unlockWithDeviceKey(await reload(h, vault.vaultId), device.privateKey)
    await expectCode(h.client.upgradeKdf(viaDevice, STRONGER), 'KDF_UPGRADE_REQUIRES_PASSPHRASE')

    const viaRecovery = await h.client.unlockWithRecoveryCode(vault, recoveryCode)
    await expectCode(h.client.upgradeKdf(viaRecovery, STRONGER), 'KDF_UPGRADE_REQUIRES_PASSPHRASE')
  })
})

// ---------------------------------------------------------------------------
// The DEK is memory-only
// ---------------------------------------------------------------------------

describe('locking', () => {
  it('zeroes the DEK and makes the handle inert', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const secret = await h.client.seal(unlocked, 'github.token', 'ghp_value')

    h.client.lock(unlocked)

    expect(hex(unlocked.dek)).toBe('00'.repeat(32))
    await expectCode(h.client.open(unlocked, secret), 'LOCKED')
    await expectCode(h.client.seal(unlocked, 'other', 'v'), 'LOCKED')
    await expectCode(h.client.enrollDevice(unlocked, 'd', generateDeviceKeyPair().publicKeyB64), 'LOCKED')
    await expectCode(h.client.revokeDevice(unlocked, 'd'), 'LOCKED')

    // Unlocking again produces a working handle; the record was never damaged.
    const again = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    expect(await h.client.open(again, secret)).toBe('ghp_value')
  })
})

// ---------------------------------------------------------------------------
// The boundary the whole design exists to defend
// ---------------------------------------------------------------------------

describe('ServerVaultRecord carries no plaintext', () => {
  it('holds nothing that could reconstruct a secret, a key, or the passphrase', async () => {
    const h = harness()
    const { vault, recoveryCode } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)

    const laptop = generateDeviceKeyPair()
    const phone = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'laptop-1', laptop.publicKeyB64)
    await h.client.enrollDevice(unlocked, 'phone', phone.publicKeyB64)

    const values: Record<string, string> = {
      'github.token': 'ghp_UNIQUEMARKER_github_1234567890',
      'stripe.key': 'sk_live_UNIQUEMARKER_stripe_abcdef',
      'db.password': 'UNIQUEMARKER-db-p4ssw0rd',
    }
    for (const [ref, value] of Object.entries(values)) await h.client.seal(unlocked, ref, value)

    // Rotate once so the record contains a revoked-then-rewrapped generation too.
    await h.client.revokeDevice(unlocked, 'phone')
    await h.client.seal(unlocked, 'post.rotation', 'UNIQUEMARKER-after-rotation')

    const record = h.store.serverRecord(vault.vaultId)
    if (!record) throw new Error('test bug: no record')
    const json = JSON.stringify(record)

    // A fully populated record: this is not vacuously passing on an empty one.
    expect(record.secrets).toHaveLength(4)
    expect(record.deviceWrappedDeks).toHaveLength(1)
    expect(record.epoch).toBe(2)

    const mustNotAppear: Array<[string, string]> = [
      ...Object.entries(values).map(([ref, v]) => [`value of ${ref}`, v] as [string, string]),
      ['post-rotation value', 'UNIQUEMARKER-after-rotation'],
      ['the passphrase', PASSPHRASE],
      ['the recovery code', recoveryCode],
      ['the recovery code, ungrouped', recoveryCode.replace(/-/g, '')],
      ['the DEK (base64)', Buffer.from(unlocked.dek).toString('base64')],
      ['the DEK (hex)', hex(unlocked.dek)],
      ['laptop private key (base64)', Buffer.from(laptop.privateKey).toString('base64')],
      ['laptop private key (hex)', hex(laptop.privateKey)],
      ['phone private key (base64)', Buffer.from(phone.privateKey).toString('base64')],
    ]

    for (const [what, needle] of mustNotAppear) {
      expect(json, `${what} leaked into ServerVaultRecord`).not.toContain(needle)
      // Also in the encodings a careless serializer might have reached for.
      expect(json, `${what} leaked base64-encoded`).not.toContain(b64(needle))
      expect(json, `${what} leaked hex-encoded`).not.toContain(
        Buffer.from(needle, 'utf8').toString('hex'),
      )
    }

    // Nor a field that could ever carry one.
    for (const banned of ['"dek"', '"plaintext"', '"passphrase"', '"value"', '"rootKey"', '"privateKey"']) {
      expect(json).not.toContain(banned)
    }

    // The record is exactly the contract's shape and nothing more.
    expect(Object.keys(record).sort()).toEqual([
      'deviceWrappedDeks',
      'epoch',
      'kdf',
      'passphraseWrappedDek',
      'recoveryWrappedDek',
      'secrets',
      'vaultId',
    ])
    for (const secret of record.secrets) {
      expect(Object.keys(secret).sort()).toEqual(['blob', 'epoch', 'ref', 'updatedAt'])
      expect(Object.keys(secret.blob).sort()).toEqual([
        'aad',
        'algorithm',
        'ciphertextB64',
        'ivB64',
        'tagB64',
      ])
    }

    // And it is still the real thing: a device can open it.
    const onLaptop = await h.client.unlockWithDeviceKey(await reload(h, vault.vaultId), laptop.privateKey)
    const github = record.secrets.find((s) => s.ref === 'github.token')
    if (!github) throw new Error('test bug')
    expect(await h.client.open(onLaptop, github)).toBe(values['github.token'])
  })

  it('exposes only public key material, and the same DEK never appears twice', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const unlocked = await h.client.unlockWithPassphrase(vault, PASSPHRASE)
    const device = generateDeviceKeyPair()
    await h.client.enrollDevice(unlocked, 'laptop-1', device.publicKeyB64)
    const record = toServerVaultRecord(await reload(h, vault.vaultId), [])

    // Three wraps of one DEK, each under a fresh ephemeral key: no two blobs
    // may share ciphertext, or the wrapping is not doing its job.
    const wraps = [
      record.passphraseWrappedDek,
      record.recoveryWrappedDek,
      ...record.deviceWrappedDeks.map((d) => d.sealed),
    ]
    expect(new Set(wraps.map((w) => w.ciphertextB64)).size).toBe(3)
    expect(new Set(wraps.map((w) => w.ivB64)).size).toBe(3)

    // The device's public key is in the record on purpose — it is public, and
    // it is what lets revocation re-wrap without the device being present.
    expect(record.deviceWrappedDeks[0]?.sealed.aad).toContain(device.publicKeyB64)
  })
})

// ---------------------------------------------------------------------------
// Store plumbing
// ---------------------------------------------------------------------------

describe('store', () => {
  it('reports a missing vault rather than throwing something opaque', async () => {
    const h = harness()
    const orphan: UnlockedVault = {
      vaultId: 'no-such-vault',
      epoch: 1,
      dek: new Uint8Array(32).fill(7),
    }
    await expectCode(h.client.enrollDevice(orphan, 'd', generateDeviceKeyPair().publicKeyB64), 'VAULT_NOT_FOUND')
  })

  it('hands out copies, so a caller cannot mutate stored state by accident', async () => {
    const h = harness()
    const { vault } = await h.client.create(PASSPHRASE)
    const loaded = await reload(h, vault.vaultId)
    loaded.epoch = 999
    expect((await reload(h, vault.vaultId)).epoch).toBe(1)
  })
})
